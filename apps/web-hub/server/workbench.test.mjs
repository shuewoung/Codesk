import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { CommandStore } from './command-store.js';
import { createWorkbench, readGit } from './workbench.js';

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesk-workbench-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let count = 0;
  const opts = { dir, hubId: 'hub-stable', send: async () => { count++; return { status: 'success', message: 'accepted' }; }, executionState: async threadId => ({ threadId, location: 'hub', status: 'idle' }), handoff: async () => ({ ok: true }), cwd: () => dir, userInput: async () => ({ ok: true }), ...overrides };
  return { dir, opts, hub: createWorkbench(opts), count: () => count };
}
const send = (id = 'r1', text = 'hello') => ({ type: 'send_message', threadId: 'thread-1', requestId: id, clientUserMessageId: `u-${id}`, text });

test('persistent idempotency reuses results, rejects conflicting payload and client ID reuse', async t => {
  const f = fixture(t);
  const [a,b] = await Promise.all([f.hub.handle(send()), f.hub.handle(send())]);
  assert.equal(a.commandStatus, 'succeeded'); assert.equal(b.commandStatus, 'succeeded'); assert.equal(f.count(), 1);
  assert.equal((await f.hub.handle(send('r1', 'different'))).code, 'IDEMPOTENCY_CONFLICT');
  const restart = createWorkbench(f.opts);
  assert.equal((await restart.handle(send())).commandStatus, 'succeeded'); assert.equal(f.count(), 1);
  const alias = await restart.handle({ ...send(), requestId: 'new-transport-id' });
  assert.equal(alias.commandStatus, 'succeeded'); assert.equal(f.count(), 1);
  assert.equal((await restart.handle({ ...send(), requestId: 'r3', text: 'different' })).code, 'IDEMPOTENCY_CONFLICT');
});

test('restart never replays pending/running command or sending queue item', async t => {
  const f = fixture(t);
  await f.hub.handle(send());
  f.hub.store.data.commands.r1.status = 'running';
  await f.hub.handle({ ...send('q1'), type: 'queue_message' });
  f.hub.store.data.queue.q1.status = 'sending'; f.hub.store.persist();
  const restart = createWorkbench(f.opts);
  assert.equal((await restart.handle(send())).commandStatus, 'uncertain');
  assert.equal((await restart.handle({ type: 'query_command', requestId: 'r1' })).command.status, 'uncertain');
  await restart.drain(); assert.equal(f.count(), 1);
  assert.equal((await restart.handle({ type: 'list_queue', threadId: 'thread-1' })).queue.items[0].status, 'uncertain');
});

test('thread lanes serialize writes but distinct threads can progress', async t => {
  const f = fixture(t); const order = []; let unblock;
  const first = f.hub.store.execute(send(), async () => { order.push('start'); await new Promise(r => { unblock = r; }); order.push('end'); return { status: 'success' }; });
  await new Promise(r => setImmediate(r));
  const second = f.hub.store.execute(send('r2'), async () => { order.push('second'); return {}; });
  await f.hub.store.execute({ ...send('r3'), threadId: 'other' }, async () => { order.push('other'); return {}; });
  assert.deepEqual(order, ['start','other']); unblock(); await Promise.all([first,second]); assert.deepEqual(order, ['start','other','end','second']);
});

test('busy/unknown/approval/input queues wait; cancellation persists; idle drains once', async t => {
  let status = 'running', location = 'hub';
  const f = fixture(t, { executionState: async () => ({ status, location }) });
  await f.hub.handle({ ...send('q1'), type: 'queue_message' });
  for (status of ['running','unknown','waiting_input','waiting_approval']) { await f.hub.drain(); assert.equal(f.count(),0); }
  status = 'idle'; location = 'unknown'; await f.hub.drain(); assert.equal(f.count(),0);
  location = 'hub'; await f.hub.drain(); await f.hub.drain(); assert.equal(f.count(),1);
  await f.hub.handle({ ...send('q2'), type: 'queue_message' });
  await f.hub.handle({ type: 'cancel_queued_message', threadId: 'thread-1', queueId: 'q2' });
  const restart = createWorkbench(f.opts); await restart.drain(); assert.equal(f.count(),1);
  assert.equal((await restart.handle({ type: 'list_queue', threadId: 'thread-1' })).queue.items[1].status, 'cancelled');
});

