import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COOKIE_NAME = 'onedesk_session';
// Browser cookie retention only; device tokens have no server-side expiry.
export const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;

const PUBLIC = new Map([
  ['GET /api/auth/status', true],
  ['GET /api/discover', true],
  ['POST /api/auth/login', true],
  ['POST /api/auth/logout', true],
]);

export function isPublicApi(pathname, method) {
  return PUBLIC.has(`${String(method || 'GET').toUpperCase()} ${pathname}`);
}

export function isLocalNetworkHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
  const m172 = h.match(/^172\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  if (m172) {
    const n = Number(m172[1]);
    if (n >= 16 && n <= 31) return true;
  }
  const m100 = h.match(/^100\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  if (m100) {
    const n = Number(m100[1]);
    if (n >= 64 && n <= 127) return true;
  }
  return false;
}

export function isAllowedCorsOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isLocalNetworkHost(u.hostname);
  } catch {
    return false;
  }
}

export function corsHeaders(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!isAllowedCorsOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(value); } catch { return null; }
    }
  }
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function safeEqualString(a, b) {
  const left = sha256(a);
  const right = sha256(b);
  return crypto.timingSafeEqual(left, right);
}

function readPasswordFile(file) {
  if (!file || !fs.existsSync(file)) return '';
  return String(fs.readFileSync(file, 'utf-8')).replace(/^\uFEFF/, '').trim();
}

