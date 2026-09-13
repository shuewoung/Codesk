import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startFixture } from './ux-fixture.mjs';

// No browser, real Hub, external DNS or user credentials. Every socket targets our own port.
test('isolated UX fixture: origin guard, auth, protocol, files, chunks and faults', async t => {
  const f = await startFixture({ port: 0 });
  t.after(() => f.close());
  const host = new URL(f.origin).host;
  const request = (pathname, { method = 'GET', data, headers = {}, canonical = true } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: pathname, method, headers: { ...(canonical ? { Host: host } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), json: () => JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  const setupHeaders = { 'x-fixture-control': f.controlToken };
  const control = data => request('/__fixture/control', { method: 'POST', headers: setupHeaders, data });
  assert.equal((await request('/', { canonical: false })).headers.location, f.origin + '/');
  assert.equal((await request('/__fixture/state')).status, 403);
  assert.equal((await request('/__fixture/state', { headers: { ...setupHeaders, Origin: f.origin } })).status, 403);
  const index = await request('/');
  assert.ok([200, 503].includes(index.status));
  const csp = index.headers['content-security-policy'];
  assert.ok(csp.includes(`connect-src ${f.origin} ${f.origin.replace('http:', 'ws:')};`));
  assert.ok(!csp.includes('18990') && !csp.includes('codesk.icu'));
  assert.equal((await request('/host.html')).status, 404);
  assert.equal((await request('/api/discover')).json().localTrusted, false);
  assert.equal((await request('/api/auth/login', { method: 'POST', data: { code: '0000' } })).status, 401);
  const login = await request('/api/auth/login', { method: 'POST', data: { password: f.code } });
  const token = login.json().token;
  assert.equal(login.status, 200);
  assert.ok(token.startsWith('ux-only-'));
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/ws?token=${token}`, { headers: { Host: host, Origin: f.origin } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let seq = 0;
  function rpc(type, data = {}, terminal) {
    return new Promise((resolve, reject) => {
      const requestId = `test-${++seq}`; const messages = [];
      const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`timeout ${type}`)); }, 3000);
      function onMessage(raw) { const m = JSON.parse(String(raw)); if (m.requestId !== requestId) return; messages.push(m); if (!terminal || m.type === terminal) { clearTimeout(timer); ws.off('message', onMessage); resolve(terminal ? messages : m); } }
      ws.on('message', onMessage); ws.send(JSON.stringify({ type, requestId, ...data }));
    });
  }
  const list = await rpc('get_threads');
  assert.deepEqual(list.data.threads.map(t => t.id), ['ux-alpha', 'ux-beta']);
  const a = { threadId: 'ux-alpha' };
  const initial = await rpc('get_thread_history', a);
  const full = await rpc('get_thread_history', { ...a, all: true });
  assert.equal(initial.data.hasMore, true); assert.equal(full.data.full, true); assert.ok(full.data.items.length > initial.data.items.length);
  const root = await rpc('get_workspace_tree', { ...a, path: 'C:/UX-Fixture/Alpha' });
  assert.ok(root.tree.some(n => n.name === 'outputs' && n.hasChildren));
  const nested = await rpc('get_workspace_tree', { ...a, path: 'C:/UX-Fixture/Alpha/outputs' });
  assert.ok(nested.tree.some(n => n.name === 'chunk-test.txt'));
  const listing = await rpc('list_artifacts', a);
  assert.ok(listing.artifacts.every(x => x.threadId === 'ux-alpha' && x.source === 'assistant_message'));
  assert.ok(listing.recentDocuments.some(x => x.name === 'candidate.md' && x.source === 'recent_document'));
  const p = 'C:/UX-Fixture/Alpha/outputs/chunk-test.txt';
  const preview = await rpc('get_file', { ...a, path: p }); assert.equal(preview.truncated, true);
  const chunks = await rpc('download_file', { ...a, path: p }, 'download_complete');
  const assembled = Buffer.concat(chunks.filter(m => m.type === 'download_chunk').map(m => Buffer.from(m.content, 'base64')));
  assert.equal(chunks[0].chunkSize, 262144); assert.ok(chunks[0].totalChunks >= 3);
  assert.equal(assembled.length, chunks[0].totalBytes);
  assert.equal(createHash('sha256').update(assembled).digest('hex'), chunks.at(-1).sha256);
  const raw = await request('/api/file?path=' + encodeURIComponent(p), { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(raw.bytes, assembled); assert.equal(raw.headers['x-file-sha256'], chunks.at(-1).sha256);
  const denied = await rpc('get_file', { ...a, path: 'C:/UX-Fixture/Beta/README.md' }); assert.ok(denied.error);
  assert.equal((await request('/api/file?path=C:/Users/credentials', { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  await control({ searchDelays: { slow: 150 } });
  const order = [];
  const slow = rpc('search_workspace', { ...a, q: 'slow' }).then(m => { order.push('slow'); return m; });
  const fast = rpc('search_workspace', { threadId: 'ux-beta', q: 'README' }).then(m => { order.push('fast'); return m; });
  const [s, b] = await Promise.all([slow, fast]); assert.deepEqual(order, ['fast', 'slow']); assert.ok(s.hits[0].path.includes('/Alpha/')); assert.ok(b.hits[0].path.includes('/Beta/'));
  await control({ errors: { get_workspace_tree: '模拟文件树失败' }, downloadMode: 'bad-hash' });
  assert.equal((await rpc('get_workspace_tree', a)).error, '模拟文件树失败');
  assert.equal((await rpc('download_file', { ...a, path: p }, 'download_complete')).at(-1).sha256, '0'.repeat(64));
  const audit = (await request('/__fixture/state', { headers: setupHeaders })).json();
  assert.ok(audit.audit.some(x => x.type === 'download_file'));
  assert.ok(!JSON.stringify(audit.audit).includes(token));
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json().success, true);
  assert.equal((await request('/api/file?path=' + encodeURIComponent(p), { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  ws.terminate();
});

// Black-box wire assertions: never imports production handlers or inspects their source.
test('workbench fixture: idempotency, reconnect recovery, queue, CAS, ownership and user input', async t => {
  const f = await startFixture({ port: 0 });
  t.after(() => f.close());
  const host = new URL(f.origin).host;
  const request = (pathname, data, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: pathname, method: data ? 'POST' : 'GET', headers: { Host: host, ...headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
  const control = async data => { const r = await request('/__fixture/control', data, { 'x-fixture-control': f.controlToken }); assert.equal(r.status, 200); };
  // Preparation only: input exists before login; no setup injection during navigation.
  await control({ executionStates: { 'ux-beta': { location: 'hub', status: 'idle' } }, pendingInputThreadId: 'ux-beta' });
  const { data: { token } } = await request('/api/auth/login', { code: f.code });
  let seq = 0;
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/ws?token=${token}`, { headers: { Host: host, Origin: f.origin } });
    const events = [];
    ws.on('message', raw => events.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const wait = async predicate => {
      for (let n = 0; n < 500; n++) { const found = events.find(predicate); if (found) return found; await new Promise(r => setTimeout(r, 10)); }
      throw new Error('Timed out waiting for fixture wire message');
    };
    const hello = await wait(m => m.type === 'hello');
    return { ws, events, hello, wait, rpc: async (type, data = {}) => {
      const requestId = data.requestId || `wb-${++seq}`;
      const start = events.length;
      ws.send(JSON.stringify({ type, requestId, threadId: 'ux-alpha', ...data }));
      return wait(m => events.indexOf(m) >= start && m.requestId === requestId && !['thread_update', 'user_input_resolved'].includes(m.type));
    } };
  }
  let client = await connect();
  assert.equal(client.hello.hubId, 'ux-fixture-hub');
  assert.equal(client.hello.modelIsSimulated, true);
  for (const k of ['query_command', 'get_execution_state', 'handoff_thread', 'queue_message', 'list_queue', 'cancel_queued_message', 'get_draft', 'save_draft', 'get_git_status', 'get_git_diff', 'send_user_input']) assert.equal(client.hello.capabilities[k], true);
  // Discard startup pushes as a login Session reset can do, then navigate Alpha -> Beta.
  await client.wait(m => m.type === 'user_input_request');
  client.events.length = 0;
  assert.deepEqual((await client.rpc('get_execution_state')).executionState.pendingUserInputs, []);
  assert.equal(client.events.some(m => m.type === 'user_input_request'), false);
  const initial = await client.rpc('get_thread_history', { all: true });
  assert.equal(initial.data.status, 'idle'); assert.equal(initial.data.isActive, false);
  const seedList = await client.rpc('get_threads');
  assert.equal(seedList.data.threads[0].isActive, false); assert.equal(seedList.data.threads[0].status, 'idle');
  assert.equal(seedList.data.threads[1].status, 'waiting_input'); assert.equal(seedList.data.threads[1].working, false);
  await client.rpc('get_thread_history', { threadId: 'ux-beta' });
  const betaState = await client.rpc('get_execution_state', { threadId: 'ux-beta' });
  const betaInput = await client.wait(m => m.type === 'user_input_request');
  assert.equal(betaState.executionState.status, 'waiting_input');
  assert.equal(betaState.executionState.pendingUserInputs.length, 1);
  assert.equal(betaState.executionState.pendingUserInputs[0].requestId, betaInput.requestId);
  assert.equal(betaInput.threadId, 'ux-beta');
  assert.notEqual(betaInput.requestId, betaState.requestId);
  assert.ok(client.events.indexOf(betaState) < client.events.indexOf(betaInput));
  // Repeated visits and reconnects retrieve the same stable pending RPC, not a new input.
  client.ws.terminate(); client = await connect();
  await client.wait(m => m.type === 'user_input_request'); client.events.length = 0;
  const reloaded = await client.rpc('get_execution_state', { threadId: 'ux-beta' });
  assert.deepEqual(reloaded.executionState.pendingUserInputs, betaState.executionState.pendingUserInputs);
  assert.equal((await client.wait(m => m.type === 'user_input_request')).requestId, betaInput.requestId);
  assert.equal((await client.rpc('send_user_input', { threadId: 'ux-beta', inputRequestId: betaInput.requestId, answers: { 'fixture-choice': { answers: ['Markdown'] } } })).result.ok, true);
  await client.wait(m => m.type === 'user_input_resolved'); client.events.length = 0;
  const cleared = await client.rpc('get_execution_state', { threadId: 'ux-beta' });
  assert.deepEqual(cleared.executionState.pendingUserInputs, []); assert.equal(cleared.executionState.status, 'idle');
  assert.equal(client.events.some(m => m.type === 'user_input_request'), false);
  const clearedList = await client.rpc('get_threads');
  assert.equal(clearedList.data.threads[1].status, 'idle'); assert.equal(clearedList.data.threads[1].isActive, false);
  assert.equal((await client.rpc('get_thread_history', { threadId: 'ux-beta' })).data.status, 'idle');
  await control({ commandDelayMs: 200 });
  const payload = { requestId: 'send-once', clientUserMessageId: 'user-once', text: 'Synthetic reconnect message' };
  client.ws.send(JSON.stringify({ type: 'send_message', threadId: 'ux-alpha', ...payload }));
  let running;
  for (let n = 0; n < 20; n++) { running = await client.rpc('query_command', { commandRequestId: payload.requestId }); if (running.command?.status === 'running') break; }
  assert.equal(running.command.status, 'running');
  assert.equal((await client.rpc('get_execution_state')).executionState.status, 'running');
  const activeList = await client.rpc('get_threads');
  assert.equal(activeList.data.threads[0].status, 'working'); assert.equal(activeList.data.threads[0].isActive, true); assert.equal(activeList.data.threads[0].working, true);
  assert.equal((await client.rpc('get_thread_history')).data.status, 'working');
  await control({ disconnect: true });
  client = await connect();
  assert.equal(client.hello.hubId, 'ux-fixture-hub');
  const replay = await client.rpc('send_message', payload);
  assert.equal(replay.commandStatus, 'succeeded');
  assert.equal(replay.clientUserMessageId, 'user-once');
  const query = await client.rpc('query_command', { requestId: 'send-once' });
  assert.equal(query.type, 'command_status'); assert.equal(query.command.status, 'succeeded'); assert.equal(query.threadId, 'ux-alpha');
  const conflict = await client.rpc('send_message', { ...payload, text: 'changed' });
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(conflict.requestId, 'send-once');
  const full = await client.rpc('get_thread_history', { all: true });
  assert.equal(full.data.status, 'idle'); assert.equal(full.data.isActive, false);
  const settledList = await client.rpc('get_threads');
  assert.equal(settledList.data.threads[0].status, 'idle'); assert.equal(settledList.data.threads[0].isActive, false);
  assert.equal(full.data.items.length, initial.data.items.length + 2);
  assert.equal(full.data.items.filter(i => i.id === 'user-once').length, 1);
  assert.match(full.data.items.at(-1).content, /模拟回复/);
  assert.equal((await client.rpc('query_command', { requestId: 'missing-command' })).command, null);

  // Desktop-owned threads cannot request the reverse (Desktop -> Hub) handoff.
  assert.equal((await client.rpc('get_execution_state')).executionState.canHandoff, false);
  const desktopDenied = await client.rpc('handoff_thread');
  assert.equal(desktopDenied.result.ok, false); assert.equal(desktopDenied.result.releaseRequested, false);
  await control({ executionStates: { 'ux-alpha': { location: 'hub', status: 'idle' } } });
  for (const blocked of ['running', 'unknown', 'waiting_approval', 'waiting_input']) {
    await control({ executionStates: { 'ux-beta': { location: 'hub', status: blocked } } });
    assert.equal((await client.rpc('get_execution_state')).executionState.canHandoff, false);
    const denied = await client.rpc('handoff_thread');
    assert.equal(denied.result.ok, false); assert.equal(denied.result.writerReleaseConfirmed, false);
  }
  // A busy Desktop-owned lane does not block releasing idle Hub-owned lanes.
  await control({ executionStates: { 'ux-beta': { location: 'desktop', status: 'running' } } });
  assert.equal((await client.rpc('get_execution_state')).executionState.canHandoff, true);
  const handoff = await client.rpc('handoff_thread');
  assert.equal(handoff.type, 'handoff_result'); assert.equal(handoff.result.ok, true);
  assert.equal(handoff.result.releaseRequested, true); assert.equal(handoff.result.writerReleaseConfirmed, false);
  assert.equal(handoff.executionState.location, 'unknown'); assert.equal(handoff.executionState.status, 'unknown');
  assert.equal(handoff.executionState.canHandoff, false);
  assert.match(handoff.executionState.reason, /未确认写锁释放或桌面接管/);
  assert.equal((await client.rpc('get_execution_state')).executionState.location, 'unknown');
  await control({ executionStates: { 'ux-alpha': { location: 'hub', status: 'idle' }, 'ux-beta': { location: 'desktop', status: 'idle' } } });

  const queued = { requestId: 'queue-once', clientUserMessageId: 'queued-user', text: 'Never dispatch cancelled item', images: ['virtual.png'] };
  const q1 = await client.rpc('queue_message', queued);
  assert.equal(q1.queue.items[0].queueId, queued.requestId);
  assert.equal((await client.rpc('queue_message', queued)).queue.items.length, 1);
  assert.equal((await client.rpc('queue_message', { ...queued, text: 'changed' })).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await client.rpc('cancel_queued_message', { threadId: 'ux-beta', queueId: queued.requestId })).code, 'NOT_FOUND');
  assert.equal((await client.rpc('cancel_queued_message', { queueId: queued.requestId })).queue.items[0].status, 'cancelled');
  await client.rpc('queue_message', { requestId: 'queue-dispatch', clientUserMessageId: 'dispatch-user', text: 'Explicit simulated drain' });
  await control({ commandDelayMs: 0, drainQueue: true });
  const queue = await client.rpc('list_queue');
  assert.deepEqual(queue.queue.items.map(q => q.status), ['cancelled', 'sent']);
  assert.equal((await client.rpc('query_command', { requestId: 'queue-once' })).command, null);
  assert.equal((await client.rpc('query_command', { requestId: 'queue-dispatch' })).command.status, 'succeeded');
  assert.equal((await client.rpc('cancel_queued_message', { queueId: 'queue-dispatch' })).code, 'QUEUE_NOT_CANCELLABLE');
  assert.deepEqual((await client.rpc('list_queue', { threadId: 'ux-beta' })).queue.items, []);

  const other = await connect();
  const draft = await client.rpc('get_draft'); assert.equal(draft.draft.version, 0);
  const [d1, d2] = await Promise.all([client.rpc('save_draft', { expectedVersion: 0, text: 'A', attachments: [{ name: 'virtual.txt', path: 'C:/UX-Fixture/Alpha/uploads/virtual.txt' }] }), other.rpc('save_draft', { expectedVersion: 0, text: 'B', attachments: [] })]);
  const winner = [d1, d2].find(d => !d.code); const loser = [d1, d2].find(d => d.code);
  assert.equal(loser.code, 'CAS_CONFLICT'); assert.deepEqual(loser.draft, winner.draft); assert.equal(winner.draft.version, 1); assert.ok(winner.draft.updatedAt > 0);
  assert.equal((await other.rpc('get_draft', { threadId: 'ux-beta' })).draft.text, '');
  client.ws.terminate(); client = await connect();
  assert.deepEqual((await client.rpc('get_draft')).draft, winner.draft);
  assert.equal((await client.rpc('list_queue')).queue.items.length, 2);
  for (const type of ['get_git_status', 'get_git_diff']) { const git = await client.rpc(type); assert.equal(git.type, type.replace('get_', '')); assert.equal(git.git.truncated, false); assert.match(git.git.diff, /diff --git/); assert.equal(git.threadId, 'ux-alpha'); }

  await control({ pendingInputThreadId: 'ux-alpha' });
  const input = await client.wait(m => m.type === 'user_input_request');
  assert.equal((await client.rpc('get_execution_state')).executionState.status, 'waiting_input');
  assert.equal((await client.rpc('send_user_input', { inputRequestId: 'wrong', answers: {} })).result.ok, false);
  assert.equal((await client.rpc('send_user_input', { inputRequestId: input.requestId, answers: { 'fixture-choice': { answers: ['Markdown'] } } })).result.ok, true);
  assert.equal((await client.wait(m => m.type === 'user_input_resolved')).requestId, input.requestId);
  for (const outcome of ['failed', 'uncertain']) {
    await control({ commandOutcome: outcome });
    const r = await client.rpc('send_message', { requestId: `outcome-${outcome}`, clientUserMessageId: `user-${outcome}`, text: 'Synthetic fault' });
    assert.equal(r.commandStatus, outcome);
    assert.equal((await client.rpc('query_command', { requestId: `outcome-${outcome}` })).command.status, outcome);
  }
  assert.equal((await client.rpc('get_execution_state')).executionState.status, 'unknown');
  // Accepted command with lost acknowledgment must be queried, not blindly re-executed.
  await control({ commandOutcome: 'succeeded', suppressResponses: ['send_message'], executionStates: { 'ux-alpha': { location: 'hub', status: 'idle' } } });
  client.ws.send(JSON.stringify({ type: 'send_message', threadId: 'ux-alpha', requestId: 'lost-ack', clientUserMessageId: 'lost-ack-user', text: 'Simulated acknowledgment loss' }));
  let recovered;
  for (let n = 0; n < 30; n++) { recovered = await client.rpc('query_command', { commandRequestId: 'lost-ack' }); if (recovered.command?.status === 'succeeded') break; }
  assert.equal(recovered.command.status, 'succeeded');
  assert.equal(client.events.some(m => m.requestId === 'lost-ack' && m.type === 'action_feedback'), false);
  assert.equal((await client.rpc('get_thread_history', { all: true })).data.items.filter(i => i.id === 'lost-ack-user').length, 1);
  await control({ suppressResponses: [] });
  const created = await client.rpc('create_thread');
  assert.equal((await client.rpc('get_execution_state', { threadId: created.threadId })).executionState.location, 'hub');
  assert.equal((await client.rpc('send_message', { threadId: created.threadId, clientUserMessageId: 'new-thread-user', text: 'New virtual thread' })).commandStatus, 'succeeded');
  other.ws.terminate(); client.ws.terminate();
});

