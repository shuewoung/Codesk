import { normalizeHubUrl } from './discover';
import { normalizeRelayUrl } from './protocol';

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function pairWithCode(
  relayUrl: string,
  code: string,
): Promise<{ deviceToken: string; hubId: string; hubE2ePub: string }> {
  const base = normalizeRelayUrl(relayUrl);
  const trimmed = String(code || '').trim();
  if (!base) throw new Error('请先填写中继地址');
  if (!trimmed) throw new Error('缺少配对码');
  let res: Response;
  try {
    res = await fetch(`${base}/api/relay/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: trimmed }),
    });
  } catch {
    throw new Error('网络不通：连不上中继。出门请填 https://hub.codesk.icu:8787');
  }
  const json = await readJson(res);
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
}

export async function loginLan(hubUrl: string, password: string): Promise<{ token: string; hubId: string }> {
  const base = normalizeHubUrl(hubUrl);
  if (!base) throw new Error('请填写本机 Hub 地址，例如 http://127.0.0.1:18990');
  const secret = String(password || '').trim();
  if (!secret) throw new Error('请输入电脑上显示的码');
  let res: Response;
  try {
    res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: secret, code: secret }),
    });
  } catch {
    throw new Error('连不上同一 WiFi 上的电脑。确认 Hub 已开，并和手机在同一个网络。');
  }
  const json = await readJson(res);
  if (!res.ok) {
    throw new Error((typeof json?.error === 'string' && json.error) || '口令错误');
  }
  const token = typeof json?.token === 'string' ? json.token : secret;
  return {
    token,
    hubId: typeof json?.hubId === 'string' ? json.hubId : '',
  };
}

export async function revokeDevice(relayUrl: string, deviceToken: string): Promise<void> {
  const base = normalizeRelayUrl(relayUrl);
  if (!base || !deviceToken) return;
  await fetch(`${base}/api/relay/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deviceToken}`,
    },
    body: JSON.stringify({}),
  });
}
