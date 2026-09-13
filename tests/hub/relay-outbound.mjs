import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { freePort, startHub, stopHub, waitForWs, writeThreadFixture } from './harness.mjs';
import { anonymousBox, anonymousOpen, generateKeyPair, generateSecret, secretOpen, secretSeal } from '../../apps/web-hub/server/e2e.js';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const inbound = [];
const relayPort = await freePort();
const httpServer = http.createServer();
const wss = new WebSocketServer({ server: httpServer });
let hubSocket = null;

const ready = new Promise((resolve) => {
  wss.on('connection', (ws) => {
    hubSocket = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      inbound.push(msg);
      if (msg.type === 'register_hub') {
        ws.send(JSON.stringify({
          v: 1,
          type: 'pair_code',
          hubId: msg.hubId,
          payload: { code: '482193', expiresAtMs: null },
        }));
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ v: 1, type: 'pong', hubId: msg.hubId, payload: {} }));
      }
    });
    resolve(ws);
  });
});

await new Promise((resolve) => httpServer.listen(relayPort, '127.0.0.1', resolve));

const threadId = crypto.randomUUID();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-relay-cwd-'));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-relay-codex-'));
writeThreadFixture(codexHome, { threadId, cwd });

const hub = await startHub({
  CODEX_HOME: codexHome,
  ONEDESK_PASSWORD: 'relay-pass',
  ONEDESK_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
});

try {
  await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('hub did not connect to relay')), 8000)),
  ]);
  const registered = await new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const hit = inbound.find((msg) => msg.type === 'register_hub');
      if (hit) return resolve(hit);
      if (Date.now() - started > 8000) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
  record('hub registers outbound', Boolean(registered?.hubId && registered?.payload?.hubSecret), registered?.type || 'timeout');
  const dumped = JSON.stringify(inbound);
  record('no auth.json to relay', !/auth\.json|access_token|refresh_token/i.test(dumped));
  record('no local password to relay', !dumped.includes('relay-pass'));

  assert.ok(registered?.payload?.hubE2ePub, 'registration must advertise the Hub public key');

  // This fake relay represents transport after device authentication; never read
  // Hub identity files or inject its private/content keys into the test client.
  const device = generateKeyPair();
  const welcomeWait = waitForWs(hubSocket, (msg) => msg.type === 'e2e_welcome');
  hubSocket.send(JSON.stringify({
    v: 1, type: 'e2e_hello', hubId: registered.hubId,
    payload: anonymousBox({ devicePub: device.publicKey }, registered.payload.hubE2ePub),
  }));
  const welcome = await welcomeWait;
  const keys = anonymousOpen(welcome?.payload, device.secretKey);
  assert.ok(keys?.contentKey && keys?.keyId, 'encrypted welcome must provide content keys');
  assert.equal(keys.hubPub, registered.payload.hubE2ePub);
  record('relay e2e handshake', true);

  for (const [name, body] of [
    ['plaintext', { payload: { type: 'get_threads' } }],
    ['wrong-key', { enc: secretSeal({ type: 'get_threads' }, generateSecret(), keys.keyId) }],
  ]) {
    const rejected = waitForWs(hubSocket, (msg) => msg.type === 'error' && msg.payload?.code === 'e2e_required');
    hubSocket.send(JSON.stringify({ v: 1, type: 'fwd', hubId: registered.hubId, deviceId: 'dev-1', ...body }));
    const error = await rejected;
    record(`relay rejects ${name} fwd`, Boolean(error), error?.payload?.code || 'timeout');
  }

  const fwdWait = waitForWs(hubSocket, (msg) => (
    msg.type === 'fwd' && msg.deviceId === 'dev-1'
    && secretOpen(msg.enc, keys.contentKey)?.type === 'thread_list'
  ));
  hubSocket.send(JSON.stringify({
    v: 1,
    type: 'fwd',
    hubId: registered.hubId,
    deviceId: 'dev-1',
    enc: secretSeal({ type: 'get_threads' }, keys.contentKey, keys.keyId),
  }));
  const reply = await fwdWait;
  const app = secretOpen(reply?.enc, keys.contentKey);
  record('relay encrypted fwd get_threads', Boolean(
    reply?.enc?.ct && Object.keys(reply.payload || {}).length === 0 && reply.deviceId === 'dev-1'
    && Array.isArray(app?.data?.threads) && app.data.threads.some((thread) => thread.id === threadId)
  ), app?.type || 'timeout');
} catch (err) {
  record('relay suite crashed', false, err.message);
} finally {
  stopHub(hub);
  wss.close();
  httpServer.close();
}

const failed = results.filter((row) => !row.ok);
console.log(`\nrelay ${results.length - failed.length}/${results.length}`);
if (failed.length) process.exitCode = 1;
