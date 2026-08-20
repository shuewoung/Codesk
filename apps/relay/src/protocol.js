import { RelayError, asObject, isNonEmptyString } from './util.js';

export const ENVELOPE_TYPES = new Set([
  'register_hub',
  'request_pair_code',
  'pair_code',
  'pair',
  'fwd',
  'ping',
  'pong',
  'hub_offline',
  'e2e_hello',
  'e2e_welcome',
  'push_register',
  'push_send',
  'error'
]);

export function envelope({ type, hubId = undefined, payload = {} }) {
  const msg = { v: 1, type, payload: payload ?? {} };
  if (hubId) msg.hubId = hubId;
  return msg;
}

export function errorEnvelope(code, message, hubId) {
  return envelope({
    type: 'error',
    hubId,
    payload: { code, message }
  });
}

export function parseEnvelope(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new RelayError('bad_envelope', 'invalid JSON');
  }
  const obj = asObject(parsed);
  if (!obj) throw new RelayError('bad_envelope', 'envelope must be an object');
  if (obj.v !== 1) throw new RelayError('bad_envelope', 'unsupported envelope version');
  if (!isNonEmptyString(obj.type) || !ENVELOPE_TYPES.has(obj.type)) {
    throw new RelayError('bad_envelope', 'unknown envelope type');
  }
  const payload = obj.payload == null ? {} : obj.payload;
  return {
    v: 1,
    type: obj.type,
    hubId: isNonEmptyString(obj.hubId) ? obj.hubId.trim() : '',
    deviceId: isNonEmptyString(obj.deviceId) ? obj.deviceId.trim() : '',
    payload,
    enc: asObject(obj.enc) || null,
    hubSecret: isNonEmptyString(obj.hubSecret) ? obj.hubSecret : ''
  };
}

export function readHubSecret(msg) {
  if (msg.hubSecret) return msg.hubSecret;
  const payload = asObject(msg.payload);
  if (payload && isNonEmptyString(payload.hubSecret)) return payload.hubSecret;
  return '';
}

export function readInviteCode(msg) {
  const payload = asObject(msg.payload);
  if (!payload) return '';
  if (isNonEmptyString(payload.inviteCode)) return payload.inviteCode;
  if (isNonEmptyString(payload.invite)) return payload.invite;
  return '';
}

export function readPairCode(msg) {
  const payload = asObject(msg.payload);
  if (!payload) return '';
  if (isNonEmptyString(payload.code)) return payload.code;
  if (isNonEmptyString(payload.pairCode)) return payload.pairCode;
  return '';
}

export function assertFwdPayload(payload, enc) {
  if (enc && isNonEmptyString(enc.ct)) return;
  if (asObject(payload)) return;
  throw new RelayError('bad_envelope', 'fwd requires enc.ct or payload');
}

export function sendJsonWs(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}