test('send failure is uncertain and queue never automatically retries', async t => {
  let calls = 0; const f = fixture(t, { send: async () => { calls++; throw new Error('lost ACK'); } });
  await f.hub.handle({ ...send(), type: 'queue_message' });
  await f.hub.drain(); await f.hub.drain(); assert.equal(calls,1);
  assert.equal((await f.hub.handle({ type: 'list_queue', threadId: 'thread-1' })).queue.items[0].status,'uncertain');
});

test('CAS preserves attachment metadata on conflict and restart; validates input', async t => {
  const f = fixture(t); const attachments = [{ path: '/file.pdf', name: '附件.pdf', mime: 'application/pdf', custom: { state: 'uploaded' } }];
  const req = { type: 'save_draft', threadId: 'thread-1', expectedVersion: 0, text: 'draft', attachments };
  assert.equal((await f.hub.handle(req)).draft.version,1);
  const conflict = await f.hub.handle({ ...req, text: 'stale' }); assert.equal(conflict.code,'CAS_CONFLICT'); assert.deepEqual(conflict.draft.attachments,attachments);
  assert.deepEqual((await createWorkbench(f.opts).handle({ type: 'get_draft', threadId: 'thread-1' })).draft.attachments,attachments);
  for (const change of [{ expectedVersion: -1 }, { expectedVersion: 0.5 }, { text: 'x'.repeat(200001) }, { attachments: [null] }, { threadId: '../outside' }]) assert.equal((await f.hub.handle({ ...req, ...change })).code,'INVALID_REQUEST');
});

