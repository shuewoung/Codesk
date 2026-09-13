export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const DOWNLOAD_CHUNK_SIZE = 262144;
export type DownloadMessage = { type: string; [key: string]: unknown };
export type DownloadResult = { fileName: string; bytes: Uint8Array; sha256: string };
export type Digest = (bytes: Uint8Array) => Promise<string>;
export type DownloadTransport = {
  sendMessage: (message: DownloadMessage) => boolean;
  subscribeMessages: (listener: (message: DownloadMessage) => void) => () => void;
};

export function decodeDownloadChunk(content: string): Uint8Array {
  if (content.length > Math.ceil(DOWNLOAD_CHUNK_SIZE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error('下载分块编码无效');
  const text = atob(content);
  return Uint8Array.from(text, c => c.charCodeAt(0));
}

/** Strict ordered assembler: never accepts preview content or unverified bytes. */
export class DownloadAssembler {
  private start?: { fileName: string; totalBytes: number; totalChunks: number };
  private bytes?: Uint8Array;
  private seq = 0;
  private offset = 0;
  private completed = false;
  constructor(readonly requestId: string, private digest: Digest, private expected?: { threadId: string; path: string }) {}
  async accept(message: DownloadMessage): Promise<DownloadResult | null> {
    if (message.requestId !== this.requestId) return null;
    if (this.completed) throw new Error('下载已结束');
    if (message.type === 'download_error') throw new Error(String(message.error || '原件下载失败'));
    if (message.type === 'download_start') {
      const { totalBytes, totalChunks, chunkSize, fileName } = message;
      if (this.start || !Number.isInteger(totalBytes) || Number(totalBytes) < 0 || Number(totalBytes) > MAX_DOWNLOAD_BYTES || chunkSize !== DOWNLOAD_CHUNK_SIZE || totalChunks !== Math.ceil(Number(totalBytes) / DOWNLOAD_CHUNK_SIZE) || typeof fileName !== 'string') throw new Error('下载大小或分块信息无效（上限 20 MiB）');
      // The host resolves relative paths to an absolute path; requestId + thread bind the response.
      if (this.expected && message.threadId !== this.expected.threadId) throw new Error('下载会话身份不匹配');
      this.start = { totalBytes: Number(totalBytes), totalChunks: Number(totalChunks), fileName };
      this.bytes = new Uint8Array(Number(totalBytes));
      return null;
    }
    if (!['download_chunk', 'download_complete'].includes(message.type)) return null;
    if (!this.start || !this.bytes) throw new Error('缺少下载开始消息');
    if (message.totalBytes !== this.start.totalBytes) throw new Error('下载大小不一致');
    if (message.type === 'download_chunk') {
      if (message.seq !== this.seq || message.encoding !== 'base64' || typeof message.content !== 'string' || this.seq >= this.start.totalChunks) throw new Error('下载分块乱序或重复');
      const chunk = decodeDownloadChunk(message.content);
      if (chunk.length !== Math.min(DOWNLOAD_CHUNK_SIZE, this.start.totalBytes - this.offset)) throw new Error('下载分块长度不一致');
      this.bytes.set(chunk, this.offset);
      this.offset += chunk.length;
      this.seq++;
      return null;
    }
    if (this.seq !== this.start.totalChunks || this.offset !== this.start.totalBytes || message.totalChunks !== this.seq) throw new Error('下载不完整');
    this.completed = true;
    return verifyOriginal(this.bytes, this.start.fileName, message.sha256, this.digest);
  }
}

export async function verifyOriginal(bytes: Uint8Array, fileName: string, expectedHash: unknown, digest: Digest): Promise<DownloadResult> {
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('原件超过 20 MiB 上限');
  if (typeof expectedHash !== 'string' || !/^[a-f\d]{64}$/i.test(expectedHash)) throw new Error('原件缺少 SHA-256 校验值');
  const sha256 = await digest(bytes);
  if (sha256.toLowerCase() !== expectedHash.toLowerCase()) throw new Error('原件 SHA-256 校验失败，请重试');
  return { bytes, fileName, sha256 };
}

let nextRequest = 0;
export function downloadOriginal(transport: DownloadTransport, options: { threadId: string; path: string; cwd?: string; digest: Digest; signal?: AbortSignal; timeoutMs?: number; onProgress?: (received: number, total: number) => void }): Promise<DownloadResult> {
  const requestId = `download-${Date.now()}-${++nextRequest}`;
  return new Promise((resolve, reject) => {
    const assembler = new DownloadAssembler(requestId, options.digest, options);
    let settled = false;
    let received = 0;
    let chain = Promise.resolve();
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, result?: DownloadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      options.signal?.removeEventListener('abort', abort);
      if (error) {
        try { transport.sendMessage({ type: 'cancel_download', requestId }); } catch { /* disconnected */ }
        reject(error);
      } else resolve(result!);
    };
    const abort = () => finish(new Error('下载已取消'));
    const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('下载超时，请重试')), options.timeoutMs ?? 30000); };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    armTimeout();
    try {
      unsubscribe = transport.subscribeMessages(message => {
        if (message.type === 'transport_closed') { finish(new Error('连接已断开，请重新下载')); return; }
        if (settled || message.requestId !== requestId || !message.type.startsWith('download_')) return;
        chain = chain.then(async () => {
          if (settled) return;
          const result = await assembler.accept(message);
          if (settled) return;
          armTimeout();
          if (message.type === 'download_chunk') {
            received = Math.min(received + DOWNLOAD_CHUNK_SIZE, Number(message.totalBytes));
            options.onProgress?.(received, Number(message.totalBytes));
          }
          if (result) finish(undefined, result);
        }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
      });
      if (!transport.sendMessage({ type: 'download_file', requestId, threadId: options.threadId, path: options.path, ...(options.cwd ? { cwd: options.cwd } : {}) })) finish(new Error('连接未就绪，无法下载'));
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export async function downloadOriginalHttp(url: string, options: { digest: Digest; signal?: AbortSignal; fileName: string; fetcher?: typeof fetch; timeoutMs?: number }): Promise<DownloadResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, options.timeoutMs ?? 60000);
  try {
    return await readOriginalHttp(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(options.signal?.aborted ? '下载已取消' : '下载超时，请重试');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function readOriginalHttp(url: string, options: { digest: Digest; signal: AbortSignal; fileName: string; fetcher?: typeof fetch }): Promise<DownloadResult> {
  if (options.signal.aborted) throw new Error('下载已取消');
  const response = await (options.fetcher || fetch)(url, { credentials: 'include', signal: options.signal, headers: { Accept: 'application/octet-stream' } });
  if (!response.ok) throw new Error(`原件下载失败 (${response.status})`);
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_DOWNLOAD_BYTES) throw new Error('原件超过 20 MiB 上限');
  const hash = response.headers.get('x-file-sha256') || response.headers.get('x-content-sha256');
  if (!hash) throw new Error('原件缺少 SHA-256 校验值');
  const reader = response.body?.getReader();
  if (!reader) {
    return verifyOriginal(new Uint8Array(await response.arrayBuffer()), options.fileName, hash, options.digest);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error('原件超过 20 MiB 上限');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return verifyOriginal(bytes, options.fileName, hash, options.digest);
}
