import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { CodexAppServer, AppServerClient, accessModeToThreadSettings, isWriterLockError } from './appserver.js';
import { writerSafetyError } from './writer-safety.js';
import {
  DEFAULT_IDLE_RELEASE_HOURS,
  dailySlotStartMs,
  parseDailyReleaseAt,
  parseIdleReleaseConfig,
  shouldReleaseIdleWriterLocks,
} from './idle-release.js';

// ----------------------------------------------------
// 1. 配置解析
// ----------------------------------------------------
test('parseIdleReleaseConfig defaults to 4h and stays configurable', () => {
  const def = parseIdleReleaseConfig({});
  assert.equal(def.idleHours, DEFAULT_IDLE_RELEASE_HOURS);
  assert.equal(def.idleHours, 4);
  assert.equal(def.idleMs, 4 * 60 * 60 * 1000);
  assert.equal(def.dailyAt, null);
  assert.equal(def.enabled, true);

  assert.equal(parseIdleReleaseConfig({ HUB_IDLE_RELEASE_HOURS: '0' }).idleHours, 0);
  assert.equal(parseIdleReleaseConfig({ HUB_IDLE_RELEASE_HOURS: '0' }).enabled, false); // 0 = 禁用
  assert.equal(parseIdleReleaseConfig({ HUB_IDLE_RELEASE_HOURS: '1.5' }).idleMs, 1.5 * 60 * 60 * 1000);
  assert.equal(parseIdleReleaseConfig({ HUB_IDLE_RELEASE_HOURS: 'abc' }).idleHours, 4); // 非法回退默认
  assert.equal(parseIdleReleaseConfig({ HUB_IDLE_RELEASE_HOURS: '' }).idleHours, 4); // 空串视为未设置
  assert.equal(parseIdleReleaseConfig({ HUB_IDLE_RELEASE_HOURS: '-2' }).idleHours, 0); // 负数按 0

  const dailyOnly = parseIdleReleaseConfig({ HUB_IDLE_RELEASE_HOURS: '0', HUB_DAILY_RELEASE_AT: '03:00' });
  assert.equal(dailyOnly.idleHours, 0);
  assert.equal(dailyOnly.dailyAt, '03:00');
  assert.equal(dailyOnly.enabled, true); // 每日计划独立于空闲阈值
});

test('parseDailyReleaseAt accepts flexible HH:MM and rejects garbage', () => {
  assert.equal(parseDailyReleaseAt('09:30'), '09:30');
  assert.equal(parseDailyReleaseAt('9:5'), '09:05');
  assert.equal(parseDailyReleaseAt(' 23:59 '), '23:59');
  assert.equal(parseDailyReleaseAt('24:00'), null);
  assert.equal(parseDailyReleaseAt('09:60'), null);
  assert.equal(parseDailyReleaseAt('abc'), null);
  assert.equal(parseDailyReleaseAt(''), null);
  assert.equal(parseDailyReleaseAt(null), null);
  assert.equal(parseDailyReleaseAt('0900'), null);
});

test('dailySlotStartMs resolves local calendar time of the given day', () => {
  const noon = new Date(2026, 8, 12, 12, 0, 0).getTime();
  const slot = dailySlotStartMs('09:30', noon);
  assert.equal(slot, new Date(2026, 8, 12, 9, 30, 0, 0).getTime());
  assert.equal(dailySlotStartMs(null, noon), null);
});

// ----------------------------------------------------
// 2. “是否应释放”纯函数矩阵
// ----------------------------------------------------
const cfg = (over = {}) => ({ idleHours: 4, idleMs: 4 * 3600_000, dailyAt: null, enabled: true, ...over });
const HOUR = 3600_000;
const base = (over = {}) => ({
  ownedCount: 2,
  ownedBusy: false,
  inflight: 0,
  lastActivityAt: 0,
  lastDailyReleaseAt: 0,
  now: 10 * HOUR,
  config: cfg(),
  ...over,
});

