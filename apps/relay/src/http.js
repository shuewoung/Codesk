import fs from 'fs';
import path from 'path';
import { deviceFromRequest } from './ws.js';
import {
  RelayError,
  clientIp,
  parseJsonBody,
  readBearer,
  readBody,
  readHubAuth,
  safeEqual
} from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm'
};

export function createHttpHandler({ store, audit, net, config, pairLimiter }) {
  return async function handler(req, res) {
    try {
      applyCors(req, res, config);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const handled = await routeApi(req, res, url, { store, audit, net, config, pairLimiter });
      if (!handled) serveStatic(req, res, url, config);
    } catch (err) {
      sendError(res, err);
    }
  };
}

async function routeApi(req, res, url, ctx) {
  const { store, audit, net, config, pairLimiter } = ctx;
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/api/relay/health' || p === '/healthz')) {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && p === '/api/relay/pair') {
    const ip = clientIp(req);
    const body = parseJsonBody(await readBody(req, config.maxBodyBytes));
    let redeemed;
    try {
      redeemed = store.redeemPairCode(body.code);
      pairLimiter.clear(ip);
    } catch (err) {
      pairLimiter.hit(ip);
      throw err;
    }
    audit.write('pair_success', {
      hubId: redeemed.hubId,
      deviceId: redeemed.device.id,
      ip
    });
    setDeviceCookie(res, config, redeemed.deviceToken, req);
    sendJson(res, 200, {
      deviceToken: redeemed.deviceToken,
      hubId: redeemed.hubId,
      hubE2ePub: redeemed.hubE2ePub || ''
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/relay/revoke') {
    const device = deviceFromRequest(req, store, config);
    store.revokeDevice(device.id);
    net.closeDevice(device.id);
    audit.write('revoke_device', { hubId: device.hubId, deviceId: device.id, ip: clientIp(req) });
    clearDeviceCookie(res, config);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && p === '/api/relay/hubs') {
    const device = deviceFromRequest(req, store, config);
    const hub = store.getHub(device.hubId);
    sendJson(res, 200, {
      hubs: [
        {
          hubId: device.hubId,
          online: net.isHubOnline(device.hubId),
          lastSeenAt: hub?.lastSeenAt || null
        }
      ]
    });
    return true;
  }

  if (req.method === 'GET' && p === '/api/relay/devices') {
    const creds = readHubAuth(req, null);
    if (!creds) throw new RelayError('unauthorized', 'hub credentials required', 401);
    store.verifyHub(creds.hubId, creds.hubSecret);
    sendJson(res, 200, {
      devices: store.listDevices(creds.hubId).map((d) => ({
        id: d.id,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        revokedAt: d.revokedAt || null,
        online: net.isDeviceOnline ? net.isDeviceOnline(d.id) : false
      }))
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/relay/kick') {
    const body = parseJsonBody(await readBody(req, config.maxBodyBytes));
    const creds = readHubAuth(req, body);
    if (!creds) throw new RelayError('unauthorized', 'hub credentials required', 401);
    store.verifyHub(creds.hubId, creds.hubSecret);
    const deviceId = String(body.deviceId || '').trim();
    const device = store.getDevice(deviceId);
    if (!device || device.hubId !== creds.hubId) {
      throw new RelayError('not_found', 'device not found', 404);
    }
    store.revokeDevice(device.id);
    net.closeDevice(device.id);
    audit.write('kick_device', { hubId: device.hubId, deviceId: device.id, ip: clientIp(req) });
    sendJson(res, 200, { ok: true, deviceId: device.id });
    return true;
  }

  if (req.method === 'POST' && p === '/api/relay/pair-code') {
    const body = parseJsonBody(await readBody(req, config.maxBodyBytes));
    const creds = readHubAuth(req, body);
    if (!creds) throw new RelayError('unauthorized', 'hub credentials required', 401);
    store.verifyHub(creds.hubId, creds.hubSecret);
    const rec = store.createPairCode({
      hubId: creds.hubId,
      ttlSec: Math.min(3600, Number(body.ttlSec) || config.pairTtlSec),
      hubE2ePub: body.hubE2ePub || ''
    });
    sendJson(res, 200, {
      code: rec.code,
      expiresAt: rec.expiresAt,
      expiresAtMs: Date.parse(rec.expiresAt),
      hubId: rec.hubId
    });
    return true;
  }

  if (p.startsWith('/api/admin/')) {
    requireAdmin(req, config);
    const body = await bodyMaybe(req, config);
    await routeAdmin(req, res, url, body, ctx);
    return true;
  }

  if (p.startsWith('/api/')) {
    throw new RelayError('not_found', 'unknown relay endpoint', 404);
  }
  return false;
}

async function bodyMaybe(req, config) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  return parseJsonBody(await readBody(req, config.maxBodyBytes));
}

async function routeAdmin(req, res, url, body, { store, audit, net, config }) {
  const p = url.pathname;
  if (req.method === 'POST' && p === '/api/admin/invites') {
    if (store.listInvites().filter((i) => !i.revokedAt && !i.consumedAt).length >= config.maxHubs
      && store.activeHubCount() >= config.maxHubs) {
      throw new RelayError('quota_exceeded', 'hub quota exceeded', 403);
    }
    const rec = store.createInvite({
      note: body.note || '',
      ttlSec: Number(body.ttlSec) || config.inviteTtlSec
    });
    sendJson(res, 200, rec);
    return;
  }
  if (req.method === 'GET' && p === '/api/admin/invites') {
    sendJson(res, 200, { invites: store.listInvites() });
    return;
  }
  if (req.method === 'POST' && p.startsWith('/api/admin/invites/') && p.endsWith('/revoke')) {
    const code = decodeURIComponent(p.slice('/api/admin/invites/'.length, -'/revoke'.length));
    sendJson(res, 200, store.revokeInvite(code));
    return;
  }
  if (req.method === 'GET' && p === '/api/admin/hubs') {
    sendJson(res, 200, {
      hubs: store.listHubs().map((hub) => ({
        hubId: hub.hubId,
        createdAt: hub.createdAt,
        lastSeenAt: hub.lastSeenAt,
        online: net.isHubOnline(hub.hubId)
      }))
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/admin/devices') {
    const hubId = url.searchParams.get('hubId') || '';
    sendJson(res, 200, {
      devices: store.listDevices(hubId).map((d) => ({
        id: d.id,
        hubId: d.hubId,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        revokedAt: d.revokedAt
      }))
    });
    return;
  }
  if (req.method === 'POST' && p.startsWith('/api/admin/devices/') && p.endsWith('/revoke')) {
    const id = decodeURIComponent(p.slice('/api/admin/devices/'.length, -'/revoke'.length));
    const device = store.revokeDevice(id);
    net.closeDevice(id);
    audit.write('revoke_device', { hubId: device.hubId, deviceId: device.id });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && p === '/api/admin/pair-codes') {
    const rec = store.createPairCode({
      hubId: body.hubId,
      ttlSec: Number(body.ttlSec) || config.pairTtlSec
    });
    sendJson(res, 200, { code: rec.code, expiresAt: rec.expiresAt, hubId: rec.hubId });
    return;
  }
  throw new RelayError('not_found', 'unknown admin endpoint', 404);
}

function requireAdmin(req, config) {
  if (!config.adminToken) throw new RelayError('unauthorized', 'admin token not configured', 401);
  const token = readBearer(req);
  if (!token || !safeEqual(token, config.adminToken)) {
    throw new RelayError('unauthorized', 'invalid admin token', 401);
  }
}

function serveStatic(req, res, url, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { code: 'method_not_allowed', message: 'method not allowed' });
    return;
  }
  const root = path.resolve(config.webRoot);
  if (!fs.existsSync(root)) {
    sendFallback(res);
    return;
  }
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const abs = path.resolve(root, `.${path.sep}${rel.replace(/^\/+/, '')}`);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    sendJson(res, 403, { code: 'forbidden', message: 'forbidden' });
    return;
  }
  let file = abs;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const index = path.join(root, 'index.html');
    if (fs.existsSync(index) && wantsHtml(req)) {
      file = index;
    } else {
      sendJson(res, 404, { code: 'not_found', message: 'not found' });
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function sendFallback(res) {
  const body = Buffer.from('<!doctype html><meta charset="utf-8"><title>Codesk Relay</title><p>Codesk 中继在跑。进了 ICU，还要遥控 Codex。设置 RELAY_WEB_ROOT 托管 Web 构建。</p>');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

function setDeviceCookie(res, config, token, req) {
  const secure = Boolean(config.tlsCert) || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

function clearDeviceCookie(res, config) {
  res.setHeader('set-cookie', `${config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = String(u.hostname || '').replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
    if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
    const m = host.match(/^172\.(\d{1,3})(?:\.\d{1,3}){2}$/);
    if (m) {
      const n = Number(m[1]);
      return n >= 16 && n <= 31;
    }
    return false;
  } catch {
    return false;
  }
}

function applyCors(req, res, config) {
  const origin = String(req.headers.origin || '').trim();
  let allowed = '';
  if (config.corsOrigin && (config.corsOrigin === '*' || config.corsOrigin === origin)) {
    allowed = config.corsOrigin === '*' ? origin : config.corsOrigin;
  } else if (isAllowedCorsOrigin(origin)) {
    allowed = origin;
  }
  if (!allowed) return;
  res.setHeader('access-control-allow-origin', allowed);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-hub-id, x-hub-secret');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  };
  if (res.getHeader('set-cookie')) headers['set-cookie'] = res.getHeader('set-cookie');
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res, err) {
  const status = err instanceof RelayError ? err.status : 500;
  const code = err instanceof RelayError ? err.code : 'error';
  const message = err instanceof RelayError ? err.message : 'internal error';
  if (!(err instanceof RelayError)) console.error('[relay] http error', err.message);
  sendJson(res, status, { code, message });
}
