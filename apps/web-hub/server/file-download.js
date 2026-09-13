import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const DOWNLOAD_CHUNK_SIZE = 256 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });
let globalActive = 0;

// A manager is scoped to a transport peer (including an individual relay device).
export function createDownloadManager({ send, authorize, isOpen = () => true, bufferedAmount = () => 0, maxActive = 2 } = {}) {
  const active = new Map();
  const emit = (payload) => { if (!isOpen()) throw failure('DISCONNECTED', '连接已断开'); send(payload); };
  function cancel(requestId) {
    const task = active.get(requestId);
    if (task) task.cancelled = true;
    else { try { emit({ type: 'download_error', requestId, code: 'NOT_FOUND', error: '下载任务不存在' }); } catch {} }
  }
  async function start(msg) {
    const requestId = msg.requestId;
    let task, handle;
    try {
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw failure('INVALID_REQUEST', '下载需要有效 requestId');
      if (active.has(requestId)) {
        active.get(requestId).cancelled = true;
        return; // original task emits one terminal error; never interleave two transfers with one ID
      }
      if (active.size >= maxActive || globalActive >= 4) throw failure('BUSY', '同时下载任务过多');
      task = { cancelled: false, at: Date.now() };
      active.set(requestId, task);
      globalActive++;
      const check = () => {
        if (task.cancelled) throw failure('CANCELLED', '下载已取消');
        if (!isOpen()) throw failure('DISCONNECTED', '连接已断开');
        if (Date.now() - task.at > 120000) throw failure('TIMEOUT', '下载超时');
      };
      const filePath = authorize(msg);
      handle = await fs.open(filePath, 'r');
      const stat = await handle.stat();
      const current = await fs.stat(authorize(msg));
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw failure('FILE_CHANGED', '下载期间文件发生变化');
      if (!stat.isFile()) throw failure('NOT_FILE', '只能下载普通文件');
      if (stat.size > DOWNLOAD_LIMIT) throw failure('TOO_LARGE', '原件下载不能超过 20MB');
      check();
      const totalBytes = stat.size;
      const totalChunks = Math.ceil(totalBytes / DOWNLOAD_CHUNK_SIZE);
      emit({ type: 'download_start', requestId, threadId: msg.threadId || '', path: filePath, fileName: path.basename(filePath), totalBytes, totalChunks, chunkSize: DOWNLOAD_CHUNK_SIZE });
      const hash = crypto.createHash('sha256');
      let offset = 0;
      for (let seq = 0; offset < totalBytes; seq++) {
        check();
        const waitAt = Date.now();
        while (bufferedAmount() > 1024 * 1024) {
          check();
          if (Date.now() - waitAt > 15000) throw failure('SLOW_CLIENT', '连接接收过慢');
          await new Promise((r) => setTimeout(r, 20));
        }
        const buf = Buffer.alloc(Math.min(DOWNLOAD_CHUNK_SIZE, totalBytes - offset));
        let filled = 0;
        while (filled < buf.length) {
          const { bytesRead } = await handle.read(buf, filled, buf.length - filled, offset + filled);
          if (!bytesRead) throw failure('FILE_CHANGED', '下载期间文件发生变化');
          filled += bytesRead;
        }
        check();
        hash.update(buf);
        emit({ type: 'download_chunk', requestId, seq, totalBytes, encoding: 'base64', content: buf.toString('base64') });
        offset += filled;
        // Relay adapters do not expose native bufferedAmount: pace there too.
        await new Promise((r) => setTimeout(r, 10));
      }
      check();
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw failure('FILE_CHANGED', '下载期间文件发生变化');
      emit({ type: 'download_complete', requestId, totalBytes, totalChunks, sha256: hash.digest('hex') });
    } catch (e) {
      try { emit({ type: 'download_error', requestId, code: e.code && /^[A-Z_]+$/.test(e.code) ? e.code : 'DOWNLOAD_FAILED', error: e.message || '下载失败' }); } catch {}
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (task) { active.delete(requestId); globalActive--; }
    }
  }
  return { start, cancel, close() { for (const task of active.values()) task.cancelled = true; }, get size() { return active.size; } };
}
