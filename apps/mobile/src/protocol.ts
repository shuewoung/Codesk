export type EnvelopeType =
  | 'register_hub'
  | 'request_pair_code'
  | 'pair_code'
  | 'pair'
  | 'fwd'
  | 'ping'
  | 'pong'
  | 'hub_offline'
  | 'e2e_hello'
  | 'e2e_welcome'
  | 'error';

export type AppMessage = {
  type: string;
  [key: string]: unknown;
};

export type Envelope = {
  v: 1;
  type: EnvelopeType;
  hubId?: string;
  deviceId?: string | null;
  payload?: unknown;
  enc?: { v?: number; alg?: string; kid?: string; n?: string; ct?: string };
};

export type Incoming =
  | { kind: 'app'; message: AppMessage }
  | { kind: 'hub_offline'; hubId?: string }
  | { kind: 'ping' }
  | { kind: 'e2e_welcome'; payload: Record<string, unknown> }
  | { kind: 'enc'; enc: { ct?: string; n?: string; kid?: string } }
  | { kind: 'error'; code?: string; message: string }
  | { kind: 'ignore' };

function looksLikePlainHttp(host: string): boolean {
  return (
    /hub\.codesk\.icu/i.test(host) ||
    /:(8787|18990|80|8080|3000)(?:\/|$)/.test(host) ||
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)
  );
}

export function normalizeRelayUrl(raw: string): string {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    if (/^https?:\/\/hub\.codesk\.icu(?::\d+)?(?:\/|$)/i.test(trimmed)) {
      return 'https://hub.codesk.icu:8787';
    }
    return trimmed;
  }
  if (/^hub\.codesk\.icu(?::\d+)?$/i.test(trimmed)) return 'https://hub.codesk.icu:8787';
  return `${looksLikePlainHttp(trimmed) ? 'http' : 'https'}://${trimmed}`;
}

export function toWsUrl(relayUrl: string, token?: string): string {
  const http = normalizeRelayUrl(relayUrl);
  if (!http) return '';
  const ws = http.replace(/^http/i, 'ws');
  if (!token) return ws;
  const url = new URL(ws);
  url.searchParams.set('token', token);
  return url.toString();
}

export function extractPairFromInput(input: string): { code: string; relayUrl?: string; hubE2ePub?: string; lanUrl?: string } {
  const trimmed = String(input || '').trim();
  if (!trimmed) return { code: '' };
  try {
    const url = new URL(trimmed);
    const code = (url.searchParams.get('pair') || url.searchParams.get('code') || '').trim();
    const hubE2ePub = (url.searchParams.get('hk') || '').trim();
    const lanUrl = (url.searchParams.get('lan') || '').trim();
    if (code) {
      return { code, relayUrl: `${url.protocol}//${url.host}`, hubE2ePub, lanUrl };
    }
  } catch {
    /* raw code */
  }
  return { code: trimmed };
}

export function wrapFwd(hubId: string, payload: AppMessage): Envelope {
  return { v: 1, type: 'fwd', hubId, payload };
}

export function wrapPing(): Envelope {
  return { v: 1, type: 'ping', payload: {} };
}

export function wrapPong(hubId?: string): Envelope {
  const msg: Envelope = { v: 1, type: 'pong', payload: {} };
  if (hubId) msg.hubId = hubId;
  return msg;
}

export function unwrapIncoming(raw: unknown): Incoming {
  if (!raw || typeof raw !== 'object') return { kind: 'ignore' };
  const obj = raw as Record<string, unknown>;
  if (obj.v === 1 && typeof obj.type === 'string') {
    if (obj.type === 'e2e_welcome') {
      return {
        kind: 'e2e_welcome',
        payload: obj.payload && typeof obj.payload === 'object' ? (obj.payload as Record<string, unknown>) : {},
      };
    }
    if (obj.type === 'fwd') {
      const enc = obj.enc && typeof obj.enc === 'object' ? (obj.enc as Envelope['enc']) : undefined;
      if (enc?.ct) {
        return { kind: 'enc', enc };
      }
      const payload = obj.payload;
      if (payload && typeof payload === 'object') {
        return { kind: 'app', message: payload as AppMessage };
      }
      return { kind: 'ignore' };
    }
    if (obj.type === 'hub_offline') {
      return { kind: 'hub_offline', hubId: typeof obj.hubId === 'string' ? obj.hubId : undefined };
    }
    if (obj.type === 'pong') return { kind: 'ignore' };
    if (obj.type === 'ping') return { kind: 'ping' };
    if (obj.type === 'error') {
      const payload =
        obj.payload && typeof obj.payload === 'object'
          ? (obj.payload as Record<string, unknown>)
          : {};
      return {
        kind: 'error',
        code: typeof payload.code === 'string' ? payload.code : undefined,
        message: typeof payload.message === 'string' ? payload.message : '中继错误',
      };
    }
    return { kind: 'ignore' };
  }
  if (typeof obj.type === 'string') {
    return { kind: 'app', message: obj as AppMessage };
  }
  return { kind: 'ignore' };
}

export function nextBackoffMs(fails: number): number {
  return Math.min(15000, 1000 * 2 ** Math.min(Math.max(fails, 0), 4));
}
