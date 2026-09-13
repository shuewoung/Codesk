import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { CODEX_BIN_SELECTION, DEFAULT_CODEX_EXE } from './appserver.js';
import { REPO_CODEX_BIN_DIR } from './codex-bin.js';

// 源码级断言 + vm 行为验证：不启动 Hub、不杀真实进程
const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `index.js section not found: ${start}`);
  return source.slice(a, b);
}

// ----------------------------------------------------
// 1. 信号处理：SIGINT/SIGTERM/'exit' 先 releaseAll 再退出
// ----------------------------------------------------
function shutdownSandbox({ codex } = {}) {
  const handlers = {};
  const order = [];
  const logs = [];
  const fakeProcess = {
    on(signal, fn) { handlers[signal] = fn; },
    exit(code) { order.push(`exit:${code}`); },
  };
  // codex === null 表示模块级 codex 尚未创建（懒加载），仍可安全退出
  const sandboxCodex = codex === null
    ? undefined
    : (codex || { running: true, releaseAll() { order.push('releaseAll'); } });
  const ctx = vm.createContext({
    console: { log: (l) => logs.push(l), warn: (l) => logs.push(l) },
    codex: sandboxCodex,
    process: fakeProcess,
  });
  vm.runInContext(section("let hubShuttingDown = false;", '// 启动清孤儿：'), ctx);
  return { handlers, order, logs, ctx };
}

test('SIGINT/SIGTERM 处理器先 releaseAll 再 process.exit(0)，且不重复释放', () => {
  const box = shutdownSandbox();
  assert.ok(box.handlers.SIGINT, 'SIGINT handler registered');
  assert.ok(box.handlers.SIGTERM, 'SIGTERM handler registered');
  assert.ok(box.handlers.exit, "exit handler registered");

  box.handlers.SIGINT();
  assert.deepEqual(box.order, ['releaseAll', 'exit:0']); // 顺序：先释放子进程树，再退出
  assert.ok(box.logs.some((l) => l.includes('[Shutdown] SIGINT')));

  box.handlers.SIGTERM(); // 第二次信号：不重复 releaseAll
  assert.deepEqual(box.order, ['releaseAll', 'exit:0', 'exit:0']);

  box.handlers.exit(); // exit 事件只做同步 releaseAll，不再触发 process.exit
  assert.deepEqual(box.order, ['releaseAll', 'exit:0', 'exit:0']);
});

test('releaseAll 抛错时仍退出（不因清理失败悬挂），codex 未启动时不报错', () => {
  const box = shutdownSandbox();
  box.order.length = 0;
  box.ctx.codex.releaseAll = () => { box.order.push('releaseAll-throw'); throw new Error('kill failed'); };
  box.handlers.SIGINT();
  assert.deepEqual(box.order, ['releaseAll-throw', 'exit:0']);
  assert.ok(box.logs.some((l) => l.includes('releaseAll failed')));

  const noCodex = shutdownSandbox({ codex: null });
  noCodex.handlers.SIGTERM();
  assert.deepEqual(noCodex.order, ['exit:0']);
});

// ----------------------------------------------------
// 2. /api/host/shutdown：先 releaseAll 再 process.exit
// ----------------------------------------------------
test('shutdown API 响应后延迟退出，退出前先释放 codex 子进程树', () => {
  const order = [];
  const replies = [];
  let delayed = null;
  const ctx = vm.createContext({
    reqUrl: { pathname: '/api/host/shutdown' },
    req: { method: 'POST' },
    res: {},
    sendJson: (_req, _res, status, data) => replies.push({ status, data }),
    setTimeout: (fn, ms) => { delayed = { fn, ms }; },
    shutdownHubGracefully: (via) => order.push(`graceful:${via}`),
    process: { exit: (code) => order.push(`exit:${code}`) },
  });
  vm.runInContext(
    '(function () {' + section("if (reqUrl.pathname === '/api/host/shutdown'", "if (reqUrl.pathname === '/api/host/lan-code'") + '})();',
    ctx
  );
  assert.equal(replies.length, 1); // 立即回包（data 为 vm realm 对象，逐字段断言）
  assert.equal(replies[0].status, 200);
  assert.equal(replies[0].data.success, true);
  assert.ok(delayed, 'exit is deferred');
  assert.equal(delayed.ms, 200);
  delayed.fn();
  assert.deepEqual(order, ['graceful:api-shutdown', 'exit:0']); // 先释放后退出
});

// ----------------------------------------------------
// 3. 启动日志 / 孤儿清理 / force-clear 护栏的装配断言
// ----------------------------------------------------
test('启动时打印 codex 目录选择并异步探测 --version', () => {
  assert.match(source, /logCodexRuntimeSelection\(\{ selection: CODEX_BIN_SELECTION, codexExe: DEFAULT_CODEX_EXE \}\)/);
  assert.match(source, /import \{ logCodexRuntimeSelection, REPO_CODEX_BIN_DIR \} from '\.\/codex-bin\.js'/);
  // 桌面目录存在时优先桌面（模块级解析已生效）
  if (CODEX_BIN_SELECTION.source === 'desktop') {
    assert.match(DEFAULT_CODEX_EXE, /OpenAI.Codex.bin/i);
    assert.notEqual(DEFAULT_CODEX_EXE, REPO_CODEX_BIN_DIR);
  }
});

test('hub 监听成功后异步触发孤儿清理，使用所选目录与仓库目录', () => {
  const listenCb = section('server.listen(portToUse', "}).on('error'");
  assert.match(listenCb, /scheduleOrphanCodexCleanup\(\)/);
  const scheduler = section('function scheduleOrphanCodexCleanup()', 'startServerStrict(PORT);');
  assert.match(scheduler, /cleanupOrphanCodexProcesses\(\{/);
  assert.match(scheduler, /codexBinDir: CODEX_BIN_SELECTION\.dir/);
  assert.match(scheduler, /repoCodexBinDir: REPO_CODEX_BIN_DIR/);
  assert.match(scheduler, /selfPid: process\.pid/);
  // 延迟执行，不阻塞启动
  const timerIdx = scheduler.indexOf('setTimeout');
  assert.ok(timerIdx >= 0);
});

test('force-clear 路由注入持有者存活检测', () => {
  const route = section("if (reqUrl.pathname === '/api/thread-writer-lock/force-clear')", "if (reqUrl.pathname === '/api/auth/pair-code'");
  assert.match(route, /isHolderAlive: isWriterLockHolderProcessAlive/);
  // 检测逻辑：复用桌面进程检测 + 排除 hub 子孙后的 codex.exe
  const helper = section('function isWriterLockHolderProcessAlive()', 'let codexPipeCache');
  assert.match(helper, /isCodexDesktopProcessRunning\(\)/);
  assert.match(helper, /selectForeignCodexProcesses\(snapshotWindowsProcesses\(\), process\.pid\)/);
});