test('custom static export preserves origin, CSP and filesystem boundaries', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ux-fixture-export-'));
  const dist = path.join(temp, 'web'); await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Synthetic isolated export</title>');
  await writeFile(path.join(temp, 'outside.txt'), 'Never serve outside export');
  let link = false;
  try { await symlink(path.join(temp, 'outside.txt'), path.join(dist, 'assets', 'escape.txt')); link = true; } catch (e) { if (!['EPERM', 'EACCES'].includes(e.code)) throw e; }
  const f = await startFixture({ port: 0, distDir: dist });
  t.after(async () => { await f.close(); await rm(temp, { recursive: true, force: true }); });
  const get = (pathname, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: f.port, path: pathname, headers: { Host: new URL(f.origin).host, ...headers } }, res => { const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() })); }); req.on('error', reject);
  });
  const index = await get('/'); assert.equal(index.status, 200); assert.match(index.text, /Synthetic isolated export/);
  assert.ok(index.headers['content-security-policy'].includes(`connect-src ${f.origin} ${f.origin.replace('http:', 'ws:')};`));
  assert.equal((await get('/', { Origin: 'http://127.0.0.1:18990' })).status, 403);
  assert.equal((await get('/outside.txt')).status, 404);
  assert.equal((await get('/assets/%2e%2e%2f%2e%2e%2foutside.txt')).status, 403);
  if (link) assert.equal((await get('/assets/escape.txt')).status, 403);
});

test('refuses real Hub, Expo dev and relay ports', async () => {
  for (const port of [18990, 18991, 8787]) await assert.rejects(startFixture({ port }), /isolated port/);
});