test('idle timeout releases only at or beyond the threshold', () => {
  assert.deepEqual(shouldReleaseIdleWriterLocks(base({ now: 4 * HOUR })), { release: true, reason: 'idle_timeout' });
  const justBelow = shouldReleaseIdleWriterLocks(base({ now: 4 * HOUR - 1 }));
  assert.equal(justBelow.release, false);
  assert.equal(justBelow.reason, 'not_idle_enough');
});

test('live / waiting-approval owned threads always block release', () => {
  const r = shouldReleaseIdleWriterLocks(base({ ownedBusy: true, now: 100 * HOUR }));
  assert.equal(r.release, false);
  assert.equal(r.reason, 'owned_thread_busy');
});

test('inflight send/approval/stop actions block release', () => {
  const r = shouldReleaseIdleWriterLocks(base({ inflight: 2, now: 100 * HOUR }));
  assert.equal(r.release, false);
  assert.equal(r.reason, 'inflight_actions');
});

test('nothing owned or config disabled never releases', () => {
  assert.equal(shouldReleaseIdleWriterLocks(base({ ownedCount: 0 })).reason, 'no_owned_threads');
  const disabled = shouldReleaseIdleWriterLocks(base({ config: cfg({ idleHours: 0, idleMs: 0, enabled: false }) }));
  assert.equal(disabled.release, false);
  assert.equal(disabled.reason, 'disabled');
});

test('missing activity record is conservative on the idle path', () => {
  const r = shouldReleaseIdleWriterLocks(base({ lastActivityAt: null, now: 100 * HOUR }));
  assert.equal(r.release, false);
  assert.equal(r.reason, 'no_activity_record');
});

test('daily schedule fires once per day, only after the slot', () => {
  const daily = cfg({ idleHours: 0, idleMs: 0, dailyAt: '09:30', enabled: true });
  const due = new Date(2026, 8, 12, 10, 0, 0).getTime();
  const before = new Date(2026, 8, 12, 8, 0, 0).getTime();
  const slot = dailySlotStartMs('09:30', due);

  assert.deepEqual(shouldReleaseIdleWriterLocks(base({ config: daily, now: due })), { release: true, reason: 'daily_schedule' });
  // 未到点
  assert.equal(shouldReleaseIdleWriterLocks(base({ config: daily, now: before })).reason, 'daily_not_due');
  // 当天已释放过
  assert.equal(shouldReleaseIdleWriterLocks(base({ config: daily, now: due, lastDailyReleaseAt: slot + 1000 })).reason, 'daily_already_done');
  // 昨天释放过不算今天
  assert.equal(shouldReleaseIdleWriterLocks(base({ config: daily, now: due, lastDailyReleaseAt: slot - 24 * HOUR })).release, true);
  // 安全条件优先于每日计划
  assert.equal(shouldReleaseIdleWriterLocks(base({ config: daily, now: due, ownedBusy: true })).reason, 'owned_thread_busy');
  assert.equal(shouldReleaseIdleWriterLocks(base({ config: daily, now: due, inflight: 1 })).reason, 'inflight_actions');
});

test('daily schedule also works alongside a not-yet-idle threshold', () => {
  const both = cfg({ dailyAt: '09:30' });
  const now = new Date(2026, 8, 12, 10, 0, 0).getTime();
  // 空闲未到 4h，但每日到点且安全 → 释放
  assert.deepEqual(
    shouldReleaseIdleWriterLocks(base({ config: both, now, lastActivityAt: now - HOUR })),
    { release: true, reason: 'daily_schedule' }
  );
});

// ----------------------------------------------------
// 3. app-server stop / releaseAll 状态清理（假子进程）
// ----------------------------------------------------
function fakeChild(pid = 0) {
  return {
    pid,
    exitCode: null,
    killed: false,
    kill() { this.killed = true; return true; },
    stdin: { write() { return true; } },
  };
}

