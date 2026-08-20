import crypto from 'crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RelayError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
  }
}

export function nowMs() {
  return Date.now();
}

export function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function randomBytesUrl(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

export function randomToken() {
  return `odt_${randomBytesUrl(32)}`;
}

export function randomDeviceId() {
  return `dev_${randomBytesUrl(16)}`;
}

export function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function randomInviteCode() {
  return `OD-${randomCode(4)}-${randomCode(4)}`;
}

export function randomPairCode() {
  return randomCode(6);
}

export function normalizeCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

export function normalizeInviteCode(value) {
  const compact = normalizeCode(value);
  if (/^OD[A-Z0-9]{8}$/.test(compact)) {
    return `OD-${compact.slice(2, 6)}-${compact.slice(6, 10)}`;
  }
  return String(value || '').trim().toUpperCase();
}

export function normalizePairCode(value) {
  return normalizeCode(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return req.socket?.remoteAddress || '';
}

export function readBearer(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(\S+)/i);
  if (match) return match[1];
  return '';
}

export function readHubAuth(req, body = null) {
  const header = String(req.headers.authorization || '');
  const hubMatch = header.match(/^Hub\s+(\S+):(\S+)/i);
  if (hubMatch) {
    return { hubId: hubMatch[1], hubSecret: hubMatch[2] };
  }
  const hubId = String(req.headers['x-hub-id'] || body?.hubId || '').trim();
  const hubSecret = String(req.headers['x-hub-secret'] || body?.hubSecret || '').trim();
  if (hubId && hubSecret) return { hubId, hubSecret };
  return null;
}

export function parseCookie(header, name) {
  if (!header) return '';
  const parts = String(header).split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new RelayError('payload_too_large', 'request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export function parseJsonBody(buf) {
  if (!buf || buf.length === 0) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return asObject(parsed) || {};
  } catch {
    throw new RelayError('bad_json', 'invalid JSON body', 400);
  }
}

export class RateLimiter {
  constructor(limit, windowMs, message = 'too many pairing attempts') {
    this.limit = limit;
    this.windowMs = windowMs;
    this.message = message;
    this.map = new Map();
  }

  hit(key) {
    const now = Date.now();
    const rec = this.map.get(key) || { n: 0, resetAt: now + this.windowMs };
    if (now > rec.resetAt) {
      rec.n = 0;
      rec.resetAt = now + this.windowMs;
    }
    rec.n += 1;
    this.map.set(key, rec);
    if (rec.n > this.limit) {
      throw new RelayError('rate_limited', this.message, 429);
    }
  }

  clear(key) {
    this.map.delete(key);
  }
}
