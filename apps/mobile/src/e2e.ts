import * as Crypto from 'expo-crypto';
import * as naclImport from 'tweetnacl';

const nacl = ((naclImport as { default?: typeof naclImport }).default || naclImport) as typeof naclImport & {
  setPRNG?: (fn: (x: Uint8Array, n: number) => void) => void;
};

if (typeof nacl.setPRNG === 'function') {
  nacl.setPRNG((x, n) => {
    x.set(Crypto.getRandomBytes(n));
  });
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64idx(ch: string): number {
  if (!ch || ch === '=') return 0;
  const i = B64.indexOf(ch);
  return i < 0 ? 0 : i;
}

function b64uEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >> 18) & 63] + B64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triple >> 6) & 63] : '';
    out += i + 2 < bytes.length ? B64[triple & 63] : '';
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_');
}

function b64uDecode(text: string): Uint8Array {
  const raw = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4 === 2 ? '==' : raw.length % 4 === 3 ? '=' : '';
  const src = raw + pad;
  const out: number[] = [];
  for (let i = 0; i < src.length; i += 4) {
    const n = (b64idx(src[i]) << 18) | (b64idx(src[i + 1]) << 12) | (b64idx(src[i + 2]) << 6) | b64idx(src[i + 3]);
    out.push((n >> 16) & 255);
    if (src[i + 2] !== '=') out.push((n >> 8) & 255);
    if (src[i + 3] !== '=') out.push(n & 255);
  }
  return new Uint8Array(out);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(String(text || ''));
}

function utf8dec(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function generateKeyPair(): { publicKey: string; secretKey: string } {
  if (!nacl?.box?.keyPair) throw new Error('加密库未加载');
  const kp = nacl.box.keyPair();
  return { publicKey: b64uEncode(kp.publicKey), secretKey: b64uEncode(kp.secretKey) };
}

export function anonymousBox(plainObj: unknown, recipientPub: string) {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box(utf8(JSON.stringify(plainObj)), nonce, b64uDecode(recipientPub), eph.secretKey);
  return { ephPub: b64uEncode(eph.publicKey), n: b64uEncode(nonce), ct: b64uEncode(ct) };
}

export function anonymousOpen(box: { ct?: string; n?: string; ephPub?: string }, recipientPriv: string): unknown {
  if (!box?.ct || !box?.n || !box?.ephPub) return null;
  const opened = nacl.box.open(b64uDecode(box.ct), b64uDecode(box.n), b64uDecode(box.ephPub), b64uDecode(recipientPriv));
  if (!opened) return null;
  try {
    return JSON.parse(utf8dec(opened));
  } catch {
    return null;
  }
}

export function boxOpen(box: { ct?: string; n?: string }, theirPub: string, myPriv: string): unknown {
  if (!box?.ct || !box?.n) return null;
  const opened = nacl.box.open(b64uDecode(box.ct), b64uDecode(box.n), b64uDecode(theirPub), b64uDecode(myPriv));
  if (!opened) return null;
  try {
    return JSON.parse(utf8dec(opened));
  } catch {
    return null;
  }
}

export function secretSeal(plainObj: unknown, keyB64: string, keyId = '') {
  const nonce = nacl.randomBytes(24);
  const ct = nacl.secretbox(utf8(JSON.stringify(plainObj)), nonce, b64uDecode(keyB64));
  return { v: 1, alg: 'nacl-secretbox', kid: keyId, n: b64uEncode(nonce), ct: b64uEncode(ct) };
}

export function secretOpen(enc: { ct?: string; n?: string }, keyB64: string): unknown {
  if (!enc?.ct || !enc?.n) return null;
  const opened = nacl.secretbox.open(b64uDecode(enc.ct), b64uDecode(enc.n), b64uDecode(keyB64));
  if (!opened) return null;
  try {
    return JSON.parse(utf8dec(opened));
  } catch {
    return null;
  }
}
