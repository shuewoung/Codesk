import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const PTY_FLUSH_MS = 24;
export const PTY_FLUSH_BYTES = 8 * 1024;
export const MAX_LIVE_PTYS = 4;
export const PTY_SCROLLBACK_BYTES = 32 * 1024;
export const PTY_MISSING_MESSAGE = '本机 Hub 未装好终端模块（node-pty）。重新打包安装 Hub 后可用。一次命令（$ ）仍可用。';

export function clampSize(cols, rows) {
  const c = Math.max(20, Math.min(300, Number(cols) || 80));
  const r = Math.max(8, Math.min(120, Number(rows) || 24));
  return { cols: Math.floor(c), rows: Math.floor(r) };
}

export function createPtyFlush({
  onFlush,
  intervalMs = PTY_FLUSH_MS,
  maxBytes = PTY_FLUSH_BYTES,
  schedule = setTimeout,
  unschedule = clearTimeout,
} = {}) {
  let buf = '';
  let timer = null;

  const flush = () => {
    if (timer != null) {
      unschedule(timer);
      timer = null;
    }
    if (!buf) return;
    const data = buf;
    buf = '';
    onFlush?.(data);
  };

  return {
    push(chunk) {
      const text = chunk == null ? '' : String(chunk);
      if (!text) return;
      buf += text;
      if (buf.length >= maxBytes) {
        flush();
        return;
      }
      if (timer == null) timer = schedule(flush, intervalMs);
    },
    flush,
    dispose() {
      if (timer != null) {
        unschedule(timer);
        timer = null;
      }
      buf = '';
    },
  };
}

function appendScrollback(prev, chunk, limit = PTY_SCROLLBACK_BYTES) {
  const next = `${prev || ''}${chunk || ''}`;
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

export function loadNodePty() {
  try {
    return require('node-pty');
  } catch {
    return null;
  }
}

export function defaultSpawnPty({ cwd, cols, rows } = {}) {
  const pty = loadNodePty();
  if (!pty) throw new Error(PTY_MISSING_MESSAGE);
  const size = clampSize(cols, rows);
  const win = process.platform === 'win32';
  const file = win ? 'powershell.exe' : (process.env.SHELL || 'bash');
  const args = win ? ['-NoLogo'] : [];
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: cwd || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  return {
    write(data) {
      proc.write(data);
    },
    resize(nextCols, nextRows) {
      const next = clampSize(nextCols, nextRows);
      proc.resize(next.cols, next.rows);
    },
    kill() {
      try { proc.kill(); } catch { /* ignore */ }
    },
    onData(cb) {
      proc.onData(cb);
    },
    onExit(cb) {
      proc.onExit((ev) => {
        cb?.({
          exitCode: ev?.exitCode ?? 0,
          signal: ev?.signal ?? null,
        });
      });
    },
  };
}

export function createPtyHub({
  spawnPty = defaultSpawnPty,
  maxLive = MAX_LIVE_PTYS,
  intervalMs = PTY_FLUSH_MS,
  maxBytes = PTY_FLUSH_BYTES,
  schedule = setTimeout,
  unschedule = clearTimeout,
} = {}) {
  const live = new Map();
  let usedClock = 0;
  const touch = (session) => {
    session.lastUsed = ++usedClock;
  };

  function sendSafe(session, payload) {
    const send = session.send;
    if (typeof send !== 'function') return;
    try { send(payload); } catch { /* socket gone */ }
  }

  function drop(threadId, { reason = null } = {}) {
    const session = live.get(threadId);
    if (!session) return;
    live.delete(threadId);
    session.flush?.dispose();
    try { session.proc.kill(); } catch { /* ignore */ }
    if (reason) sendSafe(session, { type: 'pty_exit', threadId, exitCode: null, signal: reason });
  }

  function evictOldest(exceptId) {
    while (live.size >= maxLive) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, session] of live) {
        if (id === exceptId) continue;
        if (session.lastUsed < oldestAt) {
          oldestAt = session.lastUsed;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      drop(oldestId, { reason: 'evicted' });
    }
  }

  function attachHandlers(threadId, session) {
    session.flush = createPtyFlush({
      intervalMs,
      maxBytes,
      schedule,
      unschedule,
      onFlush(data) {
        session.scrollback = appendScrollback(session.scrollback, data);
        sendSafe(session, { type: 'pty_data', threadId, data });
      },
    });
    session.proc.onData((chunk) => {
      touch(session);
      session.flush.push(chunk);
    });
    session.proc.onExit((ev) => {
      session.flush.flush();
      const current = live.get(threadId);
      if (current === session) live.delete(threadId);
      session.flush.dispose();
      if (current !== session) return;
      sendSafe(session, {
        type: 'pty_exit',
        threadId,
        exitCode: ev?.exitCode ?? 0,
        signal: ev?.signal ?? null,
      });
    });
  }

  return {
    open({ threadId, cwd, cols, rows, send }) {
      const id = String(threadId || '').trim();
      if (!id) throw new Error('缺少 threadId');
      const size = clampSize(cols, rows);
      const existing = live.get(id);
      if (existing) {
        existing.send = send;
        touch(existing);
        try { existing.proc.resize(size.cols, size.rows); } catch { /* ignore */ }
        if (existing.scrollback) {
          sendSafe(existing, { type: 'pty_data', threadId: id, data: existing.scrollback });
        }
        return { attached: true, cwd: existing.cwd, cols: size.cols, rows: size.rows };
      }
      const workdir = path.resolve(String(cwd || ''));
      if (!workdir) throw new Error('会话没有工作目录');
      evictOldest(id);
      const proc = spawnPty({ cwd: workdir, cols: size.cols, rows: size.rows });
      const session = {
        proc,
        cwd: workdir,
        send,
        lastUsed: 0,
        scrollback: '',
        flush: null,
      };
      touch(session);
      live.set(id, session);
      attachHandlers(id, session);
      return { attached: false, cwd: workdir, cols: size.cols, rows: size.rows };
    },

    input(threadId, data) {
      const session = live.get(String(threadId || ''));
      if (!session) return false;
      touch(session);
      session.proc.write(data == null ? '' : String(data));
      return true;
    },

    resize(threadId, cols, rows) {
      const session = live.get(String(threadId || ''));
      if (!session) return false;
      const size = clampSize(cols, rows);
      session.proc.resize(size.cols, size.rows);
      return true;
    },

    close(threadId) {
      const id = String(threadId || '');
      if (!live.has(id)) return false;
      drop(id);
      return true;
    },

    retarget(threadId, send) {
      const session = live.get(String(threadId || ''));
      if (!session) return false;
      session.send = send;
      return true;
    },

    has(threadId) {
      return live.has(String(threadId || ''));
    },

    size() {
      return live.size;
    },

    dispose() {
      for (const id of [...live.keys()]) drop(id);
    },
  };
}