export function resolvePassword({ dataDir, env = process.env } = {}) {
  const fromEnv = String(env.CODESK_PASSWORD || env.ONEDESK_PASSWORD || env.HUB_PASSWORD || '').trim();
  if (fromEnv) return { password: fromEnv, file: null, generated: false };
  const customFile = String(env.CODESK_PASSWORD_FILE || env.ONEDESK_PASSWORD_FILE || env.HUB_TOKEN_FILE || '').trim();
  if (customFile) {
    const password = readPasswordFile(customFile);
    return { password, file: customFile, generated: false };
  }
  const file = path.join(dataDir, 'password');
  const existing = readPasswordFile(file);
  if (existing) return { password: existing, file, generated: false };
  const password = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${password}\n`, { encoding: 'utf-8', mode: 0o600 });
  return { password, file, generated: true };
}

function cookieHeader(token, { maxAgeSec, secure = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function isLoopbackAddress(addr) {
  const ip = String(addr || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const FORWARDED_HEADER_NAMES = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-access-jwt-assertion',
  'cf-access-authenticated-user-email',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'true-client-ip',
];

export function isForwardedRequest(req) {
  const headers = req?.headers || {};
  for (const name of FORWARDED_HEADER_NAMES) {
    const value = headers[name];
    if (value != null && String(value).trim()) return true;
  }
  return false;
}

export const TRUSTED_LOCAL_ORIGIN_PORTS = [18990, 18991];

export function isTrustedLocalReq(req, port = 18990) {
  if (isForwardedRequest(req)) return false;
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = String(u.hostname || '').replace(/^\[|\]$/g, '');
    if (!isLocalNetworkHost(host)) return false;
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (String(p) === String(port)) return true;
    return TRUSTED_LOCAL_ORIGIN_PORTS.includes(Number(p));
  } catch {
    return false;
  }
}

// Fixed-window, bounded in-memory limiter. Only trust the transport peer address;
// forwarded headers are attacker-controlled unless a separate proxy policy exists.
export function createLoginLimiter({ now = () => Date.now(), maxAttempts = 10, windowMs = 60_000, maxKeys = 4096 } = {}) {
  for (const value of [maxAttempts, windowMs, maxKeys]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid login limiter configuration');
  }
  const entries = new Map();
  return {
    consume(req) {
      const time = now();
      for (const [key, row] of entries) if (row.until <= time) entries.delete(key);
      const key = String(req?.socket?.remoteAddress || 'unknown').replace(/^::ffff:/i, '');
      let row = entries.get(key);
      const denied = (until) => ({ ok: false, status: 429, code: 'rate_limited', retryAfterSec: Math.max(1, Math.ceil((until - time) / 1000)) });
      if (!row) {
        // Do not evict active buckets: cycling identities must not reset limits.
        if (entries.size >= maxKeys) return denied(Math.min(...[...entries.values()].map((entry) => entry.until)));
        row = { count: 0, until: time + windowMs };
        entries.set(key, row);
      }
      if (row.count >= maxAttempts) return denied(row.until);
      row.count++;
      return { ok: true };
    },
  };
}

export function createAuth({ dataDir, env = process.env, now = () => Date.now(), port = 18990, loginLimiter = createLoginLimiter({ now }) } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const resolved = resolvePassword({ dataDir, env });
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const sessions = new Map();
  const sockets = new Map();

  function persist() {
    const list = [];
    for (const [token, row] of sessions) {
      list.push({ token, ...row });
    }
    try {
      fs.writeFileSync(sessionsFile, `${JSON.stringify(list)}\n`, { encoding: 'utf-8', mode: 0o600 });
    } catch {
    }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    if (Array.isArray(raw)) {
      for (const row of raw) {
        if (row && row.token && (row.expiresAt === null || row.expiresAt > now())) {
          sessions.set(row.token, { id: row.id || crypto.randomUUID(), expiresAt: null });
        }
      }
    }
  } catch {
  }

  persist(); // Migrate still-valid legacy sessions without reviving expired credentials.

  function isSecureRequest(req) {
    if (req?.socket?.encrypted) return true;
    return String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function validSession(token) {
    if (!token) return false;
    const row = sessions.get(token);
    if (!row) return false;
    if (row.expiresAt !== null && row.expiresAt <= now()) {
      sessions.delete(token);
      persist();
      return false;
    }
    return true;
  }

  function readQueryToken(req) {
    try {
      const url = new URL(String(req?.url || '/'), `http://${req?.headers?.host || '127.0.0.1'}`);
      return String(url.searchParams.get('token') || '').trim();
    } catch {
      return '';
    }
  }

  function readPresentedSecret(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    if (cookies === null) return { cookie: '', bearer: '', invalid: true };
    const authz = String(req?.headers?.authorization || '');
    const bearer = authz.replace(/^Bearer\s+/i, '').trim();
    return {
      cookie: cookies[COOKIE_NAME] || '',
      bearer: bearer || readQueryToken(req),
    };
  }

  function authorize(req) {
    if (isTrustedLocalReq(req, port)) return true;
    if (!resolved.password) return false;
    const presented = readPresentedSecret(req);
    if (presented.invalid) return false;
    if (validSession(presented.cookie) || validSession(presented.bearer)) return true;
    if (presented.bearer && safeEqualString(presented.bearer, resolved.password)) return true;
    return false;
  }

  function login(plain, req, extras = []) {
    const limit = loginLimiter.consume(req);
    if (!limit.ok) return limit;
    const password = String(plain || '').trim();
    if (!password) {
      return { ok: false };
    }
    const candidates = [resolved.password, ...extras].map((v) => String(v || '').trim()).filter(Boolean);
    const ok = candidates.some((item) => (
      safeEqualString(password, item) || safeEqualString(password.toUpperCase(), item.toUpperCase())
    ));
    if (!ok) {
      return { ok: false };
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { id: crypto.randomUUID(), expiresAt: null });
    persist();
    return {
      ok: true,
      token,
      headers: {
        'Set-Cookie': cookieHeader(token, {
          maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
          secure: isSecureRequest(req),
        }),
      },
    };
  }

  function logout(req) {
    const presented = readPresentedSecret(req);
    revokeToken(presented.cookie);
    revokeToken(presented.bearer);
    persist();
    return {
      'Set-Cookie': cookieHeader('', { maxAgeSec: 0, secure: isSecureRequest(req) }),
    };
  }

  function revokeToken(token) {
    if (!token) return;
    sessions.delete(token);
    for (const ws of sockets.get(token) || []) {
      ws.revoked = true;
      try { ws.close(4403, 'revoked'); } catch { /* continue revoking other sockets */ }
    }
    sockets.delete(token);
    persist();
  }

  function sessionToken(req) {
    const presented = readPresentedSecret(req);
    return [presented.cookie, presented.bearer].find((token) => validSession(token)) || '';
  }

  function trackSocket(req, ws) {
    const token = sessionToken(req);
    if (!token) return '';
    const set = sockets.get(token) || new Set();
    set.add(ws);
    sockets.set(token, set);
    ws.on('close', () => { set.delete(ws); if (!set.size) sockets.delete(token); });
    return sessions.get(token).id;
  }

  return {
    trackSocket,
    listDevices: () => [...sessions].map(([token, row]) => ({ id: row.id, kind: 'lan', online: Boolean(sockets.get(token)?.size) })),
    revokeDevice(id) {
      for (const [token, row] of sessions) {
        if (row.id === id) { revokeToken(token); return true; }
      }
      return false;
    },
    authorize,
    login,
    logout,
    configured: Boolean(resolved.password),
    generated: resolved.generated,
    passwordFile: resolved.file,
    generatedPassword: resolved.generated ? resolved.password : null,
    hostPassword: resolved.password,
  };
}