test('CodexAppServer.releaseAll kills the child and clears all hub writer state', () => {
  const server = new CodexAppServer();
  const child = fakeChild();
  server.client.child = child;
  const pendingErrors = [];
  server.client.pending.set(9, { resolve() {}, reject(e) { pendingErrors.push(e); }, timer: setTimeout(() => {}, 5000) });
  server.ownedThreads.add('t1');
  server.ownedThreads.add('t2');
  server.currentTurnByThread.set('t1', 'turn-1');
  server.rememberThreadAccess('t1', accessModeToThreadSettings('ask'));
  const closed = [];
  server.on('approval-closed', (a) => closed.push(a));
  const released = [];
  server.on('released', (a) => released.push(a));
  server._onServerRequest({ id: 'req-1', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', command: 'ls' } });
  assert.equal(server.pendingApprovals.size, 1);

  server.releaseAll();

  assert.equal(child.killed, true);
  assert.equal(server.client.child, null);
  assert.equal(server.client.running, false); // ensureStarted 的前置条件：未启动
  assert.equal(server.client.startingPromise, null);
  assert.equal(server.client.pending.size, 0);
  assert.deepEqual(pendingErrors.map((e) => e.message), ['app-server 已停止']);
  assert.equal(server.ownedThreads.size, 0);
  assert.equal(server.currentTurnByThread.size, 0);
  assert.equal(server.threadAccessSettings.size, 0);
  assert.equal(server.pendingApprovals.size, 0);
  assert.deepEqual(closed.map((a) => a.reason), ['released']);
  assert.equal(closed[0].threadId, 't1');
  assert.deepEqual(released, [{ ownedThreads: 2 }]);
});

test('CodexAppServer.stop() is an alias of releaseAll', () => {
  const server = new CodexAppServer();
  const child = fakeChild();
  server.client.child = child;
  server.ownedThreads.add('t1');
  server.stop();
  assert.equal(server.ownedThreads.size, 0);
  assert.equal(child.killed, true);
  assert.equal(server.running, false);
});

test('AppServerClient.stop rejects pending requests and tree-kills via injectable hook', () => {
  const client = new AppServerClient({ codexPath: 'unused' });
  const child = fakeChild(4242);
  client.child = child;
  const pendingErrors = [];
  client.pending.set(3, { resolve() {}, reject(e) { pendingErrors.push(e); }, timer: setTimeout(() => {}, 5000) });
  const pids = [];
  client.killProcessTree = (pid) => { pids.push(pid); return true; };

  client.stop();

  assert.equal(child.killed, true);
  assert.deepEqual(pendingErrors.map((e) => e.message), ['app-server 已停止']);
  assert.equal(client.running, false);
  if (process.platform === 'win32') assert.deepEqual(pids, [4242]); // taskkill /PID /T /F 兜底
  else assert.deepEqual(pids, []);

  // pid 缺失（进程已退出）时不再树杀
  const child2 = fakeChild(0);
  const client2 = new AppServerClient({ codexPath: 'unused' });
  client2.child = child2;
  const pids2 = [];
  client2.killProcessTree = (pid) => { pids2.push(pid); return true; };
  client2.stop();
  assert.deepEqual(pids2, []);
});

// ----------------------------------------------------
// 4. index.js 源码级测试（vm 提取，不启动 Hub / 不碰真实会话）
// ----------------------------------------------------
const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `index.js section not found: ${start}`);
  return source.slice(a, b);
}

test('threadLockHolder falls back to null after releaseAll clears ownedThreads', () => {
  const server = new CodexAppServer();
  server.client.child = fakeChild();
  server.ownedThreads.add('t1');
  const ctx = vm.createContext({
    codex: server,
    getIpcClient() { throw new Error('no pipe'); },
    getActiveLockThreadIds: () => new Set(),
    isGhostOwner: () => false,
    isCodexDesktopProcessRunning: () => false,
    writerLockAgeMs: () => null,
    STALE_WRITER_LOCK_MS: 120000,
  });
  vm.runInContext(section('function threadLockHolder(', 'function listSubagentsForParent('), ctx);
  assert.equal(ctx.threadLockHolder('t1'), 'hub');
  server.releaseAll();
  assert.equal(server.ownedThreads.has('t1'), false);
  assert.equal(ctx.threadLockHolder('t1'), null); // 释放后前端横幅数据源归 null
});

