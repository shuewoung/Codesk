import { WebSocketServer } from 'ws';
import {
  clientIp,
  isNonEmptyString,
  parseCookie,
  RelayError
} from './util.js';
import {
  assertFwdPayload,
  envelope,
  errorEnvelope,
  parseEnvelope,
  readHubSecret,
  readInviteCode,
  readPairCode,
  sendJsonWs
} from './protocol.js';
import { normalizePushPayload, sendJpush } from './push.js';

export class RelayNet {
  constructor({ store, audit, config }) {
    this.store = store;
    this.audit = audit;
    this.config = config;
    this.hubSockets = new Map();
    this.deviceSockets = new Map();
    this.meta = new WeakMap();
    this.offlineTimers = new Map();
  }

  isHubOnline(hubId) {
    const rec = this.hubSockets.get(hubId);
    return Boolean(rec && rec.ws && rec.ws.readyState === 1);
  }

  isDeviceOnline(deviceId) {
    const set = this.deviceSockets.get(deviceId);
    if (!set) return false;
    for (const ws of set) {
      if (ws && ws.readyState === 1) return true;
    }
    return false;
  }

  attachHub(hubId, ws) {
    const prev = this.hubSockets.get(hubId);
    if (prev && prev.ws && prev.ws !== ws) {
      try {
        prev.ws.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    this.clearOfflineTimer(hubId);
    this.hubSockets.set(hubId, { ws, lastPong: Date.now() });
    this.meta.set(ws, { kind: 'hub', hubId, lastPong: Date.now() });
  }

  detachHub(hubId, ws) {
    const rec = this.hubSockets.get(hubId);
    if (!rec || rec.ws !== ws) return;
    this.hubSockets.delete(hubId);
    this.scheduleHubOffline(hubId);
  }

  attachDevice(deviceId, hubId, ws) {
    let set = this.deviceSockets.get(deviceId);
    if (!set) {
      set = new Set();
      this.deviceSockets.set(deviceId, set);
    }
    set.add(ws);
    this.meta.set(ws, { kind: 'device', deviceId, hubId, lastPong: Date.now() });
  }

  detachWs(ws) {
    const meta = this.meta.get(ws);
    if (!meta) return;
    if (meta.kind === 'hub') this.detachHub(meta.hubId, ws);
    if (meta.kind === 'device') {
      const set = this.deviceSockets.get(meta.deviceId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.deviceSockets.delete(meta.deviceId);
      }
    }
    this.meta.delete(ws);
  }

  closeDevice(deviceId, code = 4403, reason = 'revoked') {
    const set = this.deviceSockets.get(deviceId);
    if (!set) return;
    for (const ws of set) {
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    this.deviceSockets.delete(deviceId);
  }

  sendToHub(hubId, msg) {
    const rec = this.hubSockets.get(hubId);
    if (!rec) return false;
    return sendJsonWs(rec.ws, msg);
  }

  sendToDevices(hubId, msg) {
    let n = 0;
    for (const [deviceId, set] of this.deviceSockets) {
      const sample = set.values().next().value;
      const meta = sample ? this.meta.get(sample) : null;
      if (!meta || meta.hubId !== hubId) continue;
      for (const ws of set) {
        if (sendJsonWs(ws, msg)) n += 1;
      }
    }
    return n;
  }

  scheduleHubOffline(hubId) {
    this.clearOfflineTimer(hubId);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(hubId);
      if (this.isHubOnline(hubId)) return;
      this.sendToDevices(hubId, envelope({ type: 'hub_offline', hubId, payload: {} }));
    }, this.config.hubOfflineDelayMs);
    this.offlineTimers.set(hubId, timer);
  }

  clearOfflineTimer(hubId) {
    const timer = this.offlineTimers.get(hubId);
    if (timer) {
      clearTimeout(timer);
      this.offlineTimers.delete(hubId);
    }
  }

  touch(ws) {
    const meta = this.meta.get(ws);
    if (meta) meta.lastPong = Date.now();
    const rec = meta?.kind === 'hub' ? this.hubSockets.get(meta.hubId) : null;
    if (rec && rec.ws === ws) rec.lastPong = Date.now();
  }
}

export function attachWs(server, { store, audit, net, config, pairLimiter, pushLimiter }) {
  const wss = new WebSocketServer({
    server,
    maxPayload: config.maxWsBytes,
    perMessageDeflate: false
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const headerToken = readUpgradeToken(req, config);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
      net.touch(ws);
    });

    if (headerToken) {
      try {
        bindDevice(ws, store.requireDevice(headerToken), ip);
      } catch (err) {
        rejectWs(ws, err);
        return;
      }
    }

    ws.on('message', async (data) => {
      try {
        await handleMessage(ws, data);
      } catch (err) {
        rejectWs(ws, err, false);
      }
    });

    ws.on('close', () => {
      const meta = net.meta.get(ws);
      net.detachWs(ws);
      if (meta?.kind === 'hub') {
        audit.write('disconnected_hub', { hubId: meta.hubId, ip });
      } else if (meta?.kind === 'device') {
        audit.write('disconnected_device', { hubId: meta.hubId, deviceId: meta.deviceId, ip });
      }
    });

    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });

    async function handleMessage(socket, data) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const msg = parseEnvelope(text);
      net.touch(socket);
      const meta = net.meta.get(socket);

      if (msg.type === 'ping') {
        sendJsonWs(socket, envelope({ type: 'pong', hubId: meta?.hubId || msg.hubId, payload: {} }));
        return;
      }
      if (msg.type === 'pong') return;

      if (msg.type === 'register_hub') {
        const hubId = msg.hubId;
        const hubSecret = readHubSecret(msg);
        const inviteCode = readInviteCode(msg);
        const hub = store.registerHub({
          hubId,
          hubSecret,
          inviteCode,
          maxHubs: config.maxHubs,
          hubE2ePub: msg.payload?.hubE2ePub || ''
        });
        net.attachHub(hub.hubId, socket);
        audit.write('connected_hub', { hubId: hub.hubId, ip });
        sendJsonWs(socket, envelope({ type: 'register_hub', hubId: hub.hubId, payload: { ok: true } }));
        return;
      }

      if (msg.type === 'request_pair_code') {
        if (!meta || meta.kind !== 'hub') {
          throw new RelayError('unauthorized', 'hub registration required', 401);
        }
        const rec = store.createPairCode({
          hubId: meta.hubId,
          ttlSec: config.pairTtlSec,
          hubE2ePub: msg.payload?.hubE2ePub || ''
        });
        sendJsonWs(socket, envelope({
          type: 'pair_code',
          hubId: meta.hubId,
          payload: {
            code: rec.code,
            expiresAtMs: Date.parse(rec.expiresAt)
          }
        }));
        return;
      }

      if (msg.type === 'pair') {
        let redeemed;
        try {
          redeemed = store.redeemPairCode(readPairCode(msg));
          pairLimiter.clear(ip);
        } catch (err) {
          pairLimiter.hit(ip);
          throw err;
        }
        bindDevice(socket, redeemed.device, ip);
        audit.write('pair_success', { hubId: redeemed.hubId, deviceId: redeemed.device.id, ip });
        sendJsonWs(socket, envelope({
          type: 'pair',
          hubId: redeemed.hubId,
          payload: { deviceToken: redeemed.deviceToken, hubId: redeemed.hubId, hubE2ePub: redeemed.hubE2ePub || '' }
        }));
        return;
      }

      if (msg.type === 'fwd') {
        if (!meta) throw new RelayError('unpaired', 'device token required', 401);
        assertFwdPayload(msg.payload, msg.enc);
        if (meta.kind === 'device') {
          if (msg.hubId && msg.hubId !== meta.hubId) {
            throw new RelayError('hub_mismatch', 'hubId does not match this device', 403);
          }
          if (!net.isHubOnline(meta.hubId)) {
            sendJsonWs(socket, envelope({ type: 'hub_offline', hubId: meta.hubId, payload: {} }));
            return;
          }
          const bytes = Buffer.byteLength(text);
          const out = { v: 1, type: 'fwd', hubId: meta.hubId };
          if (msg.enc) out.enc = msg.enc;
          else out.payload = msg.payload;
          if (msg.deviceId) out.deviceId = msg.deviceId;
          net.sendToHub(meta.hubId, out);
          console.log(`[relay] fwd phone→hub hubId=${shortId(meta.hubId)} bytes=${bytes}`);
          return;
        }
        if (meta.kind === 'hub') {
          const bytes = Buffer.byteLength(text);
          const out = { v: 1, type: 'fwd', hubId: meta.hubId };
          if (msg.enc) out.enc = msg.enc;
          else out.payload = msg.payload;
          net.sendToDevices(meta.hubId, out);
          console.log(`[relay] fwd hub→phone hubId=${shortId(meta.hubId)} bytes=${bytes}`);
          return;
        }
      }

      if (msg.type === 'push_register') {
        if (!meta || meta.kind !== 'hub') {
          throw new RelayError('unauthorized', 'hub registration required', 401);
        }
        const registrationId = msg.payload?.registrationId || msg.payload?.registrationID || '';
        store.bindPushDevice(meta.hubId, registrationId);
        audit.write('push_register', { hubId: meta.hubId, ip });
        sendJsonWs(socket, envelope({ type: 'push_register', hubId: meta.hubId, payload: { ok: true } }));
        return;
      }

      if (msg.type === 'push_send') {
        if (!meta || meta.kind !== 'hub') {
          throw new RelayError('unauthorized', 'hub registration required', 401);
        }
        if (pushLimiter) pushLimiter.hit(meta.hubId);
        const payload = normalizePushPayload(msg.payload);
        const ids = store.listPushIds(meta.hubId);
        const result = await sendJpush({
          appKey: config.jpushAppKey,
          masterSecret: config.jpushMasterSecret,
          registrationIds: ids,
          title: payload.title,
          body: payload.body,
          tag: payload.tag,
          url: payload.url,
          threadId: payload.threadId,
          fetchImpl: config.jpushFetch
        });
        audit.write('push_send', { hubId: meta.hubId, n: result.n || 0, ok: result.ok, ip });
        sendJsonWs(socket, envelope({
          type: 'push_send',
          hubId: meta.hubId,
          payload: { ok: result.ok, n: result.n || 0, code: result.code || '' }
        }));
        return;
      }

      if (msg.type === 'e2e_hello' || msg.type === 'e2e_welcome') {
        if (!meta) throw new RelayError('unpaired', 'device token required', 401);
        const out = {
          v: 1,
          type: msg.type,
          hubId: meta.hubId,
          payload: msg.payload || {}
        };
        if (meta.kind === 'device') {
          if (!net.isHubOnline(meta.hubId)) {
            sendJsonWs(socket, envelope({ type: 'hub_offline', hubId: meta.hubId, payload: {} }));
            return;
          }
          net.sendToHub(meta.hubId, out);
          console.log(`[relay] ${msg.type} phone→hub hubId=${shortId(meta.hubId)}`);
          return;
        }
        if (meta.kind === 'hub') {
          net.sendToDevices(meta.hubId, out);
          console.log(`[relay] ${msg.type} hub→phone hubId=${shortId(meta.hubId)}`);
          return;
        }
      }

      throw new RelayError('bad_envelope', 'unsupported message for this connection');
    }

    function bindDevice(socket, device, deviceIp) {
      store.touchDevice(device.id);
      net.attachDevice(device.id, device.hubId, socket);
      audit.write('connected_device', { hubId: device.hubId, deviceId: device.id, ip: deviceIp });
    }

  });

  const heartbeat = setInterval(() => {
    const expireBefore = Date.now() - config.pingTimeoutMs;
    for (const ws of wss.clients) {
      const meta = net.meta.get(ws);
      const last = meta?.lastPong || 0;
      if (last && last < expireBefore) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, config.pingIntervalMs);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

function readUpgradeToken(req, config) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(\S+)/i);
  if (match) return match[1];
  const url = new URL(req.url || '/', 'http://localhost');
  const queryToken = url.searchParams.get('token') || url.searchParams.get('access_token');
  if (queryToken) return queryToken;
  return parseCookie(req.headers.cookie || '', config.cookieName);
}

function rejectWs(ws, err, close = true) {
  const code = err instanceof RelayError ? err.code : 'error';
  const message = err instanceof RelayError ? err.message : 'internal error';
  sendJsonWs(ws, errorEnvelope(code, message));
  if (close && (code === 'unauthorized' || code === 'revoked' || code === 'invite_invalid' || code === 'invite_required')) {
    const wsCode = code === 'revoked' ? 4403 : 4401;
    try {
      ws.close(wsCode, code);
    } catch {
      /* ignore */
    }
  }
}

function shortId(hubId) {
  return isNonEmptyString(hubId) ? hubId.slice(0, 8) : '-';
}

export function deviceFromRequest(req, store, config) {
  const token = readUpgradeToken(req, config);
  if (!token) throw new RelayError('unauthorized', 'device token required', 401);
  return store.requireDevice(token);
}
