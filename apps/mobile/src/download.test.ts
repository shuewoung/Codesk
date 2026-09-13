import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DownloadAssembler, DOWNLOAD_CHUNK_SIZE, MAX_DOWNLOAD_BYTES, downloadOriginal, downloadOriginalHttp, type DownloadMessage } from './download';
const digest = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const start = (size = 3): DownloadMessage => ({ type: 'download_start', requestId: 'r', threadId: 't', path: '/p', fileName: 'a.docx', totalBytes: size, totalChunks: Math.ceil(size / DOWNLOAD_CHUNK_SIZE), chunkSize: DOWNLOAD_CHUNK_SIZE });
const chunk = (extra = {}): DownloadMessage => ({ type: 'download_chunk', requestId: 'r', seq: 0, encoding: 'base64', content: 'YWJj', totalBytes: 3, ...extra });
const complete = async (extra = {}): Promise<DownloadMessage> => ({ type: 'download_complete', requestId: 'r', totalBytes: 3, totalChunks: 1, sha256: await digest(Buffer.from('abc')), ...extra });

test('assembles exact original bytes and checks SHA-256', async () => {
  const assembler = new DownloadAssembler('r', digest, { threadId: 't', path: 'p' });
  assert.equal(await assembler.accept({ ...start(), requestId: 'other' }), null);
  await assembler.accept(start()); await assembler.accept(chunk());
  const result = await assembler.accept(await complete());
  assert.equal(Buffer.from(result!.bytes).toString(), 'abc');
  assert.equal(result!.fileName, 'a.docx');
  await assert.rejects(assembler.accept(await complete()), /已结束/);
});

test('rejects oversized, malformed and duplicate starts', async () => {
  for (const message of [start(MAX_DOWNLOAD_BYTES + 1), { ...start(), totalChunks: 2 }, { ...start(), chunkSize: 1 }, { ...start(), totalBytes: -1 }]) {
    await assert.rejects(new DownloadAssembler('r', digest).accept(message), /无效/);
  }
  const assembler = new DownloadAssembler('r', digest); await assembler.accept(start());
  await assert.rejects(assembler.accept(start()), /无效/);
});

test('rejects missing start, out of order, malformed base64, short and duplicate chunks', async () => {
  await assert.rejects(new DownloadAssembler('r', digest).accept(chunk()), /开始/);
  for (const value of [chunk({ seq: 1 }), chunk({ content: '!!!!' }), chunk({ content: 'YQ==' }), chunk({ totalBytes: 4 }), chunk({ encoding: 'utf8' })]) {
    const assembler = new DownloadAssembler('r', digest); await assembler.accept(start());
    await assert.rejects(assembler.accept(value));
  }
  const assembler = new DownloadAssembler('r', digest); await assembler.accept(start()); await assembler.accept(chunk());
  await assert.rejects(assembler.accept(chunk()), /乱序或重复/);
});

test('rejects incomplete or corrupted originals', async () => {
  const missing = new DownloadAssembler('r', digest); await missing.accept(start());
  await assert.rejects(missing.accept(await complete()), /不完整/);
  const corrupt = new DownloadAssembler('r', digest); await corrupt.accept(start()); await corrupt.accept(chunk());
  await assert.rejects(corrupt.accept(await complete({ sha256: '0'.repeat(64) })), /校验失败/);
});

test('supports empty originals and multi-chunk boundary', async () => {
  for (const size of [0, DOWNLOAD_CHUNK_SIZE + 1]) {
    const assembler = new DownloadAssembler('r', digest); const bytes = new Uint8Array(size).fill(17);
    await assembler.accept(start(size));
    for (let offset = 0, seq = 0; offset < size; offset += DOWNLOAD_CHUNK_SIZE, seq++) {
      await assembler.accept(chunk({ seq, totalBytes: size, content: Buffer.from(bytes.subarray(offset, offset + DOWNLOAD_CHUNK_SIZE)).toString('base64') }));
    }
    const result = await assembler.accept(await complete({ totalBytes: size, totalChunks: Math.ceil(size / DOWNLOAD_CHUNK_SIZE), sha256: await digest(bytes) }));
    assert.deepEqual(result!.bytes, bytes);
  }
});

function transport() {
  let listener: ((msg: DownloadMessage) => void) | undefined;
  let removed = 0;
  const sent: DownloadMessage[] = [];
  return { sent, get removed() { return removed; }, emit: (msg: DownloadMessage) => listener?.(msg), sendMessage: (msg: DownloadMessage) => { sent.push(msg); return true; }, subscribeMessages: (fn: (msg: DownloadMessage) => void) => { listener = fn; return () => { removed++; listener = undefined; }; } };
}

test('client cancels and unsubscribes on disconnect, abort, timeout and server errors', async () => {
  for (const reason of ['disconnect', 'abort', 'timeout', 'server']) {
    const wire = transport(); const controller = new AbortController();
    const promise = downloadOriginal(wire, { threadId: 't', path: 'p', digest, signal: controller.signal, timeoutMs: 10 });
    if (reason === 'disconnect') wire.emit({ type: 'transport_closed' });
    if (reason === 'abort') controller.abort();
    if (reason === 'server') wire.emit({ type: 'download_error', requestId: wire.sent[0].requestId, error: 'denied' });
    await assert.rejects(promise);
    assert.equal(wire.removed, 1);
    assert.equal(wire.sent.at(-1)?.type, 'cancel_download');
  }
});

test('client success unsubscribes without cancellation; send failure never queues', async () => {
  const wire = transport(); const promise = downloadOriginal(wire, { threadId: 't', path: 'p', digest });
  const requestId = wire.sent[0].requestId;
  wire.emit({ ...start(), requestId }); wire.emit({ ...chunk(), requestId }); wire.emit({ ...await complete(), requestId });
  assert.equal((await promise).bytes.length, 3); assert.equal(wire.removed, 1); assert.equal(wire.sent.length, 1);
  await assert.rejects(downloadOriginal({ ...transport(), sendMessage: () => false }, { threadId: 't', path: 'p', digest }), /未就绪/);
});

test('HTTP original uses credentials and verifies hash, rejecting missing hashes and HTTP failure', async () => {
  let credentials: RequestCredentials | undefined;
  const fetcher = (async (_url: unknown, init: RequestInit) => { credentials = init.credentials; return new Response('abc', { headers: { 'x-file-sha256': await digest(Buffer.from('abc')) } }); }) as typeof fetch;
  assert.equal((await downloadOriginalHttp('/api/file?download=original', { digest, fileName: 'a', fetcher })).bytes.length, 3);
  assert.equal(credentials, 'include');
  for (const response of [new Response('abc'), new Response('no', { status: 403 }), new Response('abc', { headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } })]) {
    await assert.rejects(downloadOriginalHttp('/api/file', { digest, fileName: 'a', fetcher: (async () => response) as typeof fetch }));
  }
});

test('HTTP deadline covers body reading; user cancellation propagates', async () => {
  const fetcher = (async (_url: unknown, init: RequestInit) => new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))); } }), { headers: { 'x-file-sha256': '0'.repeat(64) } })) as typeof fetch;
  await assert.rejects(downloadOriginalHttp('/api/file', { digest, fileName: 'a', fetcher, timeoutMs: 10 }), /超时/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadOriginalHttp('/api/file', { digest, fileName: 'a', fetcher, signal: controller.signal }), /取消/);
});
