import { hubUrlForPage, isPublicPageHost, pageContext, normalizeHubUrl } from './discover';
import { normalizeRelayUrl } from './protocol';
import { HOLDER_ALIVE_CODE, isHolderAliveResponse } from './force-clear-lock';

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const HTTP_DEADLINE_MS = 15_000;

/** The deadline includes body consumption, even if fetch/JSON ignores abort. */
export async function fetchJsonWithDeadline(url: string, init: RequestInit, timeoutMs = HTTP_DEADLINE_MS) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const json = await readJson(res);
        return { res, json };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('请求超时，结果未知；请检查连接后重试。'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const loginInflight = new Map<string, Promise<{ token: string; hubId: string }>>();
const pairInflight = new Map<string, Promise<{ deviceToken: string; hubId: string; hubE2ePub: string }>>();

export async function pairWithCode(
  relayUrl: string,
  code: string,
): Promise<{ deviceToken: string; hubId: string; hubE2ePub: string }> {
  const base = normalizeRelayUrl(relayUrl);
  const trimmed = String(code || '').trim();
  if (!base) throw new Error('请先填写中继地址');
  if (!trimmed) throw new Error('缺少配对码');
  const key = `${base}:${trimmed.toUpperCase()}`;
  const pending = pairInflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    let result: Awaited<ReturnType<typeof fetchJsonWithDeadline>>;
    try {
      result = await fetchJsonWithDeadline(`${base}/api/relay/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
    } catch (err) {
      if (err instanceof Error && /超时/.test(err.message)) throw err;
      throw new Error('网络不通：连不上中继。出门请填 https://hub.codesk.icu:8787');
    }
    const { res, json } = result;
    const token = typeof json?.deviceToken === 'string' ? json.deviceToken : '';
    if (!res.ok || !token) {
      const codeName = typeof json?.code === 'string' ? json.code : '';
      const msg = (typeof json?.message === 'string' && json.message) || (typeof json?.error === 'string' && json.error) || '';
      if (/invalid_code|pair_invalid|expired/i.test(`${codeName} ${msg}`)) {
        throw new Error('配对码不对或已过期。网络是通的，请到电脑主机台刷新码再试。');
      }
      throw new Error(msg || '配对失败');
    }
    return {
      deviceToken: token,
      hubId: typeof json?.hubId === 'string' ? json.hubId : '',
      hubE2ePub: typeof json?.hubE2ePub === 'string' ? json.hubE2ePub : '',
    };
  })();
  pairInflight.set(key, task);
  try {
    return await task;
  } finally {
    pairInflight.delete(key);
  }
}

export async function loginLan(hubUrl: string, password: string): Promise<{ token: string; hubId: string }> {
  const base = hubUrlForPage(hubUrl, pageContext().origin) || normalizeHubUrl(hubUrl);
  if (!base) throw new Error('请填写本机 Hub 地址，例如 http://127.0.0.1:18990');
  const secret = String(password || '').trim();
  if (!secret) throw new Error('请输入电脑上显示的码');
  const key = JSON.stringify([base, secret]);
  const pending = loginInflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    let result: Awaited<ReturnType<typeof fetchJsonWithDeadline>>;
    try {
      result = await fetchJsonWithDeadline(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: secret, code: secret }),
      });
    } catch (err) {
      if (err instanceof Error && /超时/.test(err.message)) throw err;
      let host = '';
      try { host = new URL(base).hostname; } catch { /* ignore */ }
      if (isPublicPageHost(host) && /:18990(?:\/|$)/.test(base)) {
        throw new Error('无法连接。公网隧道请走当前域名，不要访问 :18990。刷新页面后再输入家里码。');
      }
      throw new Error('无法连接');
    }
    const { res, json } = result;
    if (!res.ok) {
      throw new Error((typeof json?.error === 'string' && json.error) || '口令错误');
    }
    const token = typeof json?.token === 'string' ? json.token : '';
    if (!token) {
      const ct = String(res.headers.get('content-type') || '');
      if (/text\/html/i.test(ct)) {
        throw new Error('无法连接。登录被网关拦住了，请刷新页面重新验证后再输入家里码。');
      }
      throw new Error('无法连接');
    }
    return {
      token,
      hubId: typeof json?.hubId === 'string' ? json.hubId : '',
    };
  })();
  loginInflight.set(key, task);
  try { return await task; } finally { loginInflight.delete(key); }
}

export const FORCE_CLEAR_UNAVAILABLE = '强制删锁需要直连 Hub HTTP；当前连接不可用。Relay 不支持此接口，请切换到家里直连后操作。';

export async function forceClearThreadWriterLock(
  mode: '' | 'relay' | 'lan',
  hubUrl: string,
  token: string,
  threadId: string,
  confirmed: boolean,
  options?: { acknowledgeHolderAlive?: boolean },
): Promise<{ ok: true; cleared: boolean; threadId: string }> {
  // Relay credentials and a stale LAN URL must never be used as a Hub HTTP fallback.
  if (mode !== 'lan' || !hubUrl.trim()) throw new Error(FORCE_CLEAR_UNAVAILABLE);
  if (!confirmed) throw new Error('必须先确认强制删锁');
  if (!threadId.trim()) throw new Error('缺少会话 ID');
  const base = hubUrlForPage(hubUrl, pageContext().origin) || normalizeHubUrl(hubUrl);
  let res: Response;
  try {
    res = await fetch(`${base}/api/thread-writer-lock/force-clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ threadId, confirmed: true, ...(options?.acknowledgeHolderAlive ? { acknowledgeHolderAlive: true } : {}) }),
    });
  } catch {
    throw new Error('删锁请求失败：无法连接 Hub，结果未知；请检查连接后手动重试。');
  }
  const json = await readJson(res);
  if (!res.ok || json?.ok !== true) {
    // 契约：持锁端仍存活时返回 409 {error:'holder_alive',holderAlive:true,message}。
    // 抛出带 code/error/holderAlive 标识的错误，供界面层识别并升级为第二次更强确认。
    if (isHolderAliveResponse(json)) {
      const err = new Error((typeof json?.message === 'string' && json.message) || '检测到桌面进程仍在运行，锁文件未删除') as Error & {
        code: string; error: string; holderAlive: true;
      };
      err.code = HOLDER_ALIVE_CODE;
      err.error = HOLDER_ALIVE_CODE;
      err.holderAlive = true;
      throw err;
    }
    throw new Error((typeof json?.error === 'string' && json.error)
      || (typeof json?.message === 'string' && json.message) || '删锁失败：Hub 返回无效响应，结果未知');
  }
  if (json.threadId !== threadId || typeof json.cleared !== 'boolean') {
    throw new Error('删锁响应与当前会话不匹配或格式无效，结果未知');
  }
  return { ok: true, cleared: json.cleared, threadId };
}

