import WebSocket from 'ws';
import { anonymousBox, anonymousOpen, secretOpen, secretSeal } from './e2e.js';

const FORBIDDEN = /auth\.json|access_token|refresh_token|id_token/i;

export function envelopeHasSecrets(value) {
  try {
    return FORBIDDEN.test(JSON.stringify(value));
  } catch {
    return true;
  }
}

export function toRelayWsUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('https://')) return `wss://${text.slice('https://'.length)}`;
  if (text.startsWith('http://')) return `ws://${text.slice('http://'.length)}`;
  return text;
}

export function toRelayHttpUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('wss://')) return `https://${text.slice('wss://'.length)}`.replace(/\/$/, '');
  if (text.startsWith('ws://')) return `http://${text.slice('ws://'.length)}`.replace(/\/$/, '');
  if (text.startsWith('http://') || text.startsWith('https://')) return text.replace(/\/$/, '');
  return '';
}

export function pairLandingUrl(relayUrl, code, hubE2ePub = '', lanUrl = '') {
  const base = toRelayHttpUrl(relayUrl);
  if (!base || !code) return '';
  const url = new URL(`${base}/`);
  url.searchParams.set('pair', code);
  if (hubE2ePub) url.searchParams.set('hk', hubE2ePub);
  if (lanUrl) url.searchParams.set('lan', lanUrl);
  return url.toString();
}

