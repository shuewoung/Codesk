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

export async function runGitReadonly(cwd, action = 'all') {
  const workdir = assertExistingDir(cwd);
  const wanted = action === 'all' ? ['status', 'diff', 'log'] : [action];
  const result = { cwd: workdir, action, status: '', diff: '', log: '', error: null };
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
  return result;
}
