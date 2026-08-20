import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { freePort, startHub, stopHub, writeThreadFixture } from './harness.mjs';

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
          payload: { code: '482193', expiresAtMs: Date.now() + 60000 },
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

  const fwdWait = new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const hit = inbound.find((msg) => msg.type === 'fwd' && msg.payload?.type === 'thread_list');
      if (hit) return resolve(hit);
      if (Date.now() - started > 8000) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
  hubSocket.send(JSON.stringify({
    v: 1,
    type: 'fwd',
    hubId: registered.hubId,
    deviceId: 'dev-1',
    payload: { type: 'get_threads' },
  }));
  const reply = await fwdWait;
  record('relay fwd get_threads', Boolean(reply?.payload?.data && reply.deviceId === 'dev-1'), reply?.payload?.type || 'timeout');
  assert.ok(true);
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
