// ----------------------------------------------------
// codex.exe 运行时目录解析
//
// 背景：仓库自带 codex-bin 是四件套“拼盘”（codex.exe 0.153.x 配 08-25 旧
// codex-code-mode-host.exe），接管 code-mode 会话时 host 缺字段报 decode 错误。
// 桌面版同一 hash 目录下的四件套版本一致，优先复用。
//
// 解析优先级（resolveCodexBinDir，纯逻辑 + 可注入 fs，便于测试）：
//  1. CODEX_BIN 环境变量（显式目录，须含 codex.exe；无效则告警并降级）
//  2. 桌面安装目录 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\ 中最新一个
//     （按目录 mtime 排序，须同时含 codex.exe 与 codex-code-mode-host.exe）
//  3. 仓库 codex-bin（兜底；codex.exe 与 codex-code-mode-host.exe mtime 差
//     超过 30 天时打混版警告日志）
// ----------------------------------------------------
import { spawn as defaultSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_CODEX_BIN_DIR = path.resolve(SERVER_DIR, '..', '..', '..', 'codex-bin');
export const CODEX_EXE_NAME = 'codex.exe';
export const CODEX_CODE_MODE_HOST_NAME = 'codex-code-mode-host.exe';
export const MIXED_VERSION_WARN_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export function desktopCodexBinRoot(env = process.env) {
  const localAppData = env.LOCALAPPDATA
    || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '')
    || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'OpenAI', 'Codex', 'bin');
}

function statPath(fsImpl, target) {
  try {
    return fsImpl.statSync(target);
  } catch {
    return null;
  }
}

function fileExists(fsImpl, target) {
  try {
    return fsImpl.statSync(target).isFile();
  } catch {
    return false;
  }
}

// 桌面候选目录快照：bin\<hash>\ 子目录，仅保留同时含 codex.exe 与
// codex-code-mode-host.exe 的（缺 host 的目录混用会导致 code-mode decode 错误）。
export function findDesktopCodexBinDirs(env = process.env, fsImpl = fs) {
  const root = desktopCodexBinRoot(env);
  let entries = [];
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // 桌面未安装
  }
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const stat = statPath(fsImpl, dir);
    if (!stat || !stat.isDirectory()) continue;
    if (!fileExists(fsImpl, path.join(dir, CODEX_EXE_NAME))) continue;
    if (!fileExists(fsImpl, path.join(dir, CODEX_CODE_MODE_HOST_NAME))) continue;
    out.push({ dir, mtimeMs: Number(stat.mtimeMs) || 0 });
  }
  return out;
}

// 仓库 codex-bin 混版检测：codex.exe 与 host 的 mtime 差超过阈值（或缺 host）时告警。
function repoMixedVersionWarning(fsImpl) {
  const codexStat = statPath(fsImpl, path.join(REPO_CODEX_BIN_DIR, CODEX_EXE_NAME));
  if (!codexStat || !codexStat.isFile()) return null;
  const hostStat = statPath(fsImpl, path.join(REPO_CODEX_BIN_DIR, CODEX_CODE_MODE_HOST_NAME));
  if (!hostStat || !hostStat.isFile()) {
    return `仓库 codex-bin 缺少 ${CODEX_CODE_MODE_HOST_NAME}，code-mode 会话可能无法接管；建议安装 Codex 桌面版或设置 CODEX_BIN`;
  }
  const diffMs = Math.abs(Number(codexStat.mtimeMs) - Number(hostStat.mtimeMs));
  if (diffMs > MIXED_VERSION_WARN_MS) {
    const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
    return `混版警告: 仓库 codex-bin 的 ${CODEX_EXE_NAME} 与 ${CODEX_CODE_MODE_HOST_NAME} mtime 相差 ${days} 天，code-mode 会话可能 decode 失败；建议安装 Codex 桌面版或设置 CODEX_BIN`;
  }
  return null;
}

// 纯逻辑目录解析：返回 { dir, source: 'env'|'desktop'|'repo'|'repo-fallback', warning|null }
export function resolveCodexBinDir(env = process.env, fsImpl = fs) {
  const notes = [];
  const envDir = String(env?.CODEX_BIN || '').trim();
  if (envDir) {
    if (fileExists(fsImpl, path.join(envDir, CODEX_EXE_NAME))) {
      return { dir: envDir, source: 'env', warning: null };
    }
    notes.push(`CODEX_BIN=${envDir} 缺少 ${CODEX_EXE_NAME}，已忽略并降级`);
  }

  const desktopDirs = findDesktopCodexBinDirs(env, fsImpl)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (desktopDirs.length) {
    return { dir: desktopDirs[0].dir, source: 'desktop', warning: notes.join('；') || null };
  }
  if (envDir) {
    notes.push('未找到可用的桌面 codex 安装目录（须同时含 codex.exe 与 codex-code-mode-host.exe）');
  }

  if (fileExists(fsImpl, path.join(REPO_CODEX_BIN_DIR, CODEX_EXE_NAME))) {
    const warning = repoMixedVersionWarning(fsImpl);
    return { dir: REPO_CODEX_BIN_DIR, source: 'repo', warning: [warning, ...notes].filter(Boolean).join('；') || null };
  }
  // 兜底：返回仓库目录（哪怕不存在），让 spawn 报清晰的“不存在”错误
  return { dir: REPO_CODEX_BIN_DIR, source: 'repo-fallback', warning: notes.join('；') || null };
}

// 一次性子进程探测 codex.exe --version（带超时；失败返回 null，绝不阻塞启动）。
// spawn 可注入，测试用假进程。
export function probeCodexVersion(codexExePath, { spawn = defaultSpawn, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(codexExePath, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    let out = '';
    try {
      child.stdout?.on('data', (chunk) => { out += String(chunk); });
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        const firstLine = out.trim().split('\n')[0].trim();
        finish(code === 0 && firstLine ? firstLine : null);
      });
    } catch {
      finish(null);
    }
  });
}

// 启动日志：打印所选目录、来源与 codex.exe --version（异步探测，失败仅告警）。
export function logCodexRuntimeSelection({
  selection = null,
  codexExe = '',
  probe = probeCodexVersion,
  log = console.log,
  warn = console.warn,
} = {}) {
  const picked = selection || resolveCodexBinDir();
  const exe = codexExe || path.join(picked.dir, CODEX_EXE_NAME);
  log(`[codex-bin] selected dir=${picked.dir} source=${picked.source} exe=${exe}`);
  if (picked.warning) warn(`[codex-bin] ${picked.warning}`);
  probe(exe)
    .then((version) => {
      if (version) log(`[codex-bin] ${exe} --version: ${version}`);
      else warn('[codex-bin] codex.exe --version 探测失败（不阻塞启动）');
    })
    .catch(() => warn('[codex-bin] codex.exe --version 探测失败（不阻塞启动）'));
}
