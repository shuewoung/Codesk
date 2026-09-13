import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  cleanupOrphanCodexProcesses,
  isDescendantOf,
  killPidTree,
  normalizeExePath,
  parseProcessSnapshot,
  selectForeignCodexProcesses,
  selectOrphanCodexProcesses,
} from './orphan-cleanup.js';

// ----------------------------------------------------
// 1. 快照解析
// ----------------------------------------------------
test('parseProcessSnapshot 兼容数组/单对象/垃圾输入', () => {
  // 与 PowerShell ConvertTo-Json -Compress 输出一致（反斜杠由 JSON.stringify 正确转义）
  const arr = parseProcessSnapshot(JSON.stringify([
    { ProcessId: 101, ParentProcessId: 1, Name: 'node.exe', ExecutablePath: 'C:\\node.exe' },
    { ProcessId: 102, ParentProcessId: 101, Name: 'codex.exe', ExecutablePath: 'C:\\bin\\codex.exe' },
  ]));
  assert.equal(arr.length, 2);
  assert.deepEqual(arr[1], { pid: 102, ppid: 101, name: 'codex.exe', exePath: 'C:\\bin\\codex.exe' });

  const single = parseProcessSnapshot(JSON.stringify({ ProcessId: 7, ParentProcessId: 4, Name: 'codex.exe', ExecutablePath: 'C:\\bin\\codex.exe' }));
  assert.deepEqual(single, [{ pid: 7, ppid: 4, name: 'codex.exe', exePath: 'C:\\bin\\codex.exe' }]);

  assert.deepEqual(parseProcessSnapshot(''), []);
  assert.deepEqual(parseProcessSnapshot('not json'), []);
  assert.deepEqual(parseProcessSnapshot(JSON.stringify([null, { ProcessId: 0 }])), []); // 无效 pid 丢弃
});

// ----------------------------------------------------
// 2. 孤儿过滤纯函数（假进程表，不碰真实进程）
// ----------------------------------------------------
const SELECTED_DIR = 'C:\\Users\\zhang\\AppData\\Local\\OpenAI\\Codex\\bin\\bffc53\\';
const REPO_BIN_DIR = 'D:\\repo\\codex-bin\\';
const TARGET_EXES = [
  path.join(SELECTED_DIR, 'codex.exe'),
  path.join(REPO_BIN_DIR, 'codex.exe'),
];

function snap(...procs) { return procs; }
function proc(pid, ppid, exePath, name = 'codex.exe') { return { pid, ppid, name, exePath }; }

test('路径命中且父进程已死 → 孤儿；父进程存活 → 保留', () => {
  const snapshot = snap(
    { pid: 1, ppid: 0, name: 'System', exePath: '' },       // 系统进程（存活）
    proc(10, 999, path.join(SELECTED_DIR, 'codex.exe')), // ppid 999 不在快照 → 孤儿
    proc(11, 10, path.join(SELECTED_DIR, 'codex.exe')),  // 父 10 存活 → 保留
    proc(12, 1, path.join(REPO_BIN_DIR, 'codex.exe')),   // 父 1 存活 → 保留
  );
  const orphans = selectOrphanCodexProcesses(snapshot, { codexExePaths: TARGET_EXES });
  assert.deepEqual(orphans.map((p) => p.pid), [10]);
});

test('ppid 为 0/4（Idle/System 占位，父已退出）视为孤儿', () => {
  const snapshot = snap(
    proc(21, 4, path.join(SELECTED_DIR, 'codex.exe')),
    proc(22, 0, path.join(REPO_BIN_DIR, 'codex.exe')),
  );
  const orphans = selectOrphanCodexProcesses(snapshot, { codexExePaths: TARGET_EXES });
  assert.deepEqual(orphans.map((p) => p.pid).sort(), [21, 22]);
});

test('路径不命中（桌面 bin 根目录或其它 codex）与非 codex.exe 进程都不动', () => {
  const otherExe = 'C:\\Users\\zhang\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe'; // bin 根，非 hash 子目录
  const snapshot = snap(
    proc(31, 999, otherExe),
    proc(32, 999, 'C:\\tools\\codex\\codex.exe'),
    proc(33, 999, path.join(SELECTED_DIR, 'codex.exe'), 'node.exe'), // 名字不是 codex.exe
  );
  assert.deepEqual(selectOrphanCodexProcesses(snapshot, { codexExePaths: TARGET_EXES }), []);
});

test('路径比较不区分大小写/斜杠方向/长路径前缀，selfPid 自身排除', () => {
  const snapshot = snap(
    proc(41, 999, 'c:/users/zhang/appdata/local/openai/codex/bin/bffc53/CODEX.EXE'),
    proc(42, 999, '\\\\?\\D:\\repo\\codex-bin\\codex.exe'),
  );
  const orphans = selectOrphanCodexProcesses(snapshot, { codexExePaths: TARGET_EXES, selfPid: 41 });
  assert.deepEqual(orphans.map((p) => p.pid), [42]); // 41 是自身，跳过
  assert.equal(normalizeExePath('C:/A\\b/c.EXE'), 'c:\\a\\b\\c.exe');
});

