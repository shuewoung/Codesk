import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { discoverThreadOwner, routeWriterSend, normalizeWriterThreadId, forceClearWriterLock, handleForceClearWriterLock, writerSafetyError } from './writer-safety.js';
import { isNoActiveTurnError, isWriterLockError } from './appserver.js';
import { isPublicApi } from './auth.js';
import {
  CodexIpcClient,
  CODEX_IPC_PIPE,
  approvalKindFallbacks,
  approvalMethodFromKind,
  approvalRequestIdCandidates,
  buildApprovalParams,
  overlayPendingWithLive,
} from './ipc-client.js';

test('approvalMethodFromKind maps file/permission/command', () => {
  assert.equal(
    approvalMethodFromKind('item/fileChange/requestApproval'),
    'thread-follower-file-approval-decision',
  );
  assert.equal(
    approvalMethodFromKind('item/permissions/requestApproval'),
    'thread-follower-permissions-request-approval-response',
  );
  assert.equal(
    approvalMethodFromKind('item/commandExecution/requestApproval'),
    'thread-follower-command-approval-decision',
  );
});

test('live JSON-RPC ids come before JSONL entry ids', () => {
  const ids = approvalRequestIdCandidates({
    liveRows: [{ id: 'rpc-live', itemId: 'item-1' }],
    requestId: 'jsonl-entry',
    extraIds: ['jsonl-call'],
  });
  assert.deepEqual(ids, ['rpc-live', 'jsonl-call', 'jsonl-entry']);
});

test('overlayPendingWithLive replaces JSONL id with Desktop snapshot id', () => {
  const overlay = overlayPendingWithLive(
    { id: 'jsonl-1', ids: ['jsonl-1', 'call-9'], type: 'item/commandExecution/requestApproval', command: 'git status' },
    [{ id: 'rpc-22', method: 'item/commandExecution/requestApproval', command: 'git status', itemId: 'item-x' }],
  );
  assert.equal(overlay.id, 'rpc-22');
  assert.ok(overlay.ids.includes('rpc-22'));
  assert.ok(overlay.ids.includes('jsonl-1'));
  assert.equal(overlay.type, 'item/commandExecution/requestApproval');
});

test('kind fallbacks try the inferred method first', () => {
  const methods = approvalKindFallbacks('item/fileChange/requestApproval');
  assert.equal(methods[0], 'thread-follower-file-approval-decision');
  assert.equal(methods.length, 3);
});

test('permissions acceptForSession uses session scope', () => {
  const { method, params } = buildApprovalParams({
    conversationId: 't1',
    requestId: 'r1',
    decision: 'acceptForSession',
    kind: 'permissions',
  });
  assert.equal(method, 'thread-follower-permissions-request-approval-response');
  assert.equal(params.response.scope, 'session');
});

const THREAD = '01a024d7-f9ef-7530-b676-82122693417e';

function mockIpc(responses) {
  const ipc = new CodexIpcClient();
  ipc.ensureConnected = async () => {};
  ipc.request = async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return ipc;
}

test('owner discovery accepts success, and only explicit no-client-found means none', async () => {
  const success = mockIpc([{ resultType: 'success', handledByClientId: 'desktop' }]);
  assert.deepEqual(await discoverThreadOwner(success, THREAD), { status: 'found', ownerId: 'desktop' });
  const absent = mockIpc(Array.from({ length: 2 }, () => ({ resultType: 'error', error: 'no-client-found' })));
  assert.deepEqual(await discoverThreadOwner(absent, THREAD), { status: 'none' });
  assert.equal(absent.owners.has(THREAD), false);
});

test('owner discovery failures and malformed replies never become none', async () => {
  for (const response of [undefined, {}, { resultType: 'success' },
    { resultType: 'success', handledByClientId: 42 },
    { handledByClientId: 'desktop' },
    { resultType: 'error', error: 'permission denied', handledByClientId: 'desktop' },
    new Error('timeout'), new Error('pipe unavailable')]) {
    const ipc = mockIpc([response]);
    assert.deepEqual(await discoverThreadOwner(ipc, THREAD), { status: 'unknown' });
    await assert.rejects(mockIpc([response]).findOwner(THREAD));
  }
  assert.deepEqual(await discoverThreadOwner({ findOwner: async () => undefined }, THREAD), { status: 'unknown' });
});

