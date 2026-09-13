// ----------------------------------------------------
// 启动清孤儿 + 持有者存活检测（Windows）
//
// 孤儿来源：hub node 被 Stop-Process /T 单杀或崩溃时，codex.exe 子进程可能
// 靠 stdin EOF 自退失败而存活，继续持有 thread-writer-locks 活锁。
//
// 设计：进程快照（CIM 一次查询）→ 纯函数过滤（可测，入参为快照）→ taskkill
// /PID <pid> /T /F 树杀。过滤条件：ExecutablePath 指向所选 codex 目录或仓库
// codex-bin\codex.exe，且 PPID 已死（或为 0/4 系统占位）。
// ----------------------------------------------------
import { execSync } from 'node:child_process';
import path from 'node:path';

export function normalizeExePath(p) {
  return String(p || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/^\\\?\\/, '')
    .replace(/^"|"$/g, '')
    .replace(/\//g, '\\')
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

// CIM 输出 → [{pid, ppid, name, exePath}]；单对象/数组/垃圾输入都安全。
export function parseProcessSnapshot(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const pid = Number(item.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push({
      pid,
      ppid: Number(item.ParentProcessId) || 0,
      name: String(item.Name || ''),
      exePath: String(item.ExecutablePath || ''),
    });
  }
  return out;
}

const SNAPSHOT_PS_COMMAND = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';

// 一次性拉取全量进程快照（exec 可注入）。非 Windows / 查询失败返回 []。
export function snapshotWindowsProcesses({ exec = execSync } = {}) {
  if (process.platform !== 'win32') return [];
  try {
    const out = exec(`powershell -NoProfile -NonInteractive -Command "${SNAPSHOT_PS_COMMAND}"`, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseProcessSnapshot(out);
  } catch {
    return [];
  }
}

export function isDescendantOf(proc, byPid, rootPid, maxHops = 64) {
  let current = proc;
  for (let hops = 0; current && hops < maxHops; hops += 1) {
    const ppid = Number(current.ppid);
    if (!Number.isFinite(ppid) || ppid <= 0) return false;
    if (ppid === rootPid) return true;
    current = byPid.get(ppid);
  }
  return false;
}

// 纯过滤：孤儿 codex.exe = 路径命中 codexExePaths 且父进程已退出（ppid 不在
// 快照中，或 ppid 为 0/4 系统占位）。快照自身即“存活 PID 集合”。
export function selectOrphanCodexProcesses(snapshot, { codexExePaths = [], selfPid = 0 } = {}) {
  const procs = Array.isArray(snapshot) ? snapshot : [];
  const livePids = new Set();
  for (const proc of procs) {
    const pid = Number(proc?.pid);
    if (pid > 0) livePids.add(pid);
  }
  const targets = new Set((codexExePaths || []).map(normalizeExePath).filter(Boolean));
  if (!targets.size) return [];
  const orphans = [];
  for (const proc of procs) {
    if (String(proc?.name || '').toLowerCase() !== 'codex.exe') continue;
    if (!targets.has(normalizeExePath(proc?.exePath))) continue;
    const pid = Number(proc?.pid);
    if (selfPid && pid === selfPid) continue;
    const ppid = Number(proc?.ppid) || 0;
    if (ppid === 0 || ppid === 4) {
      orphans.push(proc); // Idle/System：父进程已退出
      continue;
    }
    if (!livePids.has(ppid)) orphans.push(proc);
  }
  return orphans;
}

// 纯过滤：除 rootPid（hub 自身）子孙外的所有 codex.exe（桌面 / 用户手动 CLI /
// 其它宿主）。用于 force-clear 的“持有者存活”护栏。
export function selectForeignCodexProcesses(snapshot, selfPid = 0) {
  const procs = Array.isArray(snapshot) ? snapshot : [];
  const byPid = new Map();
  for (const proc of procs) {
    const pid = Number(proc?.pid);
    if (pid > 0) byPid.set(pid, proc);
  }
  const out = [];
  for (const proc of procs) {
    if (String(proc?.name || '').toLowerCase() !== 'codex.exe') continue;
    if (selfPid && isDescendantOf(proc, byPid, selfPid)) continue;
    out.push(proc);
  }
  return out;
}

export function killPidTree(pid, { exec = execSync } = {}) {
  if (process.platform !== 'win32' || !pid) return false;
  try {
    exec(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 10000, windowsHide: true });
    return true;
  } catch {
    return false; // 进程可能已自行退出
  }
}

// 孤儿清理编排：快照（可注入）→ 纯过滤 → 树杀，日志统一 [Orphan Cleanup]。
// 测试注入 snapshot + exec，绝不触碰真实进程表。
export function cleanupOrphanCodexProcesses({
  snapshot = null,
  codexBinDir = '',
  repoCodexBinDir = '',
  selfPid = 0,
  exec = execSync,
  log = console.log,
  warn = console.warn,
} = {}) {
  if (process.platform !== 'win32') return { scanned: 0, killed: [], skipped: true };
  const procs = Array.isArray(snapshot) ? snapshot : snapshotWindowsProcesses({ exec });
  if (!procs.length) return { scanned: 0, killed: [], skipped: true };
  const codexExePaths = [codexBinDir, repoCodexBinDir]
    .filter(Boolean)
    .map((dir) => path.join(dir, 'codex.exe'));
  const orphans = selectOrphanCodexProcesses(procs, { codexExePaths, selfPid });
  if (!orphans.length) {
    log(`[Orphan Cleanup] scanned ${procs.length} processes, no orphan codex.exe`);
    return { scanned: procs.length, killed: [] };
  }
  const killed = [];
  for (const proc of orphans) {
    if (killPidTree(proc.pid, { exec })) {
      killed.push(proc.pid);
      log(`[Orphan Cleanup] killed pid=${proc.pid} ppid=${proc.ppid} exe=${proc.exePath}`);
    } else {
      warn(`[Orphan Cleanup] failed to kill pid=${proc.pid} ppid=${proc.ppid} exe=${proc.exePath}`);
    }
  }
  return { scanned: procs.length, killed };
}
