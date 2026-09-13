import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppServerClient, CodexAppServer } from './appserver.js';
import { CodexIpcClient } from './ipc-client.js';
import { getHandoffCapabilities, handoffThread } from './writer-handoff.js';
import { getExecutionState, resolveLiveStatus, threadLooksLive } from './turn-status.js';
import { shouldReleaseIdleWriterLocks } from './idle-release.js';

const child = () => ({ exitCode: null, kill() {}, stdin: { write() {} } });
function owned(...ids) {
  const server = new CodexAppServer({ codexPath: 'not-a-real-binary' });
  server.client.child = child();
  for (const id of ids) { server.ownedThreads.add(id); server._recordStatus(id, { type: 'idle' }); }
  return server;
}

test('exit clears owned, turn, approvals, user input and access state without responding', () => {
  const server = owned('a');
  const replies = [];
  server.client.respond = (...args) => replies.push(args);
  server.currentTurnByThread.set('a', 'turn');
  server.threadAccessSettings.set('a', {});
  server._onServerRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } });
  server._onServerRequest({ id: 2, method: 'item/tool/requestUserInput', params: { threadId: 'a', questions: [] } });
  const closed = [];
  server.on('approval-closed', (e) => closed.push(e.reason));
  server.on('user-input-closed', (e) => closed.push(e.reason));
  server.client._disconnected(server.client.child, { code: 1 });
  for (const map of [server.ownedThreads, server.currentTurnByThread, server.pendingApprovals, server.pendingUserInputs, server.threadAccessSettings, server.runtimeByThread]) assert.equal(map.size, 0);
  assert.deepEqual(closed, ['disconnected', 'disconnected']);
  assert.deepEqual(replies, []);
  assert.equal(server.respondUserInput(2, { answers: {} }).code, 'not_found');
});

test('late old-process exit does not tear down replacement or its pending requests', () => {
  const client = new AppServerClient({ codexPath: 'unused' });
  const old = child();
  const current = child();
  client.child = current;
  client.pending.set(1, { reject() { assert.fail('new request rejected'); } });
  client._disconnected(old, { code: 0 });
  assert.equal(client.child, current);
  assert.equal(client.pending.size, 1);
});

test('authoritative runtime beats stale/fresh rollout and generic errors do not mean idle', () => {
  const server = owned('a');
  server._onNotification({ method: 'turn/started', params: { threadId: 'a', turn: { id: 'new' } } });
  server._onNotification({ method: 'error', params: { threadId: 'a' } });
  server._onNotification({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'old' } } });
  assert.equal(server.currentTurnByThread.get('a'), 'new');
  const active = server.runtimeStatus('a');
  assert.equal(threadLooksLive({ open: true }, { mtimeMs: 1 }, 1_000_000, active), true);
  assert.equal(resolveLiveStatus('idle', { runtime: active }), 'working');
  server._onNotification({ method: 'thread/status/changed', params: { threadId: 'a', status: { type: 'idle' } } });
  assert.equal(threadLooksLive({ open: true }, { mtimeMs: 1_000_000 }, 1_000_001, server.runtimeStatus('a')), false);
  assert.equal(resolveLiveStatus('waiting_approval', { runtime: server.runtimeStatus('a') }), 'idle');
  assert.equal(getExecutionState({ tail: { open: true }, stats: { mtimeMs: Date.now() } }).known, false);
});

test('handoff is global idle only; other tasks, unknown runtime and inflight block', () => {
  const server = owned('a', 'b');
  const cap = getHandoffCapabilities(server);
  assert.equal(cap.perThreadWriterRelease, false);
  assert.equal(cap.unsubscribeProtocol, null);
  server.currentTurnByThread.set('b', 'long-running');
  let result = handoffThread({ client: server, threadId: 'a' });
  assert.equal(result.code, 'other_threads_busy');
  assert.deepEqual(result.blockingThreadIds, ['b']);
  server.currentTurnByThread.clear();
  server.runtimeByThread.delete('b');
  assert.equal(handoffThread({ client: server, threadId: 'a' }).code, 'runtime_unknown');
  server._recordStatus('b', { type: 'idle' });
  assert.equal(handoffThread({ client: server, threadId: 'a', inflight: 1 }).code, 'inflight_actions');
  server.client.pending.set(2, {});
  assert.equal(handoffThread({ client: server, threadId: 'a' }).code, 'inflight_actions');
  server.client.pending.clear();
  server.client.request = () => assert.fail('handoff must not send unsubscribe or other RPC');
  result = handoffThread({ client: server, threadId: 'a' });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'global');
  assert.equal(result.writerReleaseConfirmed, false);
  assert.deepEqual(result.releasedThreadIds, ['a', 'b']);
  assert.equal(server.ownedThreads.size, 0);
});