function routing({ owners = ['desktop'], owned = false, live = false, followed = [{ ok: true, action: 'send' }], waited = { status: 'none' }, resumeError, desktopAbsent } = {}) {
  const calls = [];
  const notes = [];
  const client = {
    ownedThreads: new Set(owned ? [THREAD] : []),
    ensureStarted: async () => { calls.push('start'); },
    resumeThread: async () => { calls.push('resume'); if (resumeError) throw resumeError; },
  };
  const ipc = { findOwner: async () => {
    calls.push('discover');
    const owner = owners.shift();
    if (owner instanceof Error) throw owner;
    return owner;
  } };
  return { calls, notes, run: () => routeWriterSend({
    client, ipc, threadId: THREAD, isLive: () => live,
    isDesktopAbsent: desktopAbsent === undefined ? undefined : async () => desktopAbsent,
    waitForOwnerOrIdle: async () => { calls.push('wait'); return waited; },
    followerSend: async (owner) => { calls.push(`follower:${owner}`); return followed.shift(); },
    localSend: async () => { calls.push('local'); return 'send'; },
    log: (info) => notes.push(info),
  }) };
}

test('follower precedes startup; hub-owned threads bypass discovery', async () => {
  const follower = routing();
  assert.deepEqual(await follower.run(), { action: 'send', follower: true });
  assert.deepEqual(follower.calls, ['discover', 'follower:desktop']);
  const local = routing({ owned: true });
  assert.deepEqual(await local.run(), { action: 'send', follower: false });
  assert.deepEqual(local.calls, ['local']);
});

test('unknown owner prevents startup, resume and send', async () => {
  const r = routing({ owners: [new Error('timeout')] });
  await assert.rejects(r.run(), { code: 'writer_owner_unknown' });
  assert.deepEqual(r.calls, ['discover']);
});

test('explicit no owner uses normal resume exactly once and propagates lock conflicts', async () => {
  const r = routing({ owners: [null] });
  await r.run();
  assert.deepEqual(r.calls, ['discover', 'start', 'resume', 'local']);
  const failure = new Error('writer lock conflict');
  const locked = routing({ owners: [null], resumeError: failure });
  await assert.rejects(locked.run(), (e) => e === failure);
  assert.deepEqual(locked.calls, ['discover', 'start', 'resume']);
  const writerLocked = routing({ owners: [null], resumeError: new Error('thread already has an active writer') });
  await assert.rejects(writerLocked.run(), { code: 'writer_lock_conflict' });
  assert.deepEqual(writerLocked.calls, ['discover', 'start', 'resume']);
});

test('no-client-found rediscovery routes to new owner or resumes only after explicit none', async () => {
  for (const next of ['replacement', null, new Error('timeout')]) {
    const r = routing({ owners: ['desktop', next], followed: [{ ok: false }, { ok: true, action: 'steer' }] });
    if (next instanceof Error) {
      await assert.rejects(r.run(), { code: 'writer_owner_unknown' });
      assert.deepEqual(r.calls, ['discover', 'follower:desktop', 'discover']);
    } else {
      await r.run();
      assert.deepEqual(r.calls, ['discover', 'follower:desktop', 'discover', ...(next ? ['follower:replacement'] : ['start', 'resume', 'local'])]);
    }
  }
});

test('two exhausted no-client-found follower rounds take over locally, real churn never does', async () => {
  const exhausted = routing({ owners: ['desktop', 'replacement', null], followed: [{ ok: false }, { ok: false }] });
  assert.deepEqual(await exhausted.run(), { action: 'send', follower: false });
  assert.deepEqual(exhausted.calls, ['discover', 'follower:desktop', 'discover', 'follower:replacement', 'discover', 'start', 'resume', 'local']);
  const locked = routing({
    owners: ['desktop', 'replacement', null],
    followed: [{ ok: false }, { ok: false }],
    resumeError: new Error('already has an active writer'),
  });
  await assert.rejects(locked.run(), { code: 'writer_lock_conflict' });
  assert.deepEqual(locked.calls, ['discover', 'follower:desktop', 'discover', 'follower:replacement', 'discover', 'start', 'resume']);
  const churn = routing({ owners: ['desktop', 'replacement', 'third'], followed: [{ ok: false }, { ok: false }] });
  await assert.rejects(churn.run(), { code: 'writer_lock_conflict' });
  assert.ok(churn.notes.some((n) => n.stage === 'churn-conflict' && n.ownerIds.includes('replacement')));
});

