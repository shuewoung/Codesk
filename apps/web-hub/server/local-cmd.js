import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export const GIT_ACTIONS = {
  status: ['status', '--porcelain=v1', '-b'],
  diff: ['diff', '--no-color'],
  log: ['log', '-n', '20', '--oneline', '--decorate', '--no-color'],
};

export function assertExistingDir(cwd) {
  const resolved = path.resolve(String(cwd || ''));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('工作目录不存在');
  }
  return resolved;
}

export function spawnCommand({
  command,
  cwd,
  onChunk,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const runId = crypto.randomUUID();
  const line = String(command || '').trim();
  if (!line) throw new Error('命令为空');
  const workdir = assertExistingDir(cwd);
  const child = spawn(line, {
    cwd: workdir,
    shell: true,
    windowsHide: true,
    env: { ...process.env },
  });

  let bytes = 0;
  let settled = false;
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* ignore */ }
  }, timeoutMs);

  const emit = (stream, chunk) => {
    if (!chunk) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes && !settled) {
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
    }
    onChunk?.({ runId, stream, chunk: text });
  };

  child.stdout?.on('data', (chunk) => emit('stdout', chunk));
  child.stderr?.on('data', (chunk) => emit('stderr', chunk));

  const done = new Promise((resolve) => {
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ runId, cwd: workdir, exitCode, signal, truncated: bytes > maxBytes });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      emit('stderr', err.message);
      resolve({ runId, cwd: workdir, exitCode: 1, signal: null, truncated: false, error: err.message });
    });
  });

  return {
    runId,
    cwd: workdir,
    kill() {
      try { child.kill(); } catch { /* ignore */ }
    },
    done,
  };
}

function runGitOnce(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      resolve({ ok: false, stdout: '', stderr: err.message, exitCode: 1 });
    });
    child.on('close', (exitCode) => {
      resolve({ ok: exitCode === 0, stdout, stderr, exitCode });
    });
  });
}

export function parseGitFiles(status = '', diff = '') {
  const map = new Map();
  const add = (filePath, extra = {}) => {
    const next = String(filePath || '').replace(/ -> .+$/, '').trim();
    if (!next || next.endsWith('/')) return;
    const prev = map.get(next) || { path: next, status: '', add: 0, del: 0 };
    map.set(next, {
      path: next,
      status: extra.status || prev.status,
      add: extra.add != null ? extra.add : prev.add,
      del: extra.del != null ? extra.del : prev.del,
    });
  };
  for (const line of String(status || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const porcelain = trimmed.match(/^([MADRCU?!]{1,2})\s+(.+)$/);
    const named = trimmed.match(/^(modified|new file|deleted|renamed|untracked):\s+(.+)$/i);
    const filePath = porcelain?.[2] || named?.[2] || '';
    if (filePath) add(filePath, { status: porcelain?.[1] || named?.[1] || '' });
  }
  let current = '';
  for (const line of String(diff || '').split('\n')) {
    const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (git) {
      current = git[2] || git[1];
      add(current);
      continue;
    }
    const row = map.get(current);
    if (!row) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) row.add += 1;
    if (line.startsWith('-') && !line.startsWith('---')) row.del += 1;
  }
  return [...map.values()];
}

export async function runGitReadonly(cwd, action = 'all') {
  const workdir = assertExistingDir(cwd);
  const wanted = action === 'all' ? ['status', 'diff', 'log'] : [action];
  const result = { cwd: workdir, action, status: '', diff: '', log: '', error: null, files: [] };
  for (const key of wanted) {
    const args = GIT_ACTIONS[key];
    if (!args) {
      result.error = `不支持的 git action: ${key}`;
      return result;
    }
    const ran = await runGitOnce(workdir, args);
    if (!ran.ok && !result.error) {
      result.error = (ran.stderr || ran.stdout || `git ${key} failed`).trim();
    }
    result[key] = ran.stdout;
  }
  result.files = parseGitFiles(result.status, result.diff);
  return result;
}
