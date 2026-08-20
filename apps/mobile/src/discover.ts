export const HUB_PORT = 18990;
export const DISCOVER_TIMEOUT_MS = 800;

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

export function pageContext(): { origin?: string; hostname?: string } {
  try {
    if (typeof window !== 'undefined' && window.location?.hostname) {
      return { origin: window.location.origin, hostname: window.location.hostname };
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