test('ghost owner found through both no-client rounds is taken over locally', async () => {
  // 桌面 app-server 内存注册表残留幽灵 owner：发现恒 found、投递恒 no-client-found、ownerId 恒定。
  const ghost = routing({ owners: ['7fe9b319', '7fe9b319', '7fe9b319'], followed: [{ ok: false }, { ok: false }] });
  assert.deepEqual(await ghost.run(), { action: 'send', follower: false });
  assert.deepEqual(ghost.calls, ['discover', 'follower:7fe9b319', 'discover', 'follower:7fe9b319', 'discover', 'start', 'resume', 'local']);
  assert.ok(ghost.notes.some((n) => n.stage === 'takeover-after-no-client' && n.status === 'found' && n.ownerId === '7fe9b319'));
  // 接管时 resume 撞上 writer 锁：转 writer_lock_conflict，保留强制删锁路径
  const locked = routing({
    owners: ['7fe9b319', '7fe9b319', '7fe9b319'],
    followed: [{ ok: false }, { ok: false }],
    resumeError: new Error('thread already has an active writer'),
  });
  await assert.rejects(locked.run(), { code: 'writer_lock_conflict' });
  assert.ok(locked.notes.some((n) => n.stage === 'takeover-lock-conflict' && n.via === 'follower-no-client'));
});

test('unknown with verifiably absent desktop is treated as none and takes over', async () => {
  const takeover = routing({ owners: [new Error('timeout')], desktopAbsent: true });
  assert.deepEqual(await takeover.run(), { action: 'send', follower: false });
  assert.deepEqual(takeover.calls, ['discover', 'start', 'resume', 'local']);
  const locked = routing({
    owners: [new Error('timeout')],
    desktopAbsent: true,
    resumeError: new Error('already has an active writer'),
  });
  await assert.rejects(locked.run(), { code: 'writer_lock_conflict' });
  const present = routing({ owners: [new Error('timeout')], desktopAbsent: false });
  await assert.rejects(present.run(), { code: 'writer_owner_unknown' });
  assert.deepEqual(present.calls, ['discover']);
});

test('owner churn is bounded and unexpected follower failures never fall back locally', async () => {
  const churn = routing({ owners: ['desktop', 'replacement', 'third'], followed: [{ ok: false }, { ok: false }] });
  await assert.rejects(churn.run(), { code: 'writer_lock_conflict' });
  assert.deepEqual(churn.calls, ['discover', 'follower:desktop', 'discover', 'follower:replacement', 'discover']);
  const calls = [];
  await assert.rejects(routeWriterSend({
    client: { ownedThreads: new Set(), ensureStarted: async () => calls.push('start') },
    ipc: { findOwner: async () => 'desktop' }, threadId: THREAD,
    isLive: () => false,
    followerSend: async () => { throw new Error('permission denied'); },
    localSend: async () => calls.push('local'),
  }), /permission denied/);
  assert.deepEqual(calls, []);
});

test('live or unknown after waiting never permits takeover', async () => {
  for (const status of ['none', 'unknown']) {
    const r = routing({ owners: [null], live: true, waited: { status } });
    await assert.rejects(r.run(), { code: status === 'none' ? 'writer_lock_conflict' : 'writer_owner_unknown' });
    assert.deepEqual(r.calls, ['discover', 'wait']);
  }
  const r = routing({ owners: [null], live: true, waited: { status: 'found', ownerId: 'desktop' } });
  await r.run();
  assert.deepEqual(r.calls, ['discover', 'wait', 'follower:desktop']);
});

function lockFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-safety-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'thread-writer-locks');
  fs.mkdirSync(dir);
  return { home, dir, lock: path.join(dir, `${THREAD}.lock`) };
}

