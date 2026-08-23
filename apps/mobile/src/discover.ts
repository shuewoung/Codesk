export const HUB_PORT = 18990;
export const EXPO_WEB_PORT = 18991;
export const LOCAL_HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
export const DISCOVER_TIMEOUT_MS = 800;
export const RELAY_PAGE_HOSTS = ['hub.codesk.icu'];

export type LanProbeEnv = { os?: string; hostname?: string; port?: string };

export function isRelayPageHost(hostname?: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return RELAY_PAGE_HOSTS.includes(host);
}

function runtimeLanProbeEnv(): LanProbeEnv {
  const env: LanProbeEnv = {};
  try {
    const { Platform } = require('react-native') as { Platform?: { OS?: string } };
    env.os = String(Platform?.OS || '');
  } catch {
    env.os = '';
  }
  try {
    const loc = (globalThis as { location?: { hostname?: string; port?: string } }).location;
    if (loc?.hostname) {
      env.hostname = loc.hostname;
      env.port = loc.port || '';
    }
  } catch {
    /* native */
  }
  return env;
}

export function canLanProbe(env?: LanProbeEnv): boolean {
  const merged = { ...runtimeLanProbeEnv(), ...env };
  const os = String(merged.os || '');
  if (os === 'ios' || os === 'android') return true;
  if (os !== 'web') return false;
  const hostname = String(merged.hostname || '');
  const port = String(merged.port || '');
  if (!hostname) return false;
  if (port === String(HUB_PORT)) return false;
  if (isRelayPageHost(hostname)) return false;
  return true;
}

export type DiscoverHit = { url: string; hubId?: string };

function stripSlash(raw: string): string {
  return String(raw || '').trim().replace(/\/+$/, '');
}

