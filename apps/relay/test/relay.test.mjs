import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';
import { createRelay } from '../src/index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-relay-'));
const webRoot = path.join(dataDir, 'web');
fs.mkdirSync(webRoot);
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>OneDesk</title>');

const relay = await createRelay({
  host: '127.0.0.1',
  port: 0,
  dataDir,
  webRoot,
  adminToken: 'admin-test-token',
  hubOfflineDelayMs: 200,
  pingIntervalMs: 60_000,
  pingTimeoutMs: 120_000
});
await relay.listen();
const base = `http://127.0.0.1:${relay.config.port}`;
const wsBase = `ws://127.0.0.1:${relay.config.port}/ws`;

after(async () => {
  await relay.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health and static hosting', async () => {
  const health = await json('GET', '/api/relay/health');
  assert.equal(health.ok, true);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /OneDesk/);
});

test('unpaired phone cannot reach a hub', async () => {
  const pair = await raw('POST', '/api/relay/pair', { code: 'NOPE12' });
  assert.equal(pair.status, 401);

  const hubs = await raw('GET', '/api/relay/hubs');
  assert.equal(hubs.status, 401);

  const ws = await openWs(wsBase);
  ws.send(JSON.stringify({ v: 1, type: 'fwd', payload: { type: 'get_threads' } }));
  const err = await waitType(ws, 'error');
  assert.equal(err.payload.code, 'unpaired');
  ws.close();
});

test('hub isolation, pair, fwd, offline, revoke', async () => {
  const inviteA = relay.store.createInvite({ note: 'a' }).code;
  const inviteB = relay.store.createInvite({ note: 'b' }).code;
  const hubA = { hubId: 'hub-aaa-111', hubSecret: 'secret-aaaa-aaaa-aaaa' };
  const hubB = { hubId: 'hub-bbb-222', hubSecret: 'secret-bbbb-bbbb-bbbb' };

  const hubWsA = await registerHub(hubA, inviteA);
  const hubWsB = await registerHub(hubB, inviteB);

  const noInvite = await openWs(wsBase);
  noInvite.send(JSON.stringify({
    v: 1,
    type: 'register_hub',
    hubId: 'hub-ccc-333',
    payload: { hubSecret: 'secret-cccc-cccc-cccc' }
  }));
  const inviteErr = await waitType(noInvite, 'error');
  assert.equal(inviteErr.payload.code, 'invite_required');
  noInvite.close();

  const pairA = await issuePair(hubA);
  const pairB = await issuePair(hubB);
  const deviceA = await json('POST', '/api/relay/pair', { code: pairA.code });
  const deviceB = await json('POST', '/api/relay/pair', { code: pairB.code });
  assert.equal(deviceA.hubId, hubA.hubId);
  assert.equal(deviceB.hubId, hubB.hubId);

  const phoneA = await openWs(wsBase, deviceA.deviceToken);
  const phoneB = await openWs(wsBase, deviceB.deviceToken);

  const seenB = [];
  phoneB.on('message', (buf) => seenB.push(JSON.parse(String(buf))));

  phoneA.send(JSON.stringify({
    v: 1,
    type: 'fwd',
    hubId: hubA.hubId,
    payload: { type: 'send_message', text: 'SECRET_CHAT_BODY' }
  }));
  const toHubA = await waitType(hubWsA, 'fwd');
  assert.equal(toHubA.hubId, hubA.hubId);
  assert.equal(toHubA.payload.type, 'send_message');

  phoneA.send(JSON.stringify({
    v: 1,
    type: 'fwd',
    hubId: hubB.hubId,
    payload: { type: 'send_message', text: 'CROSS_HUB' }
  }));
  const mismatch = await waitType(phoneA, 'error');
  assert.equal(mismatch.payload.code, 'hub_mismatch');

  hubWsA.send(JSON.stringify({
    v: 1,
    type: 'fwd',
    hubId: hubA.hubId,
    payload: { type: 'thread_update', text: 'FROM_A' }
  }));
  const toPhoneA = await waitType(phoneA, 'fwd');
  assert.equal(toPhoneA.payload.type, 'thread_update');

  await sleep(50);
  assert.equal(seenB.some((m) => m.type === 'fwd'), false);

  const status = await json('GET', '/api/relay/hubs', null, deviceA.deviceToken);
  assert.equal(status.hubs[0].hubId, hubA.hubId);
  assert.equal(status.hubs[0].online, true);

  hubWsA.close();
  const offline = await waitType(phoneA, 'hub_offline', 2000);
  assert.equal(offline.hubId, hubA.hubId);
  assert.equal(offline.type, 'hub_offline');

  await json('POST', '/api/relay/revoke', {}, deviceA.deviceToken);
  const revoked = await raw('GET', '/api/relay/hubs', null, deviceA.deviceToken);
  assert.equal(revoked.status, 403);

  const closed = await new Promise((resolve) => {
    if (phoneA.readyState === WebSocket.CLOSED) {
      resolve(true);
      return;
    }
    phoneA.once('close', () => resolve(true));
    setTimeout(() => resolve(phoneA.readyState === WebSocket.CLOSED), 500);
  });
  assert.equal(closed, true);

  const audit = fs.readFileSync(path.join(dataDir, 'audit.ndjson'), 'utf8');
  assert.equal(audit.includes('SECRET_CHAT_BODY'), false);
  assert.equal(audit.includes('FROM_A'), false);
  assert.match(audit, /connected_hub/);
  assert.match(audit, /pair_success/);

  phoneB.close();
  hubWsB.close();
});