test('force clear requires exact confirmation and strict UUID', (t) => {
  const { home, lock } = lockFixture(t);
  fs.writeFileSync(lock, 'preserve');
  for (const confirmed of [undefined, false, 'true', 1]) {
    assert.throws(() => forceClearWriterLock(home, { threadId: THREAD, confirmed }), { code: 'confirmation_required' });
  }
  for (const id of ['../outside', '.coordination', 'coordination', `${THREAD}.lock`, `${THREAD}/../other`, ` ${THREAD}`, `${THREAD}\n`, 'thread-thread-' + THREAD, '', null, 42]) {
    assert.throws(() => forceClearWriterLock(home, { threadId: id, confirmed: true }), { code: 'invalid_thread_id' });
  }
  assert.equal(fs.readFileSync(lock, 'utf8'), 'preserve');
  assert.equal(normalizeWriterThreadId('thread-' + THREAD.toUpperCase()), THREAD);
});

test('force clear deletes only the confirmed target and absence is idempotent', (t) => {
  const { home, dir, lock } = lockFixture(t);
  fs.writeFileSync(lock, 'target');
  const coordination = path.join(dir, '.coordination.lock');
  const other = path.join(dir, '01a024d7-f9ef-7530-b676-82122693417f.lock');
  fs.writeFileSync(coordination, 'coordination');
  fs.writeFileSync(other, 'other');
  assert.deepEqual(forceClearWriterLock(home, { threadId: 'thread-' + THREAD, confirmed: true }), { ok: true, cleared: true, threadId: THREAD });
  assert.deepEqual(forceClearWriterLock(home, { threadId: THREAD, confirmed: true }), { ok: true, cleared: false, threadId: THREAD });
  assert.equal(fs.readFileSync(coordination, 'utf8'), 'coordination');
  assert.equal(fs.readFileSync(other, 'utf8'), 'other');
  assert.deepEqual(forceClearWriterLock(path.join(home, 'missing'), { threadId: THREAD, confirmed: true }), { ok: true, cleared: false, threadId: THREAD });
});

test('force clear refuses non-regular files', (t) => {
  const { home, lock } = lockFixture(t);
  fs.mkdirSync(lock);
  assert.throws(() => forceClearWriterLock(home, { threadId: THREAD, confirmed: true }), { code: 'unsafe_lock_file' });
  assert.ok(fs.statSync(lock).isDirectory());
});

test('force clear refuses symlink targets including dangling links', (t) => {
  const { home, lock } = lockFixture(t);
  const outside = path.join(home, 'outside');
  fs.writeFileSync(outside, 'keep');
  try { fs.symlinkSync(outside, lock); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('OS does not grant symlink creation');
    throw error;
  }
  assert.throws(() => forceClearWriterLock(home, { threadId: THREAD, confirmed: true }), { code: 'unsafe_lock_file' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  fs.unlinkSync(outside);
  assert.throws(() => forceClearWriterLock(home, { threadId: THREAD, confirmed: true }), { code: 'unsafe_lock_file' });
});

test('force clear refuses symlink/junction lock directories', (t) => {
  const { home, dir } = lockFixture(t);
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, `${THREAD}.lock`), 'keep');
  fs.rmdirSync(dir);
  fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => forceClearWriterLock(home, { threadId: THREAD, confirmed: true }), { code: 'unsafe_lock_file' });
  assert.equal(fs.readFileSync(path.join(outside, `${THREAD}.lock`), 'utf8'), 'keep');
});

test('force-clear request handler returns JSON errors and audits without credentials', (t) => {
  const { home, lock } = lockFixture(t);
  const secret = 'DO-NOT-LOG-secret-token';
  const cases = [
    ['{', 400, 'invalid_json'],
    [JSON.stringify({ threadId: THREAD, token: secret }), 400, 'confirmation_required'],
    [JSON.stringify({ threadId: secret, confirmed: true }), 400, 'invalid_thread_id'],
    ['x'.repeat(4097), 413, 'body_too_large'],
    [JSON.stringify({ threadId: THREAD, confirmed: true, token: secret }), 200, undefined],
  ];
  fs.writeFileSync(lock, 'target');
  for (const [body, status, code] of cases) {
    const req = new EventEmitter();
    req.headers = { authorization: secret };
    const replies = [];
    const logs = [];
    handleForceClearWriterLock(req, {}, { codexHome: home,
      sendJson: (_req, _res, status, data) => replies.push({ status, data }),
      audit: (line) => logs.push(line),
    });
    req.emit('data', Buffer.from(body));
    req.emit('end');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, status);
    assert.equal(replies[0].data.code, code);
    assert.ok(logs.length);
    assert.ok(!logs.join('').includes(secret));
    assert.ok(!JSON.stringify(replies).includes(secret));
  }
});

