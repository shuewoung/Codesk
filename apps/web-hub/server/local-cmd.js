import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export const GIT_ACTIONS = {
  status: ['status', '--porcelain=v1', '-b', '-z'],
  diff: ['diff', '--no-color', '--no-ext-diff', '--no-textconv'],
  log: ['log', '-n', '20', '--format=%H%x00%an%x00%aI%x00%s%x00%d%x00', '--no-color'],
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
    let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 15000);
    const append = (text, chunk) => {
      const combined = text + chunk;
      if (Buffer.byteLength(combined) > DEFAULT_MAX_BYTES) { exceeded = true; child.kill(); return combined.slice(0, DEFAULT_MAX_BYTES / 4); }
      return combined;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { if (!exceeded) stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { if (!exceeded) stderr = append(stderr, chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: '', stderr: err.message, exitCode: 1 });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ ok: exitCode === 0 && !exceeded, stdout, stderr: exceeded ? 'Git 输出超过 1MB 或执行超过 15 秒，结果不完整' : stderr, exitCode });
    });
  });
}

function decodeGitPath(value) {
  if (!value.startsWith('"')) return value;
  const raw = value.slice(1, -1), bytes = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      const octal = raw.slice(i + 1).match(/^[0-7]{1,3}/);
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; continue; }
      const c = raw[++i]; bytes.push(...Buffer.from(({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' })[c] || c));
    } else bytes.push(...Buffer.from(raw[i]));
  }
  return Buffer.from(bytes).toString('utf8');
}
function diffDestination(header) {
  const quoted = header.match(/^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/);
  return quoted ? decodeGitPath(quoted[2]).replace(/^b\//, '') : '';
}

export function parseGitFiles(status = '', diff = '') {
  const map = new Map();
  const add = (filePath, extra = {}) => {
    const next = String(filePath || '');
    if (!next || next.endsWith('/')) return;
    const prev = map.get(next) || { path: next, status: '', add: 0, del: 0 };
    map.set(next, {
      ...prev,
      path: next,
      status: extra.status || prev.status,
      add: extra.add != null ? extra.add : prev.add,
      del: extra.del != null ? extra.del : prev.del,
    });
  };
  if (status.includes('\0')) {
    const records = status.split('\0');
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record || record.startsWith('##')) continue;
      const code = record.slice(0, 2), filePath = record.slice(3);
      if (!filePath) continue;
      const oldPath = /[RC]/.test(code) ? records[++index] : undefined;
      map.set(filePath, { path: filePath, oldPath, status: code.trim(), add: 0, del: 0 });
    }
  }
  for (const line of (status.includes('\0') ? '' : String(status || '')).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const porcelain = trimmed.match(/^([MADRCU?!]{1,2})\s+(.+)$/);
    const named = trimmed.match(/^(modified|new file|deleted|renamed|untracked):\s+(.+)$/i);
    const filePath = porcelain?.[2] || named?.[2] || '';
    if (filePath) add(filePath.split(' -> ').pop(), { status: porcelain?.[1] || named?.[1] || '' });
  }
  let current = '';
  for (const line of String(diff || '').split('\n')) {
    const destination = diffDestination(line);
    if (destination) {
      current = destination;
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

export function parseGitLog(log = '') {
  return log.split('\n').filter(Boolean).flatMap(line => {
    const [hash, author, date, subject, refs] = line.split('\0');
    return /^[0-9a-f]{40,64}$/.test(hash) ? [{ hash, author, date, subject, refs }] : [];
  });
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
  if (wanted.includes('diff')) {
    const staged = await runGitOnce(workdir, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv']);
    if (staged.ok) result.diff += staged.stdout;
    else if (!result.error) result.error = staged.stderr || '无法读取暂存差异';
  }
  result.commits = parseGitLog(result.log);
  const patches = new Map();
  for (const chunk of result.diff.split(/(?=^diff --git )/m)) {
    const destination = diffDestination(chunk.split('\n')[0]);
    if (destination) patches.set(destination, (patches.get(destination) || '') + chunk);
  }
  result.files = parseGitFiles(result.status, result.diff).map(file => ({ ...file, patch: patches.get(file.path) || '', binary: /Binary files|GIT binary patch/.test(patches.get(file.path) || '') }));
  return result;
}
