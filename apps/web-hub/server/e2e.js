import nacl from 'tweetnacl';

export function b64uEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 1) bin += String.fromCharCode(u8[i]);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64uDecode(text) {
  const raw = String(text || '');
  const pad = raw.length % 4 === 2 ? '==' : raw.length % 4 === 3 ? '=' : '';
  return new Uint8Array(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64'));
}

function utf8(text) {
  return new TextEncoder().encode(String(text || ''));
}

function utf8dec(bytes) {
  return new TextDecoder().decode(bytes);
}

export function generateKeyPair() {
  const kp = nacl.box.keyPair();
  return { publicKey: b64uEncode(kp.publicKey), secretKey: b64uEncode(kp.secretKey) };
}

export function generateSecret() {
  return b64uEncode(nacl.randomBytes(32));
}

export function anonymousBox(plainObj, recipientPub) {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box(utf8(JSON.stringify(plainObj)), nonce, b64uDecode(recipientPub), eph.secretKey);
  return { ephPub: b64uEncode(eph.publicKey), n: b64uEncode(nonce), ct: b64uEncode(ct) };
}

export function anonymousOpen(box, recipientPriv) {
  if (!box?.ct || !box?.n || !box?.ephPub) return null;
  const opened = nacl.box.open(b64uDecode(box.ct), b64uDecode(box.n), b64uDecode(box.ephPub), b64uDecode(recipientPriv));
  if (!opened) return null;
  try {
    return JSON.parse(utf8dec(opened));
  } catch {
    return null;
  }
}

export function boxTo(plainObj, theirPub, myPriv) {
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box(utf8(JSON.stringify(plainObj)), nonce, b64uDecode(theirPub), b64uDecode(myPriv));
  return { n: b64uEncode(nonce), ct: b64uEncode(ct) };
}

export function boxOpen(box, theirPub, myPriv) {
  if (!box?.ct || !box?.n) return null;
  const opened = nacl.box.open(b64uDecode(box.ct), b64uDecode(box.n), b64uDecode(theirPub), b64uDecode(myPriv));
  if (!opened) return null;
  try {
    return JSON.parse(utf8dec(opened));
  } catch {
    return null;
  }
}

export function secretSeal(plainObj, keyB64, keyId) {
  const nonce = nacl.randomBytes(24);
  const ct = nacl.secretbox(utf8(JSON.stringify(plainObj)), nonce, b64uDecode(keyB64));
  return {
    v: 1,
    alg: 'nacl-secretbox',
    kid: keyId || '',
    n: b64uEncode(nonce),
    ct: b64uEncode(ct),
  };
}

export function secretOpen(enc, keyB64) {
  if (!enc?.ct || !enc?.n) return null;
  const opened = nacl.secretbox.open(b64uDecode(enc.ct), b64uDecode(enc.n), b64uDecode(keyB64));
  if (!opened) return null;
  try {
    return JSON.parse(utf8dec(opened));
  } catch {
    return null;
  }
}

export function fingerprint(pubB64) {
  const bytes = b64uDecode(pubB64);
  const hex = Buffer.from(bytes).toString('hex').slice(0, 8);
  return `${hex.slice(0, 4)} ${hex.slice(4)}`;
}