// ----------------------------------------------------
// force-clear 持有者存活护栏矩阵（假进程探测，不碰真实进程表）
// ----------------------------------------------------
function runForceClear(home, body, { holderAlive = null } = {}) {
  const req = new EventEmitter();
  const replies = [];
  const probes = [];
  const opts = {
    codexHome: home,
    sendJson: (_req, _res, status, data) => replies.push({ status, data }),
    audit: () => {},
  };
  if (holderAlive !== null) {
    opts.isHolderAlive = (threadId) => { probes.push(threadId); return holderAlive; };
  }
  handleForceClearWriterLock(req, {}, opts);
  req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
  req.emit('end');
  return { replies, probes };
}

test('holder alive: 锁存在 + 持有者存活 + 无确认 → 409 holder_alive，锁保留', (t) => {
  const { home, lock } = lockFixture(t);
  fs.writeFileSync(lock, 'target');
  const { replies, probes } = runForceClear(home, { threadId: THREAD, confirmed: true }, { holderAlive: true });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].status, 409);
  assert.equal(replies[0].data.error, 'holder_alive');
  assert.equal(replies[0].data.holderAlive, true);
  assert.match(replies[0].data.message, /acknowledgeHolderAlive/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'target'); // 锁未被删除
  assert.deepEqual(probes, [THREAD]);
});

test('holder alive: 携带 acknowledgeHolderAlive:true → 放行强删（用户明确确认的兜底）', (t) => {
  const { home, lock } = lockFixture(t);
  fs.writeFileSync(lock, 'target');
  const { replies, probes } = runForceClear(
    home,
    { threadId: THREAD, confirmed: true, acknowledgeHolderAlive: true },
    { holderAlive: true }
  );
  assert.deepEqual(replies, [{ status: 200, data: { ok: true, cleared: true, threadId: THREAD } }]);
  assert.deepEqual(probes, []); // 已确认则不再探测
  assert.equal(fs.existsSync(lock), false);
});

test('holder alive: 持有者不存活 → 正常删除，不做多余拦截', (t) => {
  const { home, lock } = lockFixture(t);
  fs.writeFileSync(lock, 'target');
  const { replies } = runForceClear(home, { threadId: THREAD, confirmed: true }, { holderAlive: false });
  assert.deepEqual(replies, [{ status: 200, data: { ok: true, cleared: true, threadId: THREAD } }]);
  assert.equal(fs.existsSync(lock), false);
});

test('holder alive: 锁不存在时行为不变（仍幂等 cleared:false，即使持有者存活）', (t) => {
  const { home } = lockFixture(t);
  const { replies, probes } = runForceClear(home, { threadId: THREAD, confirmed: true }, { holderAlive: true });
  assert.deepEqual(replies, [{ status: 200, data: { ok: true, cleared: false, threadId: THREAD } }]);
  assert.deepEqual(probes, []); // 无锁不探测
});

test('holder alive: 探测抛错按不存活处理（探测失败不阻断合法操作）', (t) => {
  const { home, lock } = lockFixture(t);
  fs.writeFileSync(lock, 'target');
  const req = new EventEmitter();
  const replies = [];
  handleForceClearWriterLock(req, {}, {
    codexHome: home,
    sendJson: (_req, _res, status, data) => replies.push({ status, data }),
    audit: () => {},
    isHolderAlive: () => { throw new Error('cim query failed'); },
  });
  req.emit('data', Buffer.from(JSON.stringify({ threadId: THREAD, confirmed: true })));
  req.emit('end');
  assert.deepEqual(replies, [{ status: 200, data: { ok: true, cleared: true, threadId: THREAD } }]);
  assert.equal(fs.existsSync(lock), false);
});