export function createRelayClient({
  url,
  identity,
  inviteCode = '',
  onFwd,
  onPairCode,
  onState,
  WebSocketImpl = WebSocket,
} = {}) {
  const wsUrl = toRelayWsUrl(url);
  const httpUrl = toRelayHttpUrl(url);
  const invite = String(inviteCode || '').trim();
  let socket = null;
  let closed = false;
  let online = false;
  let pairCode = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let backoffMs = 1000;
  let pairWaiter = null;

  function state() {
    return {
      configured: Boolean(wsUrl),
      online,
      url: wsUrl || null,
      pairCode: pairCode?.code || null,
      pairExpiresAtMs: pairCode?.expiresAtMs || null,
    };
  }

  function emitState() {
    onState?.(state());
  }

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    reconnectTimer = null;
    pingTimer = null;
  }

  function sendRaw(msg) {
    if (envelopeHasSecrets(msg)) {
      throw new Error('refusing to send credential-like payload to relay');
    }
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  function pack(type, payload = {}, extra = {}) {
    return {
      v: 1,
      type,
      hubId: identity.hubId,
      payload,
      ...extra,
    };
  }

  function handleMessage(raw) {
    try {
      handleMessageInner(raw);
    } catch (err) {
      console.warn(`[relay] handle failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  function handleMessageInner(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.hubId && msg.hubId !== identity.hubId) return;
    if (msg.type === 'ping') {
      sendRaw(pack('pong'));
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type === 'pair_code') {
      pairCode = {
        code: msg.payload?.code || null,
        expiresAtMs: msg.payload?.expiresAtMs || null,
      };
      if (pairWaiter) {
        pairWaiter.resolve(pairCode);
        pairWaiter = null;
      }
      onPairCode?.(pairCode);
      emitState();
      return;
    }
    if (msg.deviceId != null && (typeof msg.deviceId !== 'string' || !msg.deviceId.trim())) return;
    const target = msg.deviceId ? { deviceId: msg.deviceId } : {};
    const replyError = (code, message) => sendRaw(pack('error', { code, message }, target));
    if (msg.type === 'e2e_hello') {
      try {
        const payload = msg.payload;
        // Legacy clients without hk send only devicePub. Preserve that path, but
        // never downgrade a failed/partial encrypted hello to its cleartext hint.
        const hasBox = payload && ['ct', 'n', 'ephPub'].some((key) => Object.hasOwn(payload, key));
        const hello = hasBox ? anonymousOpen(payload, identity.e2ePriv) : payload;
        const devicePub = hello?.devicePub;
        if (typeof devicePub !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(devicePub)) {
          throw new Error('invalid device public key');
        }
        const welcome = anonymousBox(
          { contentKey: identity.contentKey, keyId: identity.keyId, hubPub: identity.e2ePub },
          devicePub,
        );
        sendRaw(pack('e2e_welcome', welcome, target));
        console.log('[relay] e2e_welcome sent');
      } catch (err) {
        console.warn(`[relay] e2e_welcome failed: ${err instanceof Error ? err.message : err}`);
        replyError('e2e_hello_bad', 'e2e handshake failed');
      }
      return;
    }
    if (msg.type === 'fwd') {
      if (msg.enc) {
        let app;
        try { app = secretOpen(msg.enc, identity.contentKey); } catch { /* invalid box */ }
        if (!app || typeof app !== 'object' || Array.isArray(app)) {
          replyError('e2e_required', 'please pair again');
          return;
        }
        if ((app.type === 'download_file' || app.type === 'cancel_download') && !msg.deviceId) {
          replyError('device_required', 'download requires authenticated device identity');
          return;
        }
        onFwd?.({ ...msg, payload: app });
        return;
      }
      replyError('e2e_required', 'please pair again');
      return;
    }
    if (msg.type === 'error') {
      console.warn(`[relay] error ${msg.payload?.code || ''}: ${msg.payload?.message || 'unknown'}`);
    }
  }

  function armPing() {
    pingTimer = setInterval(() => {
      sendRaw(pack('ping', { t: Date.now() }));
    }, 25000);
    pingTimer.unref?.();
  }

  function scheduleReconnect() {
    if (closed || !wsUrl) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs);
    reconnectTimer.unref?.();
    backoffMs = Math.min(backoffMs * 2, 30000);
  }

  function connect() {
    if (closed || !wsUrl) return;
    try {
      socket = new WebSocketImpl(wsUrl);
    } catch (err) {
      console.warn(`[relay] connect failed: ${err.message}`);
      scheduleReconnect();
      return;
    }
    socket.on('open', () => {
      online = true;
      backoffMs = 1000;
      emitState();
      try {
        const payload = { hubSecret: identity.hubSecret, hubE2ePub: identity.e2ePub || '' };
        if (invite) payload.inviteCode = invite;
        sendRaw(pack('register_hub', payload));
      } catch (err) {
        console.warn(`[relay] register blocked: ${err.message}`);
      }
      armPing();
    });
    socket.on('message', handleMessage);
    socket.on('close', () => {
      online = false;
      socket = null;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      emitState();
      scheduleReconnect();
    });
    socket.on('error', () => {
    });
  }

  return {
    start() {
      closed = false;
      if (!wsUrl) {
        emitState();
        return;
      }
      connect();
    },
    stop() {
      closed = true;
      clearTimers();
      online = false;
      try { socket?.close(); } catch { /* ignore */ }
      socket = null;
      emitState();
    },
    getState: state,
    getPairCode() {
      return pairCode;
    },
    publicUrl() {
      return httpUrl || null;
    },
    requestPairCode(timeoutMs = 8000, refresh = false) {
      if (!wsUrl || !online) return Promise.resolve({ code: null, expiresAtMs: null, relayOnline: false });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pairWaiter) pairWaiter = null;
          resolve({ code: null, expiresAtMs: null, relayOnline: online });
        }, timeoutMs);
        pairWaiter = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve({ ...value, relayOnline: online });
          },
        };
        if (!sendRaw(pack('request_pair_code', { hubE2ePub: identity.e2ePub || '', refresh }))) {
          clearTimeout(timer);
          pairWaiter = null;
          resolve({ code: null, expiresAtMs: null, relayOnline: false });
        }
      });
    },
    forwardApp(appMsg, { deviceId = null } = {}) {
      if (!appMsg || appMsg.type === 'ping') return false;
      if (deviceId != null && (typeof deviceId !== 'string' || !deviceId.trim())) return false;
      if (String(appMsg.type || '').startsWith('download_') && !deviceId) return false;
      if (envelopeHasSecrets(appMsg)) {
        throw new Error('refusing to send credential-like payload to relay');
      }
      const extra = {};
      if (deviceId) extra.deviceId = deviceId;
      extra.enc = secretSeal(appMsg, identity.contentKey, identity.keyId);
      return sendRaw(pack('fwd', undefined, extra));
    },
    async listDevices() {
      return relayHubRequest(httpUrl, identity, 'GET', '/api/relay/devices');
    },
    async kickDevice(deviceId) {
      const result = await relayHubRequest(httpUrl, identity, 'POST', '/api/relay/kick', { deviceId });
      identity.rotateContentKey?.();
      return result;
    },
    sendPushRegister(registrationId) {
      const id = String(registrationId || '').trim();
      if (!id) return false;
      return sendRaw(pack('push_register', { registrationId: id }));
    },
    sendPush(payload = {}) {
      return sendRaw(pack('push_send', {
        title: payload.title || 'Codesk',
        body: payload.body || '',
        tag: payload.tag || payload.url || '',
        url: payload.url || '',
        threadId: payload.threadId || '',
      }));
    },
  };
}

async function relayHubRequest(httpUrl, identity, method, pathname, body) {
  if (!httpUrl || !identity?.hubId || !identity?.hubSecret) {
    throw new Error('relay not configured');
  }
  const res = await fetch(`${httpUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Hub ${identity.hubId}:${identity.hubSecret}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || json.error || `${method} ${pathname} ${res.status}`);
  }
  return json;
}
