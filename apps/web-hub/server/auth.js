import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COOKIE_NAME = 'onedesk_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PUBLIC = new Map([
  ['GET /api/auth/status', true],
  ['GET /api/discover', true],
  ['POST /api/auth/login', true],
  ['POST /api/auth/logout', true],
]);

export function isPublicApi(pathname, method) {
  return PUBLIC.has(`${String(method || 'GET').toUpperCase()} ${pathname}`);
}

export function isAllowedCorsOrigin(origin) {
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
    if (key) out[key] = decodeURIComponent(value);
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

export function isTrustedLocalReq(req, port = 18990) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = String(u.hostname || '').replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    return String(p) === String(port);
  } catch {
    return false;
  }
}

export function createAuth({ dataDir, env = process.env, now = () => Date.now(), port = 18990 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const resolved = resolvePassword({ dataDir, env });
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const sessions = new Map();

  function persist() {
    const list = [];
    for (const [token, row] of sessions) {
      if (row.expiresAt > now()) list.push({ token, expiresAt: row.expiresAt });
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
        if (row && row.token && row.expiresAt > now()) sessions.set(row.token, { expiresAt: row.expiresAt });
      }
    }
  } catch {
  }

  function isSecureRequest(req) {
    if (req?.socket?.encrypted) return true;
    return String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function validSession(token) {
    if (!token) return false;
    const row = sessions.get(token);
    if (!row) return false;
    if (row.expiresAt <= now()) {
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
    if (validSession(presented.cookie) || validSession(presented.bearer)) return true;
    if (presented.bearer && safeEqualString(presented.bearer, resolved.password)) return true;
    return false;
  }

  function login(plain, req, extras = []) {
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
    sessions.set(token, { expiresAt: now() + SESSION_TTL_MS });
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
    if (presented.cookie) sessions.delete(presented.cookie);
    if (presented.bearer) sessions.delete(presented.bearer);
    persist();
    return {
      'Set-Cookie': cookieHeader('', { maxAgeSec: 0, secure: isSecureRequest(req) }),
    };
  }

  return {
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