test('holder alive: 未注入 isHolderAlive（默认）保持旧行为', (t) => {
  const { home, lock } = lockFixture(t);
  fs.writeFileSync(lock, 'target');
  const { replies, probes } = runForceClear(home, { threadId: THREAD, confirmed: true });
  assert.deepEqual(replies, [{ status: 200, data: { ok: true, cleared: true, threadId: THREAD } }]);
  assert.deepEqual(probes, []);
  assert.equal(fs.existsSync(lock), false);
});

test('production force-clear endpoint stays behind authentication and POST gate', () => {
  assert.equal(isPublicApi('/api/thread-writer-lock/force-clear', 'POST'), false);
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const routeAt = source.indexOf("if (reqUrl.pathname === '/api/thread-writer-lock/force-clear')");
  assert.ok(routeAt > source.indexOf('&& !auth.authorize(req)'));
  assert.match(source.slice(routeAt, routeAt + 430), /req.method !== 'POST'/);
  assert.doesNotMatch(source, /clearStaleWriterLock|resumeLocalWriter/);
  assert.match(source, /const code = isWriterLockError\(e\) \? 'writer_lock_conflict'/);
});

test('production send routing passes desktop-absence and splits unknown owners in siblings', () => {
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  // handleRemoteSend 把 isDesktopAbsent 交给路由层
  assert.match(source, /isDesktopAbsent,\s*\n\s*waitForOwnerOrIdle: async \(\) =>/);
  // 停止与审批的 unknown 分支同样按桌面缺席分流
  const split = /if \(owner\.status === 'unknown' && await isDesktopAbsent\(\)\) owner = \{ status: 'none' \};/g;
  assert.equal((source.match(split) || []).length, 2);
});

test('production stop and approval fall back to local takeover after follower no-client-found', () => {
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const stop = source.slice(
    source.indexOf("else if (type === 'send_stop')"),
    source.indexOf("else if (type === 'send_approval')"),
  );
  // stop：no-client 后丢 owner、记幽灵，本地接管（resume 撞锁转 writer_lock_conflict）后本地打断
  assert.match(stop, /if \(!isNoClientFound\(e\)\) throw e;/);
  assert.match(stop, /ipc\.forgetOwner\(threadId\);\s*\n\s*rememberGhostOwner\(threadId, ownerId\);/);
  assert.match(stop, /await takeoverThreadAfterNoClient\(threadId, 'stop'\);/);
  assert.match(stop, /await takenClient\.interruptTurn\(threadId\);/);
  assert.match(stop, /writer_lock_conflict/);
  const approval = source.slice(
    source.indexOf("else if (type === 'send_approval')"),
    source.indexOf("else if (type === 'stop_command')"),
  );
  // approval：no-client 后本地接管并走本地审批分支，错误语义沿用既有 code 透传
  assert.match(approval, /if \(!isNoClientFound\(e\)\) throw e;/);
  assert.match(approval, /ipc\.forgetOwner\(threadId\);\s*\n\s*rememberGhostOwner\(threadId, ownerId\);/);
  assert.match(approval, /await takeoverThreadAfterNoClient\(threadId, 'approval'\);/);
  assert.match(approval, /decideApprovalLocally\(takenClient, threadId, requestId, decision\)/);
  assert.match(approval, /writer_lock_conflict/);
});

