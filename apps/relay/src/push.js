import { RelayError, isNonEmptyString } from './util.js';

const MAX_TITLE = 80;
const MAX_BODY = 200;
const MAX_TAG = 80;

export function clipText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizePushPayload(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const title = clipText(src.title || 'Codesk', MAX_TITLE) || 'Codesk';
  const body = clipText(src.body, MAX_BODY);
  const tag = clipText(src.tag, MAX_TAG);
  if (!body) throw new RelayError('bad_envelope', 'push body required');
  return { title, body, tag };
}

export async function sendJpush({ appKey, masterSecret, registrationIds, title, body, tag, fetchImpl }) {
  const ids = (registrationIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!isNonEmptyString(appKey) || !isNonEmptyString(masterSecret)) {
    return { ok: false, n: 0, code: 'push_unconfigured' };
  }
  if (!ids.length) return { ok: true, n: 0 };
  const auth = Buffer.from(`${appKey}:${masterSecret}`).toString('base64');
  const doFetch = fetchImpl || fetch;
  const res = await doFetch('https://api.jpush.cn/v3/push', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      platform: ['android'],
      audience: { registration_id: ids },
      notification: {
        android: {
          alert: body,
          title,
          extras: tag ? { tag } : {}
        }
      }
    })
  });
  if (!res || !res.ok) {
    return { ok: false, n: 0, code: 'push_failed' };
  }
  return { ok: true, n: ids.length };
}