test('takeover after no-client triggers a lockHolder push once resume succeeds', async () => {
  const broadcasts = [];
  const touched = [];
  const client = {
    ownedThreads: new Set(),
    async ensureStarted() {},
    async resumeThread(id) { this.ownedThreads.add(id); },
  };
  const ctx = vm.createContext({
    getCodex: () => client,
    isWriterLockError,
    writerSafetyError,
    clearGhostOwner() {},
    touchHubWriteActivity: () => touched.push(1),
    broadcastLockHolderChange: (ids) => broadcasts.push(ids),
    console,
  });
  vm.runInContext(section('async function takeoverThreadAfterNoClient(', '// 本地审批分支'), ctx);
  const out = await ctx.takeoverThreadAfterNoClient('t1', 'stop');
  assert.equal(out, client);
  assert.ok(client.ownedThreads.has('t1'));
  assert.deepEqual(broadcasts, ['t1']); // 接管成功 → 主动推送 lockHolder='hub'
  assert.equal(touched.length, 1);

  // resume 撞锁：绝不推送接管成功
  const conflicting = {
    ownedThreads: new Set(),
    async ensureStarted() {},
    async resumeThread() { throw new Error('thread already has an active writer'); },
  };
  const ctx2 = vm.createContext({
    getCodex: () => conflicting,
    isWriterLockError,
    writerSafetyError,
    clearGhostOwner() {},
    touchHubWriteActivity() {},
    broadcastLockHolderChange: (ids) => broadcasts.push(ids),
    console,
  });
  vm.runInContext(section('async function takeoverThreadAfterNoClient(', '// 本地审批分支'), ctx2);
  await assert.rejects(
    ctx2.takeoverThreadAfterNoClient('t2', 'approval'),
    (e) => e.code === 'writer_lock_conflict'
  );
  assert.deepEqual(broadcasts, ['t1']); // 撞锁失败不推送
});

function idleReleaseSandbox({ codex, config, threadIsLive = () => false, inflight = 0, lastActivityAt = 0 } = {}) {
  const broadcasts = [];
  const logs = [];
  const ctx = vm.createContext({
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    codex,
    IDLE_RELEASE_CONFIG: config,
    hubLastWriteActivityAt: lastActivityAt,
    inflightActions: inflight,
    lastIdleReleaseAt: 0,
    lastThreadListBroadcastAt: 987654321,
    shouldReleaseIdleWriterLocks,
    threadIsLive,
    liveApprovalState: () => ({ live: false }),
    rolloutParseState: new Map(),
    isParsedApprovalClosed: () => false,
    rolloutCache: new Map(),
    getActiveLockThreadIds: () => new Set(),
    parseRolloutHistory: () => ({ items: [] }),
    broadcastToClients: (msg) => broadcasts.push(msg),
    getThreadList: () => ({
      threads: (codex.allThreadIds || []).map((id) => ({ id, lockHolder: codex.ownedThreads.has(id) ? 'hub' : null })),
    }),
    fs: { existsSync: () => false },
  });
  vm.runInContext(section('function touchHubWriteActivity(', '// [Idle Release] scheduler'), ctx);
  return { ctx, broadcasts, logs };
}

function fakeHubCodex(threadIds, busyThreadIds = []) {
  const released = [];
  return {
    ownedThreads: new Set(threadIds),
    allThreadIds: [...threadIds],
    runtimeStatus(id) {
      const busy = busyThreadIds.includes(id);
      return { known: true, status: busy ? 'working' : 'idle', busy, source: 'appserver' };
    },
    releaseAll() { released.push([...this.ownedThreads]); this.ownedThreads.clear(); },
    released,
  };
}