test('production threadLockHolder contract stays hub | desktop | desktop-stale | null', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-holder-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const lockDir = path.join(home, 'thread-writer-locks');
  fs.mkdirSync(lockDir);
  const lock = path.join(lockDir, `${THREAD}.lock`);

  let desktopRunning = false;
  let ownersHit = false;
  const context = vm.createContext({
    fs, path,
    CODEX_HOME: home,
    codex: { ownedThreads: new Set() },
    getIpcClient: () => ({ owners: { get: (id) => (ownersHit && id === THREAD ? 'desktop-client' : null) } }),
    isCodexDesktopProcessRunning: () => desktopRunning,
  });
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const a = source.indexOf('function getActiveLockThreadIds(');
  const b = source.indexOf('function listSubagentsForParent(');
  const c = source.indexOf('const STALE_WRITER_LOCK_MS');
  const d = source.indexOf('function sleepMs(');
  assert.ok(a >= 0 && b > a && c >= 0 && d > c);
  vm.runInContext(source.slice(a, b) + source.slice(c, d), context);
  const holder = () => context.threadLockHolder(THREAD);
  // const 声明留在 vm 全局词法环境，需经同上下文脚本取回（跨 realm 不能用 instanceof Map）
  const ghostMap = vm.runInContext('ghostOwners', context);
  assert.ok(ghostMap && typeof ghostMap.get === 'function' && typeof ghostMap.set === 'function');

  // 无 owners 缓存、无锁文件 → null
  assert.equal(holder(), null);
  // owners 缓存命中（IPC 广播）→ desktop，无论桌面进程探测结果
  ownersHit = true;
  assert.equal(holder(), 'desktop');
  // 幽灵 owner 矩阵：no-client 被丢弃的 owner 在 TTL 内把 owners 命中降级 desktop-stale
  context.rememberGhostOwner(THREAD, 'someone-else');
  assert.equal(holder(), 'desktop'); // 幽灵记录指向别的 ownerId：不影响
  context.rememberGhostOwner(THREAD, 'desktop-client');
  assert.equal(holder(), 'desktop-stale'); // 同 id 且未过期 → desktop-stale
  ghostMap.set(THREAD, { ownerId: 'desktop-client', at: Date.now() - 11 * 60 * 1000 });
  assert.equal(holder(), 'desktop'); // TTL（10 分钟）已过 → 回到 desktop
  context.rememberGhostOwner(THREAD, 'desktop-client');
  assert.equal(holder(), 'desktop-stale');
  context.clearGhostOwner(THREAD);
  assert.equal(holder(), 'desktop'); // follower 投递成功/本地接管成功清除幽灵
  ownersHit = false;
  // 新锁 + 桌面进程在 → desktop；桌面进程不在 → desktop-stale
  fs.writeFileSync(lock, 'lock');
  desktopRunning = true;
  assert.equal(holder(), 'desktop');
  desktopRunning = false;
  assert.equal(holder(), 'desktop-stale');
  // 陈旧锁（龄超 STALE）即使桌面进程在 → desktop-stale
  desktopRunning = true;
  const staleAt = Date.now() / 1000 - 400;
  fs.utimesSync(lock, staleAt, staleAt);
  assert.equal(holder(), 'desktop-stale');
  // hub 持有优先级最高（即使残留幽灵记录）
  context.rememberGhostOwner(THREAD, 'desktop-client');
  context.codex.ownedThreads.add(THREAD);
  assert.equal(holder(), 'hub');
});

