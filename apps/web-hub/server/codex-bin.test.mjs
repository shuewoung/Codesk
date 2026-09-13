import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  CODEX_CODE_MODE_HOST_NAME,
  CODEX_EXE_NAME,
  MIXED_VERSION_WARN_MS,
  REPO_CODEX_BIN_DIR,
  desktopCodexBinRoot,
  findDesktopCodexBinDirs,
  logCodexRuntimeSelection,
  probeCodexVersion,
  resolveCodexBinDir,
} from './codex-bin.js';
import { CODEX_BIN_SELECTION, DEFAULT_CODEX_EXE } from './appserver.js';

// ----------------------------------------------------
// 假 fs：目录树完全由测试控制，不触碰真实磁盘/桌面
// ----------------------------------------------------
function fakeFs({ files = new Map(), dirs = new Map() } = {}) {
  // files: absolutePath -> mtimeMs（存在即文件）
  // dirs:  absolutePath -> mtimeMs（存在即目录）
  const joined = (p) => path.normalize(String(p));
  return {
    __files: files,
    __dirs: dirs,
    statSync(p) {
      const key = joined(p);
      if (files.has(key)) {
        const mtimeMs = files.get(key);
        return { isFile: () => true, isDirectory: () => false, mtimeMs };
      }
      if (dirs.has(key)) {
        const mtimeMs = dirs.get(key);
        return { isFile: () => false, isDirectory: () => true, mtimeMs };
      }
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
    readdirSync(dir, opts = {}) {
      if (!opts || opts.withFileTypes !== true) {
        throw new Error('fake fs only supports readdirSync with withFileTypes');
      }
      const key = joined(dir);
      if (!dirs.has(key)) {
        const err = new Error(`ENOENT: ${dir}`);
        err.code = 'ENOENT';
        throw err;
      }
      const prefix = key.endsWith(path.sep) ? key : key + path.sep;
      const names = new Set();
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split(path.sep)[0]);
      }
      for (const d of dirs.keys()) {
        if (d.startsWith(prefix)) names.add(d.slice(prefix.length).split(path.sep)[0]);
      }
      return [...names].map((name) => {
        const full = path.join(key, name);
        const isDir = dirs.has(full);
        return { name, isDirectory: () => isDir };
      });
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

function fakeDesktop({ dirs = {} } = {}) {
  // dirs: { '<hash>': { mtimeMs, withHost = true } } → 构造 LOCALAPPDATA 桌面目录树
  const root = desktopCodexBinRoot({ LOCALAPPDATA: 'C:\\fake-local' });
  const files = new Map();
  const dirMap = new Map([[root, 1000]]);
  for (const [hash, cfg] of Object.entries(dirs)) {
    const dir = path.join(root, hash);
    dirMap.set(dir, cfg.mtimeMs);
    files.set(path.join(dir, CODEX_EXE_NAME), cfg.mtimeMs);
    if (cfg.withHost !== false) files.set(path.join(dir, CODEX_CODE_MODE_HOST_NAME), cfg.mtimeMs);
  }
  return { root, files, dirs: dirMap };
}

// ----------------------------------------------------
// 1. 解析优先级
// ----------------------------------------------------
test('CODEX_BIN 环境变量优先于桌面与仓库', () => {
  const desktop = fakeDesktop({ dirs: { aaa: { mtimeMs: 5000 }, bbb: { mtimeMs: 9000 } } });
  const fsImpl = fakeFs({ files: new Map([...desktop.files, ['C:\\env-bin\\codex.exe', 1]]), dirs: new Map([...desktop.dirs, ['C:\\env-bin', 1]]) });
  const picked = resolveCodexBinDir({ CODEX_BIN: 'C:\\env-bin', LOCALAPPDATA: 'C:\\fake-local' }, fsImpl);
  assert.equal(picked.dir, 'C:\\env-bin');
  assert.equal(picked.source, 'env');
  assert.equal(picked.warning, null);
});

test('CODEX_BIN 缺少 codex.exe 时告警并降级到桌面最新目录', () => {
  const desktop = fakeDesktop({ dirs: { older: { mtimeMs: 5000 }, newer: { mtimeMs: 9000 } } });
  const fsImpl = fakeFs({ files: desktop.files, dirs: new Map([...desktop.dirs, ['C:\\env-bin', 1]]) });
  const picked = resolveCodexBinDir({ CODEX_BIN: 'C:\\env-bin', LOCALAPPDATA: 'C:\\fake-local' }, fsImpl);
  assert.equal(picked.source, 'desktop');
  assert.equal(picked.dir, path.join(desktop.root, 'newer')); // mtime 最新
  assert.match(picked.warning, /CODEX_BIN=C:\\env-bin/); // 显式配置失效要有告警，不能静默
});

test('桌面候选目录须同时含 codex.exe 与 codex-code-mode-host.exe，缺 host 跳过', () => {
  const desktop = fakeDesktop({ dirs: {
    full: { mtimeMs: 5000 },
    noHost: { mtimeMs: 20000, withHost: false },
  } });
  const fsImpl = fakeFs(desktop);
  const found = findDesktopCodexBinDirs({ LOCALAPPDATA: 'C:\\fake-local' }, fsImpl);
  assert.deepEqual(found.map((d) => d.dir), [path.join(desktop.root, 'full')]);

  const picked = resolveCodexBinDir({ LOCALAPPDATA: 'C:\\fake-local' }, fsImpl);
  assert.equal(picked.source, 'desktop');
  assert.equal(picked.dir, path.join(desktop.root, 'full')); // 缺 host 的高 mtime 目录被跳过
});

test('无 CODEX_BIN 且无桌面安装时回退仓库 codex-bin，无混版不告警', () => {
  const repoExe = path.join(REPO_CODEX_BIN_DIR, CODEX_EXE_NAME);
  const repoHost = path.join(REPO_CODEX_BIN_DIR, CODEX_CODE_MODE_HOST_NAME);
  const fsImpl = fakeFs({
    files: new Map([[repoExe, 5000], [repoHost, 5000 + 29 * DAY]]), // 29 天 < 30 天阈值
  });
  const picked = resolveCodexBinDir({ LOCALAPPDATA: 'C:\\fake-local' }, fsImpl);
  assert.equal(picked.source, 'repo');
  assert.equal(picked.dir, REPO_CODEX_BIN_DIR);
  assert.equal(picked.warning, null);
});

test('仓库 codex-bin 混版（mtime 差 > 30 天）打警告', () => {
  const repoExe = path.join(REPO_CODEX_BIN_DIR, CODEX_EXE_NAME);
  const repoHost = path.join(REPO_CODEX_BIN_DIR, CODEX_CODE_MODE_HOST_NAME);
  const fsImpl = fakeFs({
    files: new Map([[repoExe, 10_000_000], [repoHost, 10_000_000 - MIXED_VERSION_WARN_MS - DAY]]),
  });
  const picked = resolveCodexBinDir({}, fsImpl);
  assert.equal(picked.source, 'repo');
  assert.match(picked.warning, /混版警告/);
  assert.match(picked.warning, /codex-code-mode-host\.exe/);
});

test('仓库 codex-bin 缺 host 也打警告；完全无候选时兜底返回仓库目录', () => {
  const fsImpl = fakeFs({
    files: new Map([[path.join(REPO_CODEX_BIN_DIR, CODEX_EXE_NAME), 1]]),
  });
  const picked = resolveCodexBinDir({}, fsImpl);
  assert.equal(picked.source, 'repo');
  assert.match(picked.warning, /缺少 codex-code-mode-host\.exe/);

  const empty = resolveCodexBinDir({}, fakeFs());
  assert.equal(empty.source, 'repo-fallback');
  assert.equal(empty.dir, REPO_CODEX_BIN_DIR);
});

// ----------------------------------------------------
// 2. 生产模块装配：appserver 使用解析结果
// ----------------------------------------------------
test('appserver DEFAULT_CODEX_EXE 指向解析出的 codex.exe（CODEX_CLI_PATH 仍最高优先）', () => {
  assert.ok(DEFAULT_CODEX_EXE);
  assert.ok(CODEX_BIN_SELECTION.dir);
  assert.equal(DEFAULT_CODEX_EXE, path.join(CODEX_BIN_SELECTION.dir, CODEX_EXE_NAME));
  assert.ok(['env', 'desktop', 'repo', 'repo-fallback'].includes(CODEX_BIN_SELECTION.source));
});

// ----------------------------------------------------
// 3. --version 一次性子进程探测（假进程，不真正 spawn）
// ----------------------------------------------------
function fakeVersionChild({ output = 'codex-cli 0.153.4\n', exitCode = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', null); };
  queueMicrotask(() => {
    if (!hang && child.stdout) child.stdout.emit('data', output);
    if (!hang) child.emit('close', exitCode);
  });
  return child;
}

test('probeCodexVersion 成功返回首行版本号', async () => {
  const children = [];
  const version = await probeCodexVersion('C:\\x\\codex.exe', {
    spawn: (exe, args) => {
      children.push({ exe, args });
      return fakeVersionChild({ output: 'codex-cli 0.153.4 (abc)\ncompiled ...\n' });
    },
    timeoutMs: 500,
  });
  assert.deepEqual(children, [{ exe: 'C:\\x\\codex.exe', args: ['--version'] }]);
  assert.equal(version, 'codex-cli 0.153.4 (abc)');
});

test('probeCodexVersion 非零退出 / spawn 异常 / 超时都返回 null 不抛错', async () => {
  assert.equal(await probeCodexVersion('x', { spawn: () => fakeVersionChild({ exitCode: 1 }), timeoutMs: 500 }), null);
  assert.equal(await probeCodexVersion('x', { spawn: () => { throw new Error('no exe'); }, timeoutMs: 500 }), null);
  const hanging = fakeVersionChild({ hang: true });
  assert.equal(await probeCodexVersion('x', { spawn: () => hanging, timeoutMs: 30 }), null);
  assert.equal(hanging.killed, true); // 超时后 kill 一次性子进程
});

test('logCodexRuntimeSelection 打印所选目录/来源/版本，失败仅告警', async () => {
  const logs = [];
  const warns = [];
  const log = (line) => logs.push(line);
  const warn = (line) => warns.push(line);
  logCodexRuntimeSelection({
    selection: { dir: 'C:\\bin-xyz', source: 'desktop', warning: 'w1' },
    codexExe: 'C:\\bin-xyz\\codex.exe',
    probe: async () => 'codex-cli 0.153.4',
    log,
    warn,
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(logs.some((l) => l.includes('[codex-bin]') && l.includes('C:\\bin-xyz') && l.includes('source=desktop')));
  assert.ok(warns.some((l) => l.includes('w1')));
  assert.ok(logs.some((l) => l.includes('--version') && l.includes('codex-cli 0.153.4')));

  const warns2 = [];
  logCodexRuntimeSelection({
    selection: { dir: 'C:\\bin-xyz', source: 'repo', warning: null },
    probe: async () => null,
    log: () => {},
    warn: (l) => warns2.push(l),
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(warns2.some((l) => l.includes('探测失败') && l.includes('不阻塞启动')));
});
