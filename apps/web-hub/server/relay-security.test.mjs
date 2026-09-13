import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRelayClient } from './relay-client.js';
import { anonymousBox, anonymousOpen, generateKeyPair, generateSecret, secretSeal, secretOpen } from './e2e.js';

function fixture(t) {
  const hub = generateKeyPair();
  const device = generateKeyPair();
  const identity = { hubId: 'fixture-hub', hubSecret: 'fixture-secret', e2ePub: hub.publicKey, e2ePriv: hub.secretKey, contentKey: generateSecret(), keyId: 'fixture-key' };
  let ws;
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { super(); ws = this; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const received = [];
  const client = createRelayClient({ url: 'ws://fixture.invalid', identity, WebSocketImpl: Socket, onFwd: (msg) => received.push(msg) });
  t.after(() => client.stop());
  client.start();
  ws.emit('open');
  ws.sent.length = 0;
  const inject = (type, payload, extra = {}) => ws.emit('message', JSON.stringify({ v: 1, hubId: identity.hubId, type, payload, deviceId: 'device-authenticated', ...extra }));
  return { identity, device, client, ws, inject, received };
}

test('boxed and legacy hello remain compatible, welcome targets envelope identity', (t) => {
  const { identity, device, ws, inject } = fixture(t);
  const other = generateKeyPair();
  inject('e2e_hello', { ...anonymousBox({ devicePub: device.publicKey, deviceId: 'inner-forged' }, identity.e2ePub), devicePub: other.publicKey });
  assert.equal(ws.sent[0].type, 'e2e_welcome');
  assert.equal(ws.sent[0].deviceId, 'device-authenticated');
  assert.equal(anonymousOpen(ws.sent[0].payload, device.secretKey).contentKey, identity.contentKey);
  assert.equal(anonymousOpen(ws.sent[0].payload, other.secretKey), null);
  inject('e2e_hello', { devicePub: device.publicKey });
  assert.equal(ws.sent[1].type, 'e2e_welcome');
  // Old relays do not stamp identity: handshake compatibility stays intact.
  inject('e2e_hello', anonymousBox({ devicePub: device.publicKey }, identity.e2ePub), { deviceId: undefined });
  assert.equal(ws.sent[2].type, 'e2e_welcome');
  assert.equal(ws.sent[2].deviceId, undefined);
});

test('invalid, wrong-recipient or partial boxed hello cannot downgrade to plaintext', (t) => {
  const { identity, device, ws, inject } = fixture(t);
  const wrong = generateKeyPair();
  const bad = [
    { ...anonymousBox({ devicePub: device.publicKey }, wrong.publicKey), devicePub: device.publicKey },
    { ct: '', devicePub: device.publicKey },
    { n: 'bad', devicePub: device.publicKey },
    { ct: 'bad', n: 'bad', ephPub: 'bad', devicePub: device.publicKey },
    anonymousBox({}, identity.e2ePub),
    { devicePub: 'bad' },
  ];
  for (const payload of bad) inject('e2e_hello', payload);
  assert.equal(ws.sent.length, bad.length);
  for (const msg of ws.sent) {
    assert.equal(msg.type, 'error');
    assert.equal(msg.payload.code, 'e2e_hello_bad');
    assert.equal(msg.deviceId, 'device-authenticated');
    assert.equal(JSON.stringify(msg).includes(identity.contentKey), false);
  }
});

test('download requires outer routing identity; decrypt failures return targeted errors', (t) => {
  const { identity, client, ws, inject, received } = fixture(t);
  for (const type of ['download_file', 'cancel_download']) {
    inject('fwd', undefined, { deviceId: undefined, enc: secretSeal({ type, deviceId: 'inner-forged' }, identity.contentKey, identity.keyId) });
  }
  assert.equal(received.length, 0);
  assert.equal(ws.sent.every((msg) => msg.payload.code === 'device_required'), true);
  inject('fwd', undefined, { enc: secretSeal({ type: 'download_file', deviceId: 'inner-forged' }, identity.contentKey, identity.keyId) });
  assert.equal(received[0].deviceId, 'device-authenticated');
  inject('fwd', { type: 'download_file' });
  inject('fwd', undefined, { enc: { ct: 'bad', n: 'bad' } });
  assert.equal(received.length, 1);
  assert.equal(ws.sent.at(-1).payload.code, 'e2e_required');
  assert.equal(ws.sent.at(-1).deviceId, 'device-authenticated');
  const before = ws.sent.length;
  for (const type of ['download_start', 'download_chunk', 'download_complete', 'download_error']) {
    assert.equal(client.forwardApp({ type }), false);
    assert.equal(client.forwardApp({ type }, { deviceId: {} }), false);
  }
  assert.equal(ws.sent.length, before);
  assert.equal(client.forwardApp({ type: 'download_chunk', content: 'fixture' }, { deviceId: 'device-authenticated' }), true);
  assert.equal(ws.sent.at(-1).deviceId, 'device-authenticated');
  assert.equal(secretOpen(ws.sent.at(-1).enc, identity.contentKey).content, 'fixture');
  assert.equal(client.forwardApp({ type: 'thread_update' }), true);
  assert.equal(ws.sent.at(-1).deviceId, undefined);
});
