import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../relay/src/index.js';
import { pairWithCode, revokeDevice } from '../src/api';
import { extractPairFromInput, toWsUrl, unwrapIncoming, wrapFwd, wrapPing } from '../src/protocol';

const require = createRequire(new URL('../../relay/package.json', import.meta.url));
const { WebSocket } = require('ws') as {
  WebSocket: new (url: string, opts?: { headers?: Record<string, string> }) => NodeWs;
};

type NodeWs = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'message', fn: (buf: Buffer) => void): void;
  once(event: 'open' | 'error' | 'close' | 'message', fn: (...args: unknown[]) => void): void;
  off(event: 'message', fn: (buf: Buffer) => void): void;
};

let relay: Awaited<ReturnType<typeof createRelay>>;
let httpBase = '';
let wsBase = '';
let dataDir = '';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-mobile-'));
  const webRoot = path.join(dataDir, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>OneDesk</title>');
  relay = await createRelay({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webRoot,
    adminToken: 'admin-test-token',
    hubOfflineDelayMs: 200,
    pingIntervalMs: 60_000,
    pingTimeoutMs: 120_000,
  });
  await relay.listen();
  httpBase = `http://127.0.0.1:${relay.config.port}`;
  wsBase = `ws://127.0.0.1:${relay.config.port}/`;
});

after(async () => {
  if (relay) await relay.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scan URL extracts pair code and relay origin', () => {
  const parsed = extractPairFromInput(`${httpBase}/?pair=AB12CD`);
  assert.equal(parsed.code, 'AB12CD');
  assert.equal(parsed.relayUrl, httpBase);
});

test('bad pair code fails with explicit error', async () => {
  await assert.rejects(() => pairWithCode(httpBase, 'NOPE12'), /./);
});

test('pair, header WSS, fwd, hub_offline, revoke', async () => {
  const invite = relay.store.createInvite({ note: 'mobile' }).code;
  const hub = { hubId: 'hub-mobile-1', hubSecret: 'secret-mobile-aaaa' };
  const hubWs = await openWs(wsBase);
  hubWs.send(JSON.stringify({
    v: 1,
    type: 'register_hub',
    hubId: hub.hubId,
    payload: { hubSecret: hub.hubSecret, inviteCode: invite },
  }));
  const registered = await waitType(hubWs, 'register_hub');
  assert.equal((registered.payload as { ok?: boolean }).ok, true);

  const issued = await fetch(`${httpBase}/api/relay/pair-code`, {
    method: 'POST',
    headers: { authorization: `Hub ${hub.hubId}:${hub.hubSecret}` },
  }).then((res) => res.json()) as { code: string };
  assert.ok(issued.code);

  const device = await pairWithCode(httpBase, issued.code);
  assert.equal(device.hubId, hub.hubId);
  assert.ok(device.deviceToken.startsWith('odt_'));

  const wsUrl = toWsUrl(httpBase, device.deviceToken);
  assert.match(wsUrl, /[?&]token=/);
  const phone = await openWs(wsUrl, device.deviceToken);

  phone.send(JSON.stringify(wrapFwd(device.hubId, { type: 'get_threads' })));
  const toHub = await waitType(hubWs, 'fwd');
  assert.equal((toHub.payload as { type?: string }).type, 'get_threads');

  hubWs.send(JSON.stringify(wrapFwd(hub.hubId, {
    type: 'thread_list',
    data: { threads: [{ id: 't1', title: '会话一', projectName: 'Demo' }] },
  })));
  const listEnv = await waitType(phone, 'fwd');
  const list = unwrapIncoming(listEnv);
  assert.equal(list.kind, 'app');
  if (list.kind === 'app') {
    assert.equal(list.message.type, 'thread_list');
  }

  phone.send(JSON.stringify(wrapPing()));
  const pong = await waitType(phone, 'pong');
  assert.equal(unwrapIncoming(pong).kind, 'ignore');

  phone.send(JSON.stringify(wrapFwd(device.hubId, {
    type: 'send_approval',
    threadId: 't1',
    requestId: 'req-1',
    decision: 'accept',
  })));
  const approvalFwd = await waitType(hubWs, 'fwd');
  assert.deepEqual(approvalFwd.payload, {
    type: 'send_approval',
    threadId: 't1',
    requestId: 'req-1',
    decision: 'accept',
  });

  hubWs.close();
  const offlineEnv = await waitType(phone, 'hub_offline', 2000);
  const offline = unwrapIncoming(offlineEnv);
  assert.equal(offline.kind, 'hub_offline');

  await revokeDevice(httpBase, device.deviceToken);
  const revoked = await fetch(`${httpBase}/api/relay/hubs`, {
    headers: { authorization: `Bearer ${device.deviceToken}` },
  });
  assert.equal(revoked.status, 403);
  phone.close();
});

test('this test file lives next to the Expo app, not the relay tree', () => {
  const here = fileURLToPath(import.meta.url);
  assert.match(here.replaceAll('\\', '/'), /apps\/mobile\/test\//);
});

function openWs(url: string, token?: string): Promise<NodeWs> {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 2000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitType(ws: NodeWs, type: string, timeoutMs = 1500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const onMsg = (buf: Buffer) => {
      const msg = JSON.parse(String(buf)) as Record<string, unknown>;
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    };
    ws.on('message', onMsg);
  });
}