test('production follower no-client records ghost, delivery success and takeover clear it', async () => {
  const calls = [];
  const localClient = {
    ownedThreads: new Set(),
    ensureStarted: async () => { calls.push('start'); },
    resumeThread: async () => { calls.push('resume'); },
    decideApproval: (key, decision) => {
      calls.push(`decide:${key}`);
      return key === THREAD
        ? { ok: true, requestId: key, decision }
        : { ok: false, code: 'not_found', reason: '没有找到待处理的审批' };
    },
  };
  const context = vm.createContext({
    fs, path, console,
    CODEX_HOME: '/unused',
    codex: { ownedThreads: new Set() },
    getIpcClient: () => { throw new Error('unused'); },
    isCodexDesktopProcessRunning: () => false,
    getCodex: () => localClient,
    isNoActiveTurnError,
    isWriterLockError,
    writerSafetyError,
    // 接管成功后的空闲计时/lockHolder 推送钩子（真实实现在 idle-release 区块，与本测试无关）
    touchHubWriteActivity() {},
    broadcastLockHolderChange() {},
  });
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const a = source.indexOf('function getActiveLockThreadIds(');
  const b = source.indexOf('function listSubagentsForParent(');
  const c = source.indexOf('function isNoClientFound(');
  const d = source.indexOf('async function sendLocalUserOrSteer(');
  assert.ok(a >= 0 && b > a && c >= 0 && d > c);
  vm.runInContext(source.slice(a, b) + source.slice(c, d), context);
  const ghostMap = vm.runInContext('ghostOwners', context);
  assert.ok(ghostMap && typeof ghostMap.get === 'function' && typeof ghostMap.set === 'function');

  const forgets = [];
  const ipc = {
    forgetOwner: (id) => forgets.push(id),
    startTurn: async () => { throw new Error('no-client-found'); },
    steerTurn: async () => { throw new Error('no-client-found'); },
  };
  // no-client-found：丢 owner 并记录幽灵（返回对象诞生于 vm realm，逐字段断言）
  const dropped = await context.tryFollowerSend(ipc, THREAD, [], false, 'ghost-owner');
  assert.equal(dropped.ok, false);
  assert.equal(dropped.action, 'send');
  assert.deepEqual(forgets, [THREAD]);
  assert.equal(ghostMap.get(THREAD)?.ownerId, 'ghost-owner');
  // 其它失败不记幽灵且原样上抛（绝不本地兜底）
  ipc.startTurn = async () => { throw new Error('permission denied'); };
  await assert.rejects(context.tryFollowerSend(ipc, THREAD, [], false, 'owner-b'), /permission denied/);
  assert.equal(ghostMap.get(THREAD)?.ownerId, 'ghost-owner');
  // follower 投递成功：清除幽灵
  ipc.startTurn = async () => ({});
  const delivered = await context.tryFollowerSend(ipc, THREAD, [], false, 'owner-c');
  assert.equal(delivered.ok, true);
  assert.equal(delivered.action, 'send');
  assert.equal(ghostMap.has(THREAD), false);

  // 本地接管：resume 成功即持锁并清除幽灵
  context.rememberGhostOwner(THREAD, 'ghost-owner');
  assert.equal(await context.takeoverThreadAfterNoClient(THREAD, 'test'), localClient);
  assert.deepEqual(calls, ['start', 'resume']);
  assert.equal(ghostMap.has(THREAD), false);
  // resume 撞 writer 锁：转 writer_lock_conflict（保留强制删锁路径）；其它错误原样上抛
  localClient.resumeThread = async () => { throw new Error('thread already has an active writer'); };
  await assert.rejects(context.takeoverThreadAfterNoClient(THREAD, 'test'), { code: 'writer_lock_conflict' });
  localClient.resumeThread = async () => { throw new Error('spawn failed'); };
  await assert.rejects(context.takeoverThreadAfterNoClient(THREAD, 'test'), /spawn failed/);
  // Hub 已持有：直接复用客户端，不再 resume
  localClient.resumeThread = async () => { calls.push('resume'); };
  localClient.ownedThreads.add(THREAD);
  context.rememberGhostOwner(THREAD, 'ghost-owner');
  assert.equal(await context.takeoverThreadAfterNoClient(THREAD, 'test'), localClient);
  assert.equal(calls.filter((x) => x === 'resume').length, 1);
  assert.equal(ghostMap.has(THREAD), false);

  // 本地审批分支：requestId 未命中再按 threadId 兜底（owner-none 与接管共用）
  assert.deepEqual(
    context.decideApprovalLocally(localClient, THREAD, 'missing-request', 'accept'),
    { ok: true, requestId: THREAD, decision: 'accept' },
  );
  assert.deepEqual(calls.slice(-2), ['decide:missing-request', `decide:${THREAD}`]);
});

test('codexPipeExists reports a listening pipe and a closed pipe', async (t) => {
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-hub-test-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `codex-hub-test-${process.pid}-${Date.now()}.sock`);
  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => resolve());
  });
  t.after(() => { try { server.close(); } catch { /* already closed */ } });

  const context = vm.createContext({
    net, setTimeout, clearTimeout, console,
    CODEX_IPC_PIPE: 'unused-in-this-test',
  });
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const a = source.indexOf('let codexPipeCache');
  const b = source.indexOf('async function isDesktopAbsent(');
  assert.ok(a >= 0 && b > a);
  vm.runInContext(source.slice(a, b), context);

  assert.equal(typeof CODEX_IPC_PIPE, 'string');
  assert.equal(await context.codexPipeExists(pipeName), true);
  await new Promise((resolve) => server.close(() => resolve()));
  let gone = false;
  for (let attempt = 0; attempt < 10 && !gone; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    gone = !(await context.codexPipeExists(pipeName));
  }
  assert.equal(gone, true, 'closed pipe must stop reporting as present');
});