test('maybeReleaseIdleWriterLocks refuses while an owned thread is live or actions are inflight', () => {
  const now = Date.now();
  const busy = idleReleaseSandbox({
    codex: fakeHubCodex(['t1', 't2'], ['t2']),
    config: cfg(),
    threadIsLive: (id) => id === 't2',
    lastActivityAt: now - 10 * HOUR,
  });
  assert.equal(busy.ctx.maybeReleaseIdleWriterLocks(now), false);
  assert.equal(busy.ctx.codex.released.length, 0);
  assert.equal(busy.broadcasts.length, 0);

  const flying = idleReleaseSandbox({
    codex: fakeHubCodex(['t1']),
    config: cfg(),
    lastActivityAt: now - 10 * HOUR,
    inflight: 1,
  });
  assert.equal(flying.ctx.maybeReleaseIdleWriterLocks(now), false);
  assert.equal(flying.ctx.codex.released.length, 0);
});

test('maybeReleaseIdleWriterLocks releases, broadcasts thread_list and stamps the activity clock', () => {
  const now = Date.now();
  const codex = fakeHubCodex(['t1', 't2']);
  const box = idleReleaseSandbox({
    codex,
    config: cfg({ idleHours: 1, idleMs: HOUR }),
    lastActivityAt: now - 2 * HOUR,
  });
  assert.equal(box.ctx.maybeReleaseIdleWriterLocks(now), true);
  assert.deepEqual(codex.released, [['t1', 't2']]);
  assert.equal(codex.ownedThreads.size, 0);
  assert.equal(box.ctx.lastIdleReleaseAt, now); // 每日一次记账
  const list = box.broadcasts.filter((m) => m.type === 'thread_list').pop();
  assert.ok(list, 'thread_list pushed after release');
  assert.deepEqual(list.data.threads.map((t) => t.lockHolder), [null, null]); // lockHolder → null
  assert.ok(box.logs.some((line) => line.includes('[Idle Release]') && line.includes('reason=idle_timeout')));

  // 释放后立刻再来一次：无 owned 线程 → 不再重复释放
  assert.equal(box.ctx.maybeReleaseIdleWriterLocks(now + 1000), false);
  assert.equal(codex.released.length, 1);
});

test('maybeReleaseIdleWriterLocks honours daily schedule and disabled config', () => {
  const now = new Date(2026, 8, 12, 12, 0, 0).getTime();
  const dailyCodex = fakeHubCodex(['t1']);
  const daily = idleReleaseSandbox({
    codex: dailyCodex,
    config: cfg({ idleHours: 0, idleMs: 0, dailyAt: '00:05', enabled: true }),
    lastActivityAt: now, // 空闲路径关闭（idleHours=0），仅靠每日计划
  });
  assert.equal(daily.ctx.maybeReleaseIdleWriterLocks(now), true);
  assert.deepEqual(dailyCodex.released, [['t1']]);
  assert.ok(daily.logs.some((line) => line.includes('reason=daily_schedule')));

  const offCodex = fakeHubCodex(['t1']);
  const off = idleReleaseSandbox({
    codex: offCodex,
    config: cfg({ idleHours: 0, idleMs: 0, dailyAt: null, enabled: false }),
    lastActivityAt: now - 100 * HOUR,
  });
  assert.equal(off.ctx.maybeReleaseIdleWriterLocks(now), false);
  assert.equal(offCodex.released.length, 0);
});

test('touchHubWriteActivity and trackInflightAction keep the safety inputs fresh', async () => {
  const codex = fakeHubCodex([]);
  const box = idleReleaseSandbox({ codex, config: cfg() });
  const before = box.ctx.hubLastWriteActivityAt;
  await new Promise((r) => setTimeout(r, 2));
  box.ctx.touchHubWriteActivity();
  assert.ok(box.ctx.hubLastWriteActivityAt > before);

  let observed = -1;
  await box.ctx.trackInflightAction(async () => { observed = box.ctx.inflightActions; });
  assert.equal(observed, 1);
  assert.equal(box.ctx.inflightActions, 0); // 结束后归零，不阻塞下次释放
});