const WS_UPLOAD_LIMIT = 4 * 1024 * 1024;
const LAN_UPLOAD_LIMIT = 20 * 1024 * 1024;

export function decodedBase64Size(base64: string): number {
  const raw = String(base64 || '').replace(/\s+/g, '');
  if (!raw) return 0;
  const pads = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - pads);
}

function bytesFromBase64(base64: string): Uint8Array {
  const raw = String(base64 || '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(raw, 'base64'));
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob;
  if (!atobFn) throw new Error('无法解码附件');
  const bin = atobFn(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function uploadLan(
  hubUrl: string,
  token: string,
  name: string,
  base64: string,
  mime?: string,
): Promise<{ path: string; name: string }> {
  const base = normalizeHubUrl(hubUrl);
  if (!base) throw new Error('家里直连才能上传大文件');
  const size = decodedBase64Size(base64);
  if (size > LAN_UPLOAD_LIMIT) throw new Error('文件超过 20MB');
  const bytes = bytesFromBase64(base64);
  const fileName = String(name || 'file').trim() || 'file';
  let res: Response;
  try {
    res = await fetch(`${base}/api/upload?name=${encodeURIComponent(fileName)}`, {
      method: 'POST',
      headers: {
        Authorization: token ? `Bearer ${token}` : '',
        'Content-Type': mime || 'application/octet-stream',
        'x-filename': fileName,
      },
      credentials: 'include',
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });
  } catch {
    throw new Error('上传失败：连不上家里电脑');
  }
  const json = await readJson(res);
  if (!res.ok || json?.success === false) {
    throw new Error((typeof json?.error === 'string' && json.error) || '上传失败');
  }
  return {
    path: typeof json?.path === 'string' ? json.path : '',
    name: typeof json?.name === 'string' ? json.name : fileName,
  };
}

export { WS_UPLOAD_LIMIT, LAN_UPLOAD_LIMIT };

export async function revokeDevice(relayUrl: string, deviceToken: string): Promise<void> {
  const base = normalizeRelayUrl(relayUrl);
  if (!base || !deviceToken) throw new Error('缺少设备凭据，无法撤销远程授权');
  const { res, json } = await fetchJsonWithDeadline(`${base}/api/relay/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceToken}`,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok || json?.ok !== true) throw new Error('撤销设备授权失败，远程授权可能仍有效，请重试');
}

export async function logoutLan(hubUrl: string, token: string): Promise<void> {
  const base = hubUrlForPage(hubUrl, pageContext().origin) || normalizeHubUrl(hubUrl);
  if (!base) throw new Error('缺少 Hub 地址，无法退出远程登录');
  const { res, json } = await fetchJsonWithDeadline(`${base}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({}),
  });
  if (!res.ok || json?.success !== true) throw new Error('退出远程登录失败，登录可能仍有效，请重试');
}