test('codexExePaths 为空时不产生任何孤儿（保守）', () => {
  const snapshot = snap(proc(51, 999, path.join(SELECTED_DIR, 'codex.exe')));
  assert.deepEqual(selectOrphanCodexProcesses(snapshot, { codexExePaths: [] }), []);
  assert.deepEqual(selectOrphanCodexProcesses(snapshot, {}), []);
});

// ----------------------------------------------------
// 3. “除 hub 自身子进程树外的 codex.exe”纯过滤（force-clear 护栏用）
// ----------------------------------------------------
test('selectForeignCodexProcesses 排除 hub 子孙、保留桌面/孤儿 codex.exe', () => {
  const hub = { pid: 100, ppid: 1, name: 'node.exe', exePath: 'C:\\node.exe' };
  const hubChild = proc(101, 100, path.join(SELECTED_DIR, 'codex.exe'));
  const hubGrandChild = proc(102, 101, path.join(SELECTED_DIR, 'codex.exe'));
  const desktopCodex = proc(200, 150, path.join(SELECTED_DIR, 'codex.exe')); // 桌面 ChatGPT.exe(150) 的子进程
  const orphanCodex = proc(201, 999, path.join(SELECTED_DIR, 'codex.exe'));  // 孤儿仍算“存活持有者”
  const foreign = selectForeignCodexProcesses([hub, hubChild, hubGrandChild, desktopCodex, orphanCodex], 100);
  assert.deepEqual(foreign.map((p) => p.pid), [200, 201]);

  const byPid = new Map([[100, hub], [101, hubChild]]);
  assert.equal(isDescendantOf(hubChild, byPid, 100), true);
  assert.equal(isDescendantOf(hubGrandChild, byPid, 100), true); // 经 101 间接
  assert.equal(isDescendantOf(hub, byPid, 100), false); // 父 1 不通向 100
  assert.equal(isDescendantOf({ pid: 7, ppid: 0, name: '', exePath: '' }, byPid, 100), false); // 无父
});

// ----------------------------------------------------
// 4. 编排：注入假 snapshot + 假 exec，绝不杀真实进程
// ----------------------------------------------------
test('cleanupOrphanCodexProcesses 树杀命中孤儿并打 [Orphan Cleanup] 日志', (t) => {
  if (process.platform !== 'win32') return t.skip('taskkill 仅 Windows');
  const killed = [];
  const logs = [];
  const warns = [];
  const snapshot = snap(
    { pid: 900, ppid: 888, name: 'node.exe', exePath: 'C:\\node.exe' }, // 888 死了但不是 codex.exe → 不动
    proc(901, 888, path.join(REPO_BIN_DIR, 'codex.exe')), // 孤儿
    proc(902, 900, path.join(SELECTED_DIR, 'codex.exe')), // hub(900) 子进程 → 不动
  );
  const result = cleanupOrphanCodexProcesses({
    snapshot,
    codexBinDir: SELECTED_DIR,
    repoCodexBinDir: REPO_BIN_DIR,
    selfPid: 900,
    exec: (cmd) => { killed.push(cmd); },
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
  });
  assert.deepEqual(result.killed, [901]);
  assert.deepEqual(killed, ['taskkill /PID 901 /T /F']);
  assert.ok(logs.some((l) => l.includes('[Orphan Cleanup]') && l.includes('pid=901')));
  assert.equal(warns.length, 0);
});

test('cleanupOrphanCodexProcesses 无孤儿时仅记录扫描结果', (t) => {
  if (process.platform !== 'win32') return t.skip('taskkill 仅 Windows');
  const killed = [];
  const logs = [];
  const snapshot = snap(
    { pid: 900, ppid: 888, name: 'node.exe', exePath: 'C:\\node.exe' }, // hub 自身
    proc(910, 900, path.join(SELECTED_DIR, 'codex.exe')), // hub 子进程（父存活）→ 不动
  );
  const result = cleanupOrphanCodexProcesses({
    snapshot,
    codexBinDir: SELECTED_DIR,
    repoCodexBinDir: REPO_BIN_DIR,
    selfPid: 900,
    exec: (cmd) => { killed.push(cmd); },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(result.killed, []);
  assert.deepEqual(killed, []);
  assert.ok(logs.some((l) => l.includes('[Orphan Cleanup]') && l.includes('no orphan')));
});

test('killPidTree 失败（taskkill 抛错）返回 false，不中断其余清理', (t) => {
  if (process.platform !== 'win32') return t.skip('taskkill 仅 Windows');
  const warns = [];
  const snapshot = snap(proc(920, 999, path.join(REPO_BIN_DIR, 'codex.exe')));
  const result = cleanupOrphanCodexProcesses({
    snapshot,
    repoCodexBinDir: REPO_BIN_DIR,
    exec: () => { throw new Error('access denied'); },
    log: () => {},
    warn: (line) => warns.push(line),
  });
  assert.deepEqual(result.killed, []);
  assert.ok(warns.some((l) => l.includes('[Orphan Cleanup]') && l.includes('pid=920')));
  assert.equal(killPidTree(0, { exec: () => {} }), false); // 无 pid 短路
});
