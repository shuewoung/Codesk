(function (root) {
  const nacl = root.nacl;
  if (!nacl) return;

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function b64uEncode(bytes) {
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

  function b64uDecode(text) {
    const raw = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = raw.length % 4 === 2 ? '==' : raw.length % 4 === 3 ? '=' : '';
    const src = raw + pad;
    const out = [];
    for (let i = 0; i < src.length; i += 4) {
      const n = (B64.indexOf(src[i]) << 18) | (B64.indexOf(src[i + 1]) << 12) | (B64.indexOf(src[i + 2]) << 6) | B64.indexOf(src[i + 3]);
      out.push((n >> 16) & 255);
      if (src[i + 2] !== '=') out.push((n >> 8) & 255);
      if (src[i + 3] !== '=') out.push(n & 255);
    }
    return new Uint8Array(out);
  }

  function utf8(text) { return new TextEncoder().encode(String(text || '')); }
  function utf8dec(bytes) { return new TextDecoder().decode(bytes); }

  function generateKeyPair() {
    const kp = nacl.box.keyPair();
    return { publicKey: b64uEncode(kp.publicKey), secretKey: b64uEncode(kp.secretKey) };
  }

  function anonymousBox(plainObj, recipientPub) {
    const eph = nacl.box.keyPair();
    const nonce = nacl.randomBytes(24);
    const ct = nacl.box(utf8(JSON.stringify(plainObj)), nonce, b64uDecode(recipientPub), eph.secretKey);
    return { ephPub: b64uEncode(eph.publicKey), n: b64uEncode(nonce), ct: b64uEncode(ct) };
  }

  function anonymousOpen(box, recipientPriv) {
    if (!box || !box.ct || !box.n || !box.ephPub) return null;
    const opened = nacl.box.open(b64uDecode(box.ct), b64uDecode(box.n), b64uDecode(box.ephPub), b64uDecode(recipientPriv));
    if (!opened) return null;
    try { return JSON.parse(utf8dec(opened)); } catch (e) { return null; }
  }

  function boxOpen(box, theirPub, myPriv) {
    if (!box || !box.ct || !box.n) return null;
    const opened = nacl.box.open(b64uDecode(box.ct), b64uDecode(box.n), b64uDecode(theirPub), b64uDecode(myPriv));
    if (!opened) return null;
    try { return JSON.parse(utf8dec(opened)); } catch (e) { return null; }
  }

  function secretSeal(plainObj, keyB64, keyId) {
    const nonce = nacl.randomBytes(24);
    const ct = nacl.secretbox(utf8(JSON.stringify(plainObj)), nonce, b64uDecode(keyB64));
    return { v: 1, alg: 'nacl-secretbox', kid: keyId || '', n: b64uEncode(nonce), ct: b64uEncode(ct) };
  }

  function secretOpen(enc, keyB64) {
    if (!enc || !enc.ct || !enc.n) return null;
    const opened = nacl.secretbox.open(b64uDecode(enc.ct), b64uDecode(enc.n), b64uDecode(keyB64));
    if (!opened) return null;
    try { return JSON.parse(utf8dec(opened)); } catch (e) { return null; }
  }

  function loadDeviceKeys() {
    try {
      const raw = JSON.parse(localStorage.getItem('onedesk.e2eDevice') || 'null');
      if (raw && raw.publicKey && raw.secretKey) return raw;
    } catch (e) {}
    const next = generateKeyPair();
    localStorage.setItem('onedesk.e2eDevice', JSON.stringify(next));
    return next;
  }

  root.CodeskE2E = {
    generateKeyPair,
    anonymousBox,
    anonymousOpen,
    boxOpen,
    secretSeal,
    secretOpen,
    loadDeviceKeys,
  };
})(window);