test('automatic idle release accepts authoritative states and fails closed on unknown', () => {
  const base = { ownedCount: 1, ownedBusy: true, lastActivityAt: 0, now: 100, config: { enabled: true, idleHours: 1, idleMs: 1 } };
  assert.equal(shouldReleaseIdleWriterLocks({ ...base, runtimeStates: [{ known: true, busy: false }] }).release, true);
  assert.equal(shouldReleaseIdleWriterLocks({ ...base, ownedBusy: false, runtimeStates: [{ known: false, busy: null }] }).reason, 'runtime_unknown');
});

test('stable clientUserMessageId is forwarded in local start and steer and IPC start', async () => {
  const server = owned('a');
  const requests = [];
  server.client.request = async (method, params) => { requests.push({ method, params }); return { turn: { id: 'turn' } }; };
  await server.sendUserTurn({ threadId: 'a', text: 'hello', clientUserMessageId: 'stable' });
  await server.steerTurn({ threadId: 'a', text: 'hello', clientUserMessageId: 'stable' });
  assert.deepEqual(requests.map((r) => r.params.clientUserMessageId), ['stable', 'stable']);
  const ipc = new CodexIpcClient();
  ipc.ensureConnected = async () => {};
  ipc.request = async (method, params) => { assert.equal(params.turnStartParams.clientUserMessageId, 'stable'); return { resultType: 'success', result: {} }; };
  await ipc.startTurn('a', [], 'owner', { clientUserMessageId: 'stable' });
});

test('typed user input is validated, blocks handoff, and answers exactly once', () => {
  const server = owned('a');
  const replies = [];
  server.client.respond = (...r) => replies.push(r);
  server._onServerRequest({ id: 9, method: 'item/tool/requestUserInput', params: { threadId: 'a', isBlocking: true, questions: [{ id: 'choice', question: 'Which?' }] } });
  assert.equal(server.runtimeStatus('a').status, 'waiting_user_input');
  assert.equal(handoffThread({ client: server, threadId: 'a' }).code, 'thread_busy');
  assert.equal(server.respondUserInput(9, {}).code, 'invalid_answers');
  assert.equal(server.respondUserInput(9, { answers: {} }).code, 'invalid_answers');
  const response = { answers: { choice: { answers: ['first'] } } };
  assert.equal(server.respondUserInput(9, response).ok, true);
  assert.deepEqual(replies, [[9, response]]);
  assert.equal(server.respondUserInput(9, response).code, 'not_found');
});

function encode(message) {
  const body = Buffer.from(JSON.stringify(message));
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}
function fakeSocket(messages) {
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroy = () => { socket.writable = false; socket.emit('close'); };
  socket.write = (data) => {
    const msg = JSON.parse(data.subarray(4).toString()); messages.push(msg);
    if (msg.type === 'request') queueMicrotask(() => socket.emit('data', encode({ requestId: msg.requestId, resultType: 'success', handledByClientId: 'new-owner', result: msg.method === 'initialize' ? { clientId: 'new-client' } : {} })));
    if (msg.type === 'broadcast') queueMicrotask(() => socket.emit('data', encode({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: msg.params.conversationId, change: { conversationState: { requests: [] } } } })));
    return true;
  };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

test('IPC close clears caches and pending waiters, reconnect rediscovers and resubscribes', async () => {
  const messages = [];
  const ipc = new CodexIpcClient({ createConnection: () => fakeSocket(messages) });
  await ipc.follow('a');
  ipc.owners.set('a', 'old-owner');
  ipc.ingestSnapshot('a', { conversationState: { requests: [{ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} }] } });
  const old = ipc.socket;
  let cleared = 0;
  ipc.onApprovalCleared = () => cleared++;
  old.destroy();
  assert.equal(ipc.owners.size, 0);
  assert.equal(ipc.followed.size, 0);
  assert.equal(ipc.pendingByThread.size, 0);
  assert.equal(ipc.runtimeStatus('a').known, false);
  assert.equal(cleared, 1);
  messages.length = 0;
  await ipc.ensureConnected();
  assert.ok(messages.some((m) => m.method === 'thread-owner-discovery'));
  assert.ok(messages.some((m) => m.method === 'thread-stream-following-changed'));
  assert.equal(ipc.owners.get('a'), 'new-owner');
  const current = ipc.socket;
  old.emit('close');
  assert.equal(ipc.socket, current);
  current.destroy();
});

