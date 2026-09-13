import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { createRelay } from '../src/index.js';
import { parseEnvelope } from '../src/protocol.js';
import { RelayNet } from '../src/ws.js';
import { createRelayClient } from '../../web-hub/server/relay-client.js';
import { createDownloadManager } from '../../web-hub/server/file-download.js';
import { anonymousBox, anonymousOpen, generateKeyPair, generateSecret, secretOpen, secretSeal } from '../../web-hub/server/e2e.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > end) throw new Error('fixture timeout'); await wait(10); }
}

test('real relay and Hub client isolate original downloads and route authenticated identities', { timeout: 15000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-security-'));
  const relay = await createRelay({ host: '127.0.0.1', port: 0, dataDir: dir, webRoot: dir, adminToken: 'fixture-admin', pingIntervalMs: 60000 });
  const phones = [];
  let client;
  const managers = new Map();
  t.after(async () => {
    for (const manager of managers.values()) manager.close();
    client?.stop();
    for (const phone of phones) phone.ws.terminate();
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await relay.listen();
  const url = `ws://127.0.0.1:${relay.config.port}`;
  const hubKeys = generateKeyPair();
  const identity = { hubId: 'fixture-download-hub', hubSecret: 'fixture-secret-12345', e2ePub: hubKeys.publicKey, e2ePriv: hubKeys.secretKey, contentKey: generateSecret(), keyId: 'fixture-key' };
  const file = path.join(dir, 'original.bin');
  const original = crypto.randomBytes(300000);
  fs.writeFileSync(file, original);
  const upstream = [];
  let pausedDevice = '';
  client = createRelayClient({ url, identity, inviteCode: relay.store.createInvite().code, onFwd(msg) {
    upstream.push(msg);
    if (!['download_file', 'cancel_download'].includes(msg.payload.type)) return;
    const deviceId = msg.deviceId;
    let manager = managers.get(deviceId);
    if (!manager) {
      manager = createDownloadManager({
        authorize: (request) => { assert.equal(request.path, file); return file; },
        send: (app) => assert.equal(client.forwardApp(app, { deviceId }), true),
        bufferedAmount: () => pausedDevice === deviceId ? 2 * 1024 * 1024 : 0,
      });
      managers.set(deviceId, manager);
    }
    if (msg.payload.type === 'cancel_download') manager.cancel(msg.payload.requestId);
    else void manager.start(msg.payload);
  } });
  client.start();
  await until(() => relay.net.isHubOnline(identity.hubId));
  async function phone(hubId = identity.hubId) {
    const pair = relay.store.createPairCode({ hubId });
    const device = relay.store.redeemPairCode(pair.code);
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${device.deviceToken}` } });
    const messages = [];
    ws.on('message', (buf) => messages.push(JSON.parse(String(buf))));
    const row = { ws, messages, id: device.device.id, token: device.deviceToken };
    phones.push(row);
    await until(() => ws.readyState === WebSocket.OPEN);
    return row;
  }
  const a = await phone();
  const b = await phone();
  const aTab = await (async () => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${a.token}` } });
    const row = { ws, messages: [], id: a.id };
    phones.push(row);
    ws.on('message', (buf) => row.messages.push(JSON.parse(String(buf))));
    await until(() => ws.readyState === WebSocket.OPEN);
    return row;
  })();
  const otherHub = 'fixture-other-hub';
  relay.store.registerHub({ hubId: otherHub, hubSecret: 'fixture-other-secret', inviteCode: relay.store.createInvite().code, maxHubs: 300 });
  const foreign = await phone(otherHub);
  const send = (p, type, fields = {}) => p.ws.send(JSON.stringify({ v: 1, type, hubId: identity.hubId, ...fields }));
  const appSend = (p, app, deviceId = undefined) => send(p, 'fwd', { deviceId, enc: secretSeal(app, identity.contentKey, identity.keyId) });
  const apps = (p) => p.messages.filter((m) => m.type === 'fwd').map((m) => secretOpen(m.enc, identity.contentKey));

  const deviceKeys = generateKeyPair();
  send(a, 'e2e_hello', { deviceId: b.id, payload: anonymousBox({ devicePub: deviceKeys.publicKey, deviceId: b.id }, identity.e2ePub) });
  await until(() => a.messages.some((m) => m.type === 'e2e_welcome'));
  assert.equal(anonymousOpen(a.messages.find((m) => m.type === 'e2e_welcome').payload, deviceKeys.secretKey).contentKey, identity.contentKey);
  await wait(30);
  assert.equal(b.messages.length, 0);
  assert.equal(aTab.messages.some((m) => m.type === 'e2e_welcome'), true);
  send(a, 'e2e_welcome', { payload: {} });
  await until(() => a.messages.some((m) => m.type === 'error'));
  assert.equal(a.messages.at(-1).payload.code, 'unauthorized');
  send(a, 'e2e_hello', { hubId: otherHub, payload: {} });
  await until(() => a.messages.at(-1)?.payload?.code === 'hub_mismatch');

  const bBeforeBadHello = b.messages.length;
  send(a, 'e2e_hello', { payload: { ct: '', devicePub: deviceKeys.publicKey } });
  await until(() => a.messages.at(-1)?.payload?.code === 'e2e_hello_bad');
  assert.equal(a.messages.at(-1).deviceId, a.id);
  await wait(30);
  assert.equal(b.messages.length, bBeforeBadHello);
  send(a, 'register_hub', { payload: { hubSecret: identity.hubSecret } });
  await until(() => a.messages.at(-1)?.payload?.code === 'bad_envelope');

  // B's active request must not be cancelled by A forging B's outer deviceId.
  pausedDevice = b.id;
  appSend(b, { type: 'download_file', requestId: 'same-id', path: file });
  await until(() => apps(b).some((m) => m.type === 'download_start'));
  appSend(a, { type: 'cancel_download', requestId: 'same-id' }, b.id);
  await until(() => apps(a).some((m) => m.code === 'NOT_FOUND'));
  assert.equal(upstream.at(-1).deviceId, a.id);
  assert.equal(managers.get(b.id).size, 1);
  appSend(a, { type: 'download_file', requestId: 'same-id', path: file }, b.id);
  await until(() => apps(a).some((m) => m.type === 'download_complete'));
  pausedDevice = '';
  await until(() => apps(b).some((m) => m.type === 'download_complete'));
  for (const p of [a, aTab, b]) {
    const received = apps(p);
    assert.equal(received.filter((m) => m.type === 'download_start').length, 1);
    assert.deepEqual(Buffer.concat(received.filter((m) => m.type === 'download_chunk').map((m) => Buffer.from(m.content, 'base64'))), original);
    assert.equal(received.find((m) => m.type === 'download_complete').sha256, crypto.createHash('sha256').update(original).digest('hex'));
  }
  assert.equal(foreign.messages.length, 0);

  // Unknown, foreign and revoked targets must never fall back to broadcast.
  const counts = phones.map((p) => p.messages.length);
  for (const deviceId of ['missing-device', foreign.id]) client.forwardApp({ type: 'download_chunk', content: 'must-not-leak' }, { deviceId });
  await wait(50);
  assert.deepEqual(phones.map((p) => p.messages.length), counts);
  client.forwardApp({ type: 'thread_update', marker: 'broadcast' });
  await until(() => [a, aTab, b].every((p) => apps(p).some((m) => m.marker === 'broadcast')));
  assert.equal(foreign.messages.length, 0);
  relay.store.revokeDevice(b.id);
  relay.net.closeDevice(b.id);
  await until(() => b.ws.readyState === WebSocket.CLOSED);
  const before = a.messages.length;
  client.forwardApp({ type: 'download_chunk', content: 'revoked' }, { deviceId: b.id });
  await wait(40);
  assert.equal(a.messages.length, before);
});

test('invalid target is rejected rather than normalized to broadcast', () => {
  for (const deviceId of ['', '   ', false, 0, {}, []]) {
    assert.throws(() => parseEnvelope({ v: 1, type: 'fwd', deviceId }), /deviceId/);
  }
  for (const deviceId of [undefined, null]) assert.equal(parseEnvelope({ v: 1, type: 'fwd', deviceId }).deviceId, '');
});

test('replaced hub loses authenticated metadata immediately', () => {
  const net = new RelayNet({ store: {}, audit: {}, config: {} });
  const old = { close() {}, readyState: 1 };
  const current = { readyState: 1 };
  net.attachHub('hub', old);
  net.attachHub('hub', current);
  assert.equal(old.revoked, true);
  assert.equal(net.meta.has(old), false);
  net.detachWs(old);
  assert.equal(net.hubSockets.get('hub').ws, current);
});