test('git readonly uses only known cwd, ignores injected shell/path, caps output', async t => {
  const f = fixture(t); execFileSync('git',['init',f.dir],{stdio:'ignore'});
  fs.writeFileSync(path.join(f.dir,'tracked.txt'),'one\n');
  execFileSync('git',['-C',f.dir,'add','tracked.txt']);
  execFileSync('git',['-C',f.dir,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture'],{stdio:'ignore'});
  fs.writeFileSync(path.join(f.dir,'tracked.txt'),'two\n');
  const a = await f.hub.handle({ type:'get_git_status',threadId:'thread-1',cwd:'/',command:'touch HACKED' });
  assert.match(a.git.statusText,/tracked.txt/); assert.ok(a.git.branch); assert.equal(fs.existsSync(path.join(f.dir,'HACKED')),false);
  assert.match((await f.hub.handle({ type:'get_git_diff',threadId:'thread-1' })).git.diff,/\+two/);
  fs.writeFileSync(path.join(f.dir,'tracked.txt'),'x'.repeat(700000));
  const large = await readGit(f.dir,'diff'); assert.equal(large.truncated,true); assert.ok(Buffer.byteLength(large.diff) <= 512*1024);
});

test('git read disables repository clean and process filters without changing config', async t => {
  const f = fixture(t); const git = (...args) => execFileSync('git', ['-C', f.dir, ...args], { stdio: 'pipe' });
  git('init'); fs.writeFileSync(path.join(f.dir, 'tracked.txt'), 'original\n'); git('add', 'tracked.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  fs.writeFileSync(path.join(f.dir, 'tracked.txt'), 'changed\n');
  fs.writeFileSync(path.join(f.dir, '.gitattributes'), 'tracked.txt filter=audit\n');
  const marker = path.join(f.dir, 'FILTER_EXECUTED');
  const script = path.join(f.dir, 'filter.cjs');
  const command = `${JSON.stringify(process.execPath.replace(/\\/g, '/'))} ${JSON.stringify(script.replace(/\\/g, '/'))}`;
  for (const kind of ['clean', 'process']) {
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); ${kind === 'clean' ? "process.stdin.pipe(process.stdout);" : 'process.exit(1);'}`);
    git('config', `filter.audit.${kind}`, command); git('config', 'filter.audit.required', 'false');
    // Demonstrate that ordinary diff (even with these two safety flags) runs it.
    git('diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'); assert.equal(fs.existsSync(marker), true, kind);
    fs.unlinkSync(marker);
    const before = fs.readFileSync(path.join(f.dir, '.git', 'config'));
    assert.match((await readGit(f.dir, 'diff')).diff, /\+changed/);
    await readGit(f.dir, 'status');
    assert.equal(fs.existsSync(marker), false, `${kind} must never execute`);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, '.git', 'config')), before);
  }
  // '=' in a subsection is legal in config, but would change -c key=value
  // parsing. Refuse it instead of accidentally leaving a driver enabled.
  git('config', 'filter.audit=alias.clean', command);
  await assert.rejects(readGit(f.dir, 'diff'), error => error.code === 'GIT_FAILED');
  assert.equal(fs.existsSync(marker), false);
});

test('store rejects array maps and malformed records before any replay or rewrite', async t => {
  const f = fixture(t);
  await f.hub.handle(send());
  await f.hub.handle({ ...send('queued'), type: 'queue_message' });
  await f.hub.handle({ type: 'save_draft', threadId: 'thread-1', expectedVersion: 0, text: 'draft', attachments: [] });
  const baseline = JSON.parse(fs.readFileSync(f.hub.store.file, 'utf8'));
  const mutations = [
    d => { d.commands = []; }, d => { d.queue = []; }, d => { d.drafts = []; },
    d => { d.commands = null; }, d => { d.commands.r1 = []; },
    d => { d.commands.r1.requestId = 'different'; }, d => { d.commands.r1.threadId = '../escape'; },
    d => { d.commands.r1.status = 'bogus'; }, d => { d.commands.r1.hash = 'bad'; },
    d => { d.commands.r1.createdAt = 'now'; }, d => { d.commands.r1.result = []; },
    d => { d.queue.queued.status = 'bogus'; }, d => { d.queue.queued.queueId = 'different'; },
    d => { d.queue.queued.payload = []; }, d => { d.queue.queued.payload.threadId = 'other'; },
    d => { d.drafts['thread-1'] = []; }, d => { d.drafts['thread-1'].version = -1; },
    d => { d.drafts['thread-1'].attachments = [null]; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(baseline); mutate(data);
    const bytes = JSON.stringify(data); fs.writeFileSync(f.hub.store.file, bytes);
    assert.throws(() => createWorkbench(f.opts), error => error.code === 'STORE_CORRUPT');
    assert.equal(fs.readFileSync(f.hub.store.file, 'utf8'), bytes, 'bad store is not silently rewritten');
  }
  assert.equal(f.count(), 1);
  fs.writeFileSync(f.hub.store.file, JSON.stringify(baseline));
  assert.equal((await createWorkbench(f.opts).handle(send())).commandStatus, 'succeeded');
  assert.equal(f.count(), 1);
});

test('corrupt store fails closed rather than resetting command history', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir,'workbench-v1.json'),'{bad');
  assert.throws(() => new CommandStore(f.dir), /refusing replay/);
});

test('queue idle check and dispatch retain the write lane against a racing direct send', async t => {
  let releaseCheck, checkEntered;
  const entered = new Promise(r => { checkEntered = r; }); const order = [];
  const f = fixture(t, {
    executionState: async () => { checkEntered(); await new Promise(r => { releaseCheck = r; }); return { status: 'idle', location: 'hub' }; },
    send: async (msg, options) => { order.push([msg.requestId, options.queued]); return { status: 'success' }; },
  });
  await f.hub.handle({ ...send('queued'), type: 'queue_message' });
  const draining = f.hub.drain(); await entered;
  const direct = f.hub.handle(send('direct'));
  await new Promise(r => setImmediate(r)); assert.deepEqual(order, []);
  releaseCheck(); await Promise.all([draining,direct]);
  assert.deepEqual(order, [['queued',true],['direct',false]]);
});

test('direct send admitted first makes queue wait without creating a command', async t => {
  let status = 'idle';
  const f = fixture(t, { executionState: async () => ({ status, location:'hub' }), send: async () => { status = 'running'; return { status:'success' }; } });
  await f.hub.handle({ ...send('queued'), type:'queue_message' });
  await Promise.all([f.hub.handle(send('direct')), f.hub.drain()]);
  assert.equal(f.hub.store.query('queued'),null);
  assert.equal((await f.hub.handle({type:'list_queue',threadId:'thread-1'})).queue.items[0].status,'queued');
});

test('persistence failure before dispatch rolls memory back and closes the write gate', async t => {
  const f = fixture(t); const write = f.hub.store.writeSnapshot.bind(f.hub.store);
  f.hub.store.writeSnapshot = () => { throw new Error('disk full'); };
  assert.equal((await f.hub.handle(send())).status,'error'); assert.equal(f.count(),0);
  assert.equal(f.hub.store.query('r1'),null);
  f.hub.store.writeSnapshot = write;
  assert.equal((await f.hub.handle(send())).code,'STORE_UNAVAILABLE'); assert.equal(f.count(),0);
});

test('lost durable ACK becomes uncertain after restart and never dispatches twice', async t => {
  const f = fixture(t); const write = f.hub.store.writeSnapshot.bind(f.hub.store); let writes = 0;
  f.hub.store.writeSnapshot = () => { if (++writes === 3) throw new Error('ACK persist failed'); write(); };
  assert.equal((await f.hub.handle(send())).status,'error'); assert.equal(f.count(),1);
  assert.equal((await f.hub.handle(send())).code,'STORE_UNAVAILABLE');
  const restarted = createWorkbench(f.opts);
  assert.equal((await restarted.handle(send())).commandStatus,'uncertain'); assert.equal(f.count(),1);
});

test('isolated real WS exercises production handler without starting Hub, IPC or model', async t => {
  let answered; const f = fixture(t, { userInput: async msg => { answered = msg; return { ok: true }; } });
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', async data => socket.send(JSON.stringify(await f.hub.handle(JSON.parse(data))))));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`); await once(ws,'open');
  t.after(async () => { ws.terminate(); for (const c of wss.clients) c.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); });
  const request = async msg => { const next = once(ws,'message'); ws.send(JSON.stringify(msg)); return JSON.parse((await next)[0]); };
  assert.equal((await request(send())).commandStatus,'succeeded');
  assert.equal((await request(send())).commandStatus,'succeeded'); assert.equal(f.count(),1);
  assert.equal((await request({type:'query_command',requestId:'r1'})).command.status,'succeeded');
  assert.equal((await request({type:'get_execution_state',threadId:'thread-1'})).executionState.status,'idle');
  const d = { type:'save_draft',threadId:'thread-1',expectedVersion:0,text:'WS',attachments:[] };
  assert.equal((await request(d)).draft.version,1); assert.equal((await request(d)).code,'CAS_CONFLICT');
  assert.equal((await request({...send('q1'),type:'queue_message'})).queue.items[0].status,'queued');
  assert.equal((await request({type:'cancel_queued_message',threadId:'thread-1',queueId:'q1'})).queue.items[0].status,'cancelled');
  assert.equal((await request({type:'handoff_thread',threadId:'thread-1',requestId:'h1'})).result.ok,true);
  const answers = {q:{answers:['answer']}};
  assert.equal((await request({type:'send_user_input',threadId:'thread-1',requestId:'input1',inputRequestId:7,answers})).result.ok,true); assert.deepEqual(answered.answers,answers);
});