export function isLoopbackHost(host: string): boolean {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

export function isPrivateIPv4(host: string): boolean {
  const h = String(host || '').trim();
  if (/^10(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 16 && n <= 31;
}

export function normalizeHubUrl(raw: string): string {
  const trimmed = stripSlash(raw);
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const host = trimmed.split('/')[0].split(':')[0];
  if (isLoopbackHost(host) || isPrivateIPv4(host)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

export function pageContext(): { origin?: string; hostname?: string; port?: string; protocol?: string } {
  try {
    if (typeof window !== 'undefined' && window.location?.hostname) {
      return {
        origin: window.location.origin,
        hostname: window.location.hostname,
        port: window.location.port || '',
        protocol: window.location.protocol,
      };
    }
  } catch {
    /* native */
  }
  try {
    const Constants = require('expo-constants').default as {
      expoGoConfig?: { debuggerHost?: string };
      expoConfig?: { hostUri?: string };
    };
    const raw = String(Constants.expoGoConfig?.debuggerHost || Constants.expoConfig?.hostUri || '');
    const hostname = raw.split('/')[0].split(':')[0].trim();
    if (hostname) return { hostname };
  } catch {
    /* ignore */
  }
  return {};
}

export function sameHostHubUrl(opts?: { hostname?: string; protocol?: string }): string {
  const ctx = pageContext();
  const hostname = String(opts?.hostname || ctx.hostname || '').replace(/^\[|\]$/g, '');
  if (!hostname || isRelayPageHost(hostname)) return '';
  const protocol = String(opts?.protocol || ctx.protocol || '').trim() || 'http:';
  const secure = protocol === 'https:' && !isLoopbackHost(hostname) && !isPrivateIPv4(hostname) && !isCgNatIPv4(hostname);
  return `${secure ? 'https' : 'http'}://${hostname}:${HUB_PORT}`;
}

export function isCgNatIPv4(host: string): boolean {
  const m = String(host || '').trim().match(/^100\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 64 && n <= 127;
}

export function isPublicPageHost(host: string): boolean {
  const hostname = String(host || '').replace(/^\[|\]$/g, '');
  if (!hostname || isRelayPageHost(hostname)) return false;
  if (isLoopbackHost(hostname) || isPrivateIPv4(hostname) || isCgNatIPv4(hostname)) return false;
  return true;
}

function publicPageOrigin(opts?: { hostname?: string; port?: string; protocol?: string; origin?: string }): string {
  const ctx = pageContext();
  const origin = stripSlash(opts?.origin || ctx.origin || '');
  if (origin) return origin;
  const hostname = String(opts?.hostname || ctx.hostname || '').replace(/^\[|\]$/g, '');
  if (!hostname) return '';
  const protocol = String(opts?.protocol || ctx.protocol || 'https:');
  const port = String(opts?.port || ctx.port || '');
  const skipPort = !port || port === '80' || port === '443';
  return `${protocol}//${hostname}${skipPort ? '' : `:${port}`}`;
}

export function pageHubUrl(opts?: { hostname?: string; port?: string; protocol?: string; origin?: string }): string {
  const ctx = pageContext();
  const hostname = String(opts?.hostname || ctx.hostname || '').replace(/^\[|\]$/g, '');
  const port = String(opts?.port || ctx.port || '');
  if (!hostname || isRelayPageHost(hostname)) return '';
  if (port === String(HUB_PORT)) {
    const origin = stripSlash(opts?.origin || ctx.origin || '');
    if (origin) return origin;
  }
  if (isPublicPageHost(hostname)) return publicPageOrigin({
    hostname,
    port,
    protocol: opts?.protocol || ctx.protocol,
    origin: opts?.origin || ctx.origin,
  });
  if (isLoopbackHost(hostname)) return LOCAL_HUB_URL;
  return sameHostHubUrl({ hostname, protocol: opts?.protocol || ctx.protocol });
}

export function isColocatedWebShell(env?: LanProbeEnv): boolean {
  const merged = { ...runtimeLanProbeEnv(), ...env };
  if (String(merged.os || '') !== 'web') return false;
  return !isRelayPageHost(merged.hostname);
}

export async function findColocatedHub(): Promise<DiscoverHit | null> {
  const url = pageHubUrl();
  if (!url) return null;
  return probeHub(url);
}

export function candidateHubUrls(opts: {
  pageOrigin?: string;
  pageHostname?: string;
  lastLanUrl?: string;
  includeLoopback?: boolean;
} = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw?: string) => {
    const url = normalizeHubUrl(raw || '');
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  const origin = stripSlash(opts.pageOrigin || '');
  if (origin) {
    try {
      const u = new URL(origin);
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      if (port === String(HUB_PORT)) add(u.origin);
    } catch {
      /* ignore */
    }
  }

  add(opts.lastLanUrl);
  if (opts.includeLoopback !== false) {
    add(`http://127.0.0.1:${HUB_PORT}`);
    add(`http://localhost:${HUB_PORT}`);
  }

  const host = String(opts.pageHostname || '').replace(/^\[|\]$/g, '');
  if (isPrivateIPv4(host)) {
    add(`http://${host}:${HUB_PORT}`);
    const parts = host.split('.');
    if (parts.length === 4) {
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
      if (parts[3] !== '1') add(`http://${prefix}.1:${HUB_PORT}`);
      if (parts[3] !== '2') add(`http://${prefix}.2:${HUB_PORT}`);
    }
  }

  return out;
}

export async function probeHub(url: string, timeoutMs = DISCOVER_TIMEOUT_MS): Promise<DiscoverHit | null> {
  const base = normalizeHubUrl(url);
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/discover`, { method: 'GET', signal: ctrl.signal });
    const json = (await res.json()) as { ok?: unknown; hub?: unknown; hubId?: unknown };
    if (!res.ok || json?.ok !== true || json?.hub !== true) return null;
    return {
      url: base,
      hubId: typeof json.hubId === 'string' ? json.hubId : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverHub(opts: {
  pageOrigin?: string;
  pageHostname?: string;
  lastLanUrl?: string;
  includeLoopback?: boolean;
} = {}): Promise<DiscoverHit | null> {
  const urls = candidateHubUrls(opts);
  const found = await Promise.all(urls.map((url) => probeHub(url)));
  return found.find((hit) => hit) || null;
}
