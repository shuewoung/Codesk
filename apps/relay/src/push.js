import { RelayError, isNonEmptyString } from './util.js';

const MAX_TITLE = 80;
const MAX_BODY = 200;
const MAX_TAG = 80;
const MAX_URL = 200;
const THREAD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function clipText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function threadIdFromPush(value) {
  const text = String(value || '');
  const fromHash = text.match(/#thread-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (fromHash) return fromHash[1];
  const fromTag = text.match(/codex-(?:done|approval)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (fromTag) return fromTag[1];
  const any = text.match(THREAD_ID_RE);
  return any ? any[0] : '';
}

export function normalizePushPayload(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const title = clipText(src.title || 'Codesk', MAX_TITLE) || 'Codesk';
  const body = clipText(src.body, MAX_BODY);
  const tag = clipText(src.tag, MAX_TAG);
  const url = clipText(src.url, MAX_URL);
  const threadId = threadIdFromPush(src.threadId) || threadIdFromPush(url) || threadIdFromPush(tag);
  if (!body) throw new RelayError('bad_envelope', 'push body required');
  return { title, body, tag, url, threadId };
}

export async function sendJpush({ appKey, masterSecret, registrationIds, title, body, tag, url, threadId, fetchImpl }) {
  const ids = (registrationIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!isNonEmptyString(appKey) || !isNonEmptyString(masterSecret)) {
    return { ok: false, n: 0, code: 'push_unconfigured' };
  }
  if (!ids.length) return { ok: true, n: 0 };
  const extras = {};
  if (tag) extras.tag = String(tag);
  if (url) extras.url = String(url);
  if (threadId) extras.threadId = String(threadId);
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
          extras
        }
      }
    })
  });
  if (!res || !res.ok) {
    return { ok: false, n: 0, code: 'push_failed' };
  }
  return { ok: true, n: ids.length };
}
