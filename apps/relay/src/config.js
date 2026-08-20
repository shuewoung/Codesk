import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RELAY_ROOT = path.resolve(SRC_DIR, '..');

function defaultWebRoot() {
  const sibling = path.resolve(RELAY_ROOT, '..', 'web-hub', 'public');
  if (fs.existsSync(sibling)) return sibling;
  return path.join(RELAY_ROOT, 'public');
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env, overrides = {}) {
  const dataDir = overrides.dataDir || env.RELAY_DATA_DIR || path.join(RELAY_ROOT, 'data');
  const tlsCert = overrides.tlsCert ?? env.RELAY_TLS_CERT ?? '';
  const tlsKey = overrides.tlsKey ?? env.RELAY_TLS_KEY ?? '';
  return {
    host: overrides.host || env.HOST || '0.0.0.0',
    port: overrides.port ?? num(env.PORT, tlsCert && tlsKey ? 443 : 8787),
    dataDir,
    webRoot: overrides.webRoot || env.RELAY_WEB_ROOT || defaultWebRoot(),
    tlsCert,
    tlsKey,
    adminToken: overrides.adminToken ?? env.RELAY_ADMIN_TOKEN ?? '',
    cookieName: overrides.cookieName || env.RELAY_COOKIE_NAME || 'onedesk_device',
    pairTtlSec: overrides.pairTtlSec ?? num(env.RELAY_PAIR_TTL_SEC, 600),
    inviteTtlSec: overrides.inviteTtlSec ?? num(env.RELAY_INVITE_TTL_SEC, 0),
    maxHubs: overrides.maxHubs ?? num(env.RELAY_MAX_HUBS, 300),
    pingIntervalMs: overrides.pingIntervalMs ?? num(env.RELAY_PING_INTERVAL_MS, 20000),
    pingTimeoutMs: overrides.pingTimeoutMs ?? num(env.RELAY_PING_TIMEOUT_MS, 60000),
    hubOfflineDelayMs: overrides.hubOfflineDelayMs ?? num(env.RELAY_HUB_OFFLINE_DELAY_MS, 1500),
    maxBodyBytes: overrides.maxBodyBytes ?? num(env.RELAY_MAX_BODY_BYTES, 1024 * 1024),
    maxWsBytes: overrides.maxWsBytes ?? num(env.RELAY_MAX_WS_BYTES, 10 * 1024 * 1024),
    pairFailLimit: overrides.pairFailLimit ?? num(env.RELAY_PAIR_FAIL_LIMIT, 8),
    pairFailWindowMs: overrides.pairFailWindowMs ?? num(env.RELAY_PAIR_FAIL_WINDOW_MS, 10 * 60 * 1000),
    jpushAppKey: overrides.jpushAppKey ?? env.JPUSH_APP_KEY ?? '',
    jpushMasterSecret: overrides.jpushMasterSecret ?? env.JPUSH_MASTER_SECRET ?? '',
    jpushFetch: overrides.jpushFetch,
    pushLimit: overrides.pushLimit ?? num(env.RELAY_PUSH_LIMIT, 30),
    pushWindowMs: overrides.pushWindowMs ?? num(env.RELAY_PUSH_WINDOW_MS, 60 * 1000),
    corsOrigin: overrides.corsOrigin ?? env.RELAY_CORS ?? '',
    trustProxy: overrides.trustProxy ?? env.RELAY_TRUST_PROXY === '1'
  };
}
