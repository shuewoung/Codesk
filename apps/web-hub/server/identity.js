import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateKeyPair, generateSecret } from './e2e.js';

function firstEnv(env, ...keys) {
  for (const key of keys) {
    const value = String(env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

export function defaultDataDir(env = process.env) {
  const custom = firstEnv(env, 'CODESK_DATA_DIR', 'ONEDESK_DATA_DIR');
  if (custom) return custom;
  if (env.LOCALAPPDATA) {
    const next = path.join(env.LOCALAPPDATA, 'Codesk');
    const legacy = path.join(env.LOCALAPPDATA, 'OneDesk');
    if (fs.existsSync(legacy) && !fs.existsSync(next)) return legacy;
    return next;
  }
  const next = path.join(os.homedir(), '.codesk');
  const legacy = path.join(os.homedir(), '.onedesk');
  if (fs.existsSync(legacy) && !fs.existsSync(next)) return legacy;
  return next;
}

function withE2e(raw) {
  const next = { ...raw };
  if (!next.e2e || !next.e2e.publicKey || !next.e2e.secretKey) {
    next.e2e = generateKeyPair();
  }
  if (!next.contentKey) next.contentKey = generateSecret();
  if (!next.keyId) next.keyId = crypto.randomUUID();
  return next;
}

function persistIdentity(file, identity) {
  fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

function toPublicIdentity(identity, file) {
  return {
    hubId: identity.hubId,
    hubSecret: identity.hubSecret,
    file,
    e2ePub: identity.e2e.publicKey,
    e2ePriv: identity.e2e.secretKey,
    contentKey: identity.contentKey,
    keyId: identity.keyId,
    rotateContentKey() {
      identity.contentKey = generateSecret();
      identity.keyId = crypto.randomUUID();
      persistIdentity(file, identity);
      this.contentKey = identity.contentKey;
      this.keyId = identity.keyId;
      return { contentKey: this.contentKey, keyId: this.keyId };
    },
  };
}

export function loadOrCreateIdentity(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'identity.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (raw && typeof raw.hubId === 'string' && raw.hubId && typeof raw.hubSecret === 'string' && raw.hubSecret) {
      const identity = withE2e(raw);
      if (!raw.e2e || !raw.contentKey || !raw.keyId) persistIdentity(file, identity);
      return toPublicIdentity(identity, file);
    }
  } catch {
  }
  const identity = withE2e({
    hubId: crypto.randomUUID(),
    hubSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  });
  persistIdentity(file, identity);
  return toPublicIdentity(identity, file);
}

export const DEFAULT_RELAY_URL = 'https://hub.codesk.icu:8787';

function resolveRelayUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return DEFAULT_RELAY_URL;
  return url
    .replace(/^http:\/\/hub\.codesk\.icu(?::8787)?/i, 'https://hub.codesk.icu:8787')
    .replace(/^http:\/\/121\.4\.61\.68(?::8787)?/i, 'https://hub.codesk.icu:8787');
}

export function loadRelayConfig(dataDir, env = process.env) {
  let saved = {};
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'relay.json'), 'utf-8').replace(/^\uFEFF/, '');
    saved = JSON.parse(raw);
  } catch {
    saved = {};
  }
  return {
    url: resolveRelayUrl(firstEnv(env, 'CODESK_RELAY_URL', 'ONEDESK_RELAY_URL') || saved.url || ''),
    invite: firstEnv(env, 'CODESK_RELAY_INVITE', 'ONEDESK_RELAY_INVITE') || saved.invite || '',
  };
}

export function saveRelayConfig(dataDir, { url, invite }) {
  const file = path.join(dataDir, 'relay.json');
  const next = { url: url || '', invite: invite || '' };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return next;
}