test('IPC partial deltas do not falsely clear pending approvals or imply idle', () => {
  const ipc = new CodexIpcClient();
  ipc.ingestSnapshot('a', { conversationState: { requests: [{ id: 1, method: 'item/commandExecution/requestApproval' }] } });
  ipc.ingestSnapshot('a', { type: 'delta' });
  assert.equal(ipc.pendingRequestIds('a')[0], '1');
  assert.equal(ipc.runtimeStatus('a').busy, true);
  ipc.ingestSnapshot('a', { conversationState: { requests: [] } });
  assert.equal(ipc.runtimeStatus('a').known, false);
});

test('resume response arriving after exit cannot resurrect owned state', async () => {
  const server = owned('a');
  let finish;
  server.client.request = () => new Promise((resolve) => { finish = resolve; });
  const pending = server.resumeThread('b');
  server.client._disconnected(server.client.child, { code: 1 });
  finish({ thread: { id: 'b', status: { type: 'idle' } } });
  await assert.rejects(pending, /connection changed/);
  assert.equal(server.ownedThreads.size, 0);
});

test('completion before start response does not resurrect a completed turn', async () => {
  const server = owned('a');
  server.client.request = async () => {
    server._onNotification({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'turn' } } });
    return { turn: { id: 'turn' } };
  };
  await server.sendUserTurn({ threadId: 'a', text: 'x' });
  assert.equal(server.currentTurnByThread.size, 0);
  assert.equal(server.runtimeStatus('a').busy, false);
});

test('resume idle snapshot cannot overwrite a newer authoritative active notification', async () => {
  const server = owned('a');
  server.client.request = async () => {
    server._onNotification({ method: 'turn/started', params: { threadId: 'a', turn: { id: 'new' } } });
    return { thread: { id: 'a', status: { type: 'idle' } } };
  };
  await server.resumeThread('a');
  assert.equal(server.runtimeStatus('a').busy, true);
  assert.equal(server.currentTurnByThread.get('a'), 'new');
  assert.equal(handoffThread({ client: server, threadId: 'a' }).code, 'thread_busy');
});

test('terminal turn/start response is authoritative idle without a separate notification', async () => {
  const server = owned('a');
  server.client.request = async () => ({ turn: { id: 'turn', status: 'completed' } });
  await server.sendUserTurn({ threadId: 'a', text: 'x' });
  assert.equal(server.runtimeStatus('a').busy, false);
});

test('nonblocking input still prevents dropping a request during global release', () => {
  const server = owned('a');
  server._onServerRequest({ id: 'input', method: 'item/tool/requestUserInput', params: { threadId: 'a', isBlocking: false, questions: [] } });
  assert.doesNotThrow(() => JSON.stringify([...server.pendingUserInputs.values()]));
  assert.equal(handoffThread({ client: server, threadId: 'a' }).code, 'thread_busy');
  server.stop();
});

test('IPC initialization failure destroys socket and clears caches', async () => {
  const messages = [];
  let socket;
  const ipc = new CodexIpcClient({ createConnection: () => (socket = fakeSocket(messages)) });
  ipc.request = async () => ({ resultType: 'error', error: 'rejected' });
  await assert.rejects(ipc.ensureConnected(), /initialize failed/);
  assert.equal(ipc.socket, null);
  assert.equal(socket.writable, false);
  assert.equal(ipc.connectPromise, null);
});

test('IPC disconnect settles follow waiters and rejected requests immediately', async () => {
  const ipc = new CodexIpcClient();
  const socket = { writable: true, write() {} };
  ipc.socket = socket;
  ipc.clientId = 'client';
  const request = ipc.request('unanswered', {});
  let followed = false;
  ipc.followWaiters.set('a', () => { followed = true; });
  ipc._disconnected(socket);
  await assert.rejects(request, /closed/);
  assert.equal(followed, true);
  assert.equal(ipc.pending.size, 0);
  assert.equal(ipc.followWaiters.size, 0);
});

test('IPC immediate write errors clear pending request timer and map', async () => {
  const ipc = new CodexIpcClient();
  await assert.rejects(ipc.request('test', {}), /closed/);
  assert.equal(ipc.pending.size, 0);
});