test('hub can list and kick its own devices', async () => {
  const invite = relay.store.createInvite({ note: 'kick' }).code;
  const hub = { hubId: 'hub-kick-555', hubSecret: 'secret-kkkk-kkkk-kkkk' };
  const hubWs = await registerHub(hub, invite);
  const pair = await issuePair(hub);
  const device = await json('POST', '/api/relay/pair', { code: pair.code });
  const listed = await json('GET', '/api/relay/devices', null, null, {
    authorization: `Hub ${hub.hubId}:${hub.hubSecret}`
  });
  assert.equal(listed.devices.some((d) => !d.revokedAt), true);
  const other = await raw('GET', '/api/relay/devices', null, null, {
    authorization: 'Hub hub-kick-555:wrong-secret-xxxxx'
  });
  assert.equal(other.status, 401);
  await json('POST', '/api/relay/kick', { deviceId: listed.devices[0].id }, null, {
    authorization: `Hub ${hub.hubId}:${hub.hubSecret}`
  });
  const after = await json('GET', '/api/relay/devices', null, null, {
    authorization: `Hub ${hub.hubId}:${hub.hubSecret}`
  });
  assert.ok(after.devices[0].revokedAt);
  hubWs.close();
});

test('hub can request a pair code over websocket', async () => {
  const invite = relay.store.createInvite({ note: 'qr' }).code;
  const hub = { hubId: 'hub-qr-444', hubSecret: 'secret-qqqq-qqqq-qqqq' };
  const hubWs = await registerHub(hub, invite);
  hubWs.send(JSON.stringify({ v: 1, type: 'request_pair_code', hubId: hub.hubId, payload: {} }));
  const issued = await waitType(hubWs, 'pair_code');
  assert.ok(issued.payload.code);
  assert.equal(typeof issued.payload.expiresAtMs, 'number');
  const device = await json('POST', '/api/relay/pair', { code: issued.payload.code });
  assert.equal(device.hubId, hub.hubId);
  hubWs.close();
});

test('hub can only push to its own registration ids', async () => {
  const calls = [];
  relay.config.jpushAppKey = 'test-key';
  relay.config.jpushMasterSecret = 'test-secret';
  relay.config.jpushFetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true };
  };

  const inviteA = relay.store.createInvite({ note: 'push-a' }).code;
  const inviteB = relay.store.createInvite({ note: 'push-b' }).code;
  const hubA = { hubId: 'hub-push-a', hubSecret: 'secret-push-aaaa-aaaa' };
  const hubB = { hubId: 'hub-push-b', hubSecret: 'secret-push-bbbb-bbbb' };
  const hubWsA = await registerHub(hubA, inviteA);
  const hubWsB = await registerHub(hubB, inviteB);

  hubWsA.send(JSON.stringify({
    v: 1,
    type: 'push_register',
    hubId: hubA.hubId,
    payload: { registrationId: 'ridAAAA1111' }
  }));
  const regA = await waitType(hubWsA, 'push_register');
  assert.equal(regA.payload.ok, true);

  hubWsB.send(JSON.stringify({
    v: 1,
    type: 'push_register',
    hubId: hubB.hubId,
    payload: { registrationId: 'ridBBBB2222' }
  }));
  await waitType(hubWsB, 'push_register');

  hubWsA.send(JSON.stringify({
    v: 1,
    type: 'push_send',
    hubId: hubA.hubId,
    payload: { title: '审批', body: '需要批准', tag: 'codex-approval-1' }
  }));
  const sent = await waitType(hubWsA, 'push_send');
  assert.equal(sent.payload.ok, true);
  assert.equal(sent.payload.n, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].audience.registration_id, ['ridAAAA1111']);
  assert.equal(calls[0].notification.android.title, '审批');

  const phone = await openWs(wsBase);
  phone.send(JSON.stringify({
    v: 1,
    type: 'push_send',
    payload: { title: 'x', body: 'y' }
  }));
  const denied = await waitType(phone, 'error');
  assert.equal(denied.payload.code, 'unauthorized');
  phone.close();
  hubWsA.close();
  hubWsB.close();
});

async function registerHub(hub, inviteCode) {
  const ws = await openWs(wsBase);
  ws.send(JSON.stringify({
    v: 1,
    type: 'register_hub',
    hubId: hub.hubId,
    payload: { hubSecret: hub.hubSecret, inviteCode }
  }));
  const ack = await waitType(ws, 'register_hub');
  assert.equal(ack.payload.ok, true);
  return ws;
}

async function issuePair(hub) {
  return json('POST', '/api/relay/pair-code', null, null, {
    authorization: `Hub ${hub.hubId}:${hub.hubSecret}`
  });
}

function openWs(url, token) {
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

function waitType(ws, type, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const onMsg = (buf) => {
      const msg = JSON.parse(String(buf));
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    };
    ws.on('message', onMsg);
  });
}

async function json(method, pathname, body, token, extraHeaders = {}) {
  const res = await raw(method, pathname, body, token, extraHeaders);
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${pathname} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function raw(method, pathname, body, token, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined && body !== null) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body)
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
