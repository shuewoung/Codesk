import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createFileAccess, correlationFields, readBoundedFile } from './file-access.js';
import { artifactOutputPaths, collectArtifacts, indexArtifactEntries, readArtifactItems } from './file-artifacts.js';
import { createDownloadManager, DOWNLOAD_CHUNK_SIZE, DOWNLOAD_LIMIT } from './file-download.js';
import { buildDirectoryHtml, pickRawServePath } from './file-raw.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesk-file-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const uploads = path.join(root, 'private', 'hub-uploads');
  for (const dir of [workspace, outside, uploads]) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(workspace, 'report.docx');
  fs.writeFileSync(file, 'original document bytes');
  const access = createFileAccess({ roots: [workspace], uploadDir: uploads, cwd: workspace });
  return { root, workspace, outside, uploads, file, access };
}

test('authorization never promotes request cwd or prefix sibling to root', (t) => {
  const f = fixture(t);
  const secret = path.join(f.outside, 'secret.txt'); fs.writeFileSync(secret, 'secret');
  assert.equal(f.access.authorize('report.docx'), fs.realpathSync(f.file));
  assert.throws(() => f.access.authorize(secret));
  assert.throws(() => f.access.authorize('../outside/secret.txt'));
  assert.throws(() => f.access.authorize('secret.txt', f.outside));
  assert.throws(() => f.access.authorize('%2e%2e/outside/secret.txt'));
  assert.throws(() => f.access.authorize(f.workspace + '-other'));
  const upload = path.join(f.uploads, 'file.txt'); fs.writeFileSync(upload, 'upload');
  assert.equal(f.access.authorize(upload), fs.realpathSync(upload));
});

test('realpath rejects junction escape and raw directory hides unauthorized children', (t) => {
  const f = fixture(t);
  const link = path.join(f.workspace, 'escape');
  fs.writeFileSync(path.join(f.outside, 'secret.txt'), 'secret');
  fs.symlinkSync(f.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.access.authorize(path.join(link, 'secret.txt')));
  assert.doesNotMatch(buildDirectoryHtml(f.workspace, f.access), /escape/);
});

test('private Hub roots remain forbidden even under a broad session cwd', (t) => {
  const f = fixture(t);
  const privateRoot = path.dirname(f.uploads);
  const secret = path.join(privateRoot, 'auth.json'); fs.writeFileSync(secret, '{}');
  const upload = path.join(f.uploads, 'attachment.txt'); fs.writeFileSync(upload, 'ok');
  const access = createFileAccess({ roots: [f.root], cwd: f.root, uploadDir: f.uploads, deniedRoots: [privateRoot] });
  assert.throws(() => access.authorize(secret));
  assert.equal(access.authorize(upload), fs.realpathSync(upload));
});

test('correlation supports legacy and echoes upload task/thread/request identifiers', () => {
  assert.deepEqual(correlationFields({}), {});
  assert.deepEqual(correlationFields({ requestId: 'r', taskId: 'u', threadId: 't' }, true), { requestId: 'r', taskId: 'u', threadId: 't' });
  assert.deepEqual(correlationFields({ requestId: {}, taskId: [] }, true), {});
});

test('artifact recognition requires successful explicit output, stat and authorization', (t) => {
  const f = fixture(t);
  const item = { type: 'function_call_output', call_id: 'call', output: { success: true, outputPath: f.file } };
  const artifacts = collectArtifacts([item], f.access, { threadId: 't' });
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0].size, fs.statSync(f.file).size);
  assert.equal(artifacts[0].source, 'tool_output'); assert.equal(artifacts[0].evidence.stat, true);
  for (const bad of [
    { type: 'message', output: item.output },
    { ...item, output: { success: false, outputPath: f.file } },
    { ...item, output: { success: true, path: f.file } },
    { ...item, output: { success: true, outputPath: path.join(f.workspace, 'missing.pdf') } },
    { ...item, output: { success: true, outputPath: f.outside } },
  ]) assert.deepEqual(collectArtifacts([bad], f.access), []);
  assert.deepEqual(artifactOutputPaths({ type: 'function_call_output', output: `Process exited with code 0\nSaved to: ${f.file}` }), [f.file]);
  assert.deepEqual(artifactOutputPaths({ type: 'function_call_output', output: `Process exited with code 0\n${f.file}` }), []);
});

test('WS downloads exact original with sequential 256KiB chunks and SHA256', async (t) => {
  const f = fixture(t); const bytes = crypto.randomBytes(DOWNLOAD_CHUNK_SIZE * 2 + 11); fs.writeFileSync(f.file, bytes);
  fs.mkdirSync(path.join(f.workspace, '.web-preview'));
  fs.writeFileSync(path.join(f.workspace, '.web-preview', 'report.pdf'), 'sidecar');
  assert.equal(pickRawServePath(f.file, false).kind, 'preview');
  const frames = [];
  const manager = createDownloadManager({ send: (m) => frames.push(m), authorize: (m) => f.access.authorize(m.path) });
  await manager.start({ requestId: 'r', threadId: 't', path: f.file });
  assert.equal(frames[0].type, 'download_start'); assert.equal(frames[0].chunkSize, DOWNLOAD_CHUNK_SIZE);
  const chunks = frames.filter((m) => m.type === 'download_chunk');
  assert.deepEqual(chunks.map((m) => m.seq), [0, 1, 2]);
  assert.deepEqual(Buffer.concat(chunks.map((m) => Buffer.from(m.content, 'base64'))), bytes);
  assert.equal(frames.at(-1).sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manager.size, 0); assert.ok(frames.every((m) => m.requestId === 'r'));
});

test('empty files complete; oversize, missing and directory downloads fail', async (t) => {
  const f = fixture(t); const frames = [];
  const manager = createDownloadManager({ send: (m) => frames.push(m), authorize: (m) => f.access.authorize(m.path) });
  fs.writeFileSync(f.file, ''); await manager.start({ requestId: 'empty', path: f.file });
  assert.equal(frames.at(-1).totalChunks, 0); assert.equal(frames.at(-1).type, 'download_complete');
  fs.truncateSync(f.file, DOWNLOAD_LIMIT + 1); await manager.start({ requestId: 'large', path: f.file });
  assert.equal(frames.at(-1).code, 'TOO_LARGE');
  await manager.start({ requestId: 'dir', path: f.workspace }); assert.equal(frames.at(-1).type, 'download_error');
  await manager.start({ path: f.file }); assert.equal(frames.at(-1).code, 'INVALID_REQUEST');
  await manager.start({ requestId: 'missing', path: path.join(f.workspace, 'gone') }); assert.equal(frames.at(-1).type, 'download_error');
});

test('cancel, duplicate ID, mutation and disconnect never complete partial downloads', async (t) => {
  const f = fixture(t);
  for (const mode of ['cancel', 'duplicate', 'mutation', 'disconnect']) {
    fs.writeFileSync(f.file, Buffer.alloc(DOWNLOAD_CHUNK_SIZE + 12));
    const frames = []; let open = true;
    const manager = createDownloadManager({ authorize: () => f.file, isOpen: () => open, send(m) {
      frames.push(m);
      if (m.type === 'download_chunk' && m.seq === 0) {
        if (mode === 'cancel') manager.cancel('r');
        if (mode === 'duplicate') void manager.start({ requestId: 'r' });
        if (mode === 'mutation') fs.truncateSync(f.file, 2);
        if (mode === 'disconnect') { open = false; manager.close(); }
      }
    } });
    await manager.start({ requestId: 'r' });
    assert.ok(!frames.some((m) => m.type === 'download_complete'), mode);
    if (mode !== 'disconnect') assert.equal(frames.at(-1).type, 'download_error');
    assert.equal(manager.size, 0);
  }
});

// Execute the actual handler body with isolated dependencies; never import the
// listening server, start services or touch the user's CODEX_HOME.
const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function isolatedHandler(deps) {
  // File operations delegate to this production handler; workbench's dispatch
  // and persistence are exercised independently over real WS in workbench.test.
  const body = source.slice(source.indexOf('async function handleLegacyClientMessage('), source.indexOf('function fileAccessFor('));
  return vm.runInNewContext(`${body}; handleLegacyClientMessage`, { correlationFields, Proxy, Reflect, JSON, identity: { hubId: 'isolated' }, workbenchCapabilities: () => ({}), ...deps });
}

test('actual WS handler correlates threads/history/search/file/tree/artifacts and uploads', async () => {
  const replies = [];
  const ws = { send: (data) => replies.push(JSON.parse(data)) };
  const handler = isolatedHandler({
    getThreadList: () => [], readCodexConfig: () => ({}), accountQuotaCache: { value: {} }, localHostName: () => 'test', getAccountQuota: () => Promise.resolve(null), pendingPinMaterialize: false,
    findRolloutFilePathFast: () => '', getActiveLockThreadIds: () => new Set(), parseRolloutHistory: () => ({ items: [] }), slimRelayApp: (m) => m, setupRolloutWatcher: () => {},
    fileAccessFor: () => { throw new Error('denied'); },
    path, Buffer, fs: { mkdirSync() {}, writeFileSync() {} }, UPLOAD_DIR: 'isolated', crypto,
  });
  for (const type of ['get_threads', 'get_thread_history', 'search_thread', 'get_file', 'get_workspace_tree', 'list_artifacts', 'search_workspace', 'upload_file']) {
    replies.length = 0;
    await handler(ws, { type, threadId: 't', requestId: type, taskId: 'task', content: 'eA==' });
    await Promise.resolve();
    assert.ok(replies.length, type); assert.equal(replies[0].requestId, type);
    if (type !== 'get_threads') assert.equal(replies[0].threadId, 't');
    if (type === 'upload_file') { assert.equal(replies[0].taskId, 'task'); assert.equal(replies[0].threadId, 't'); }
  }
});


test('artifact latest-turn boundary excludes prior results and reports tail coverage', (t) => {
  const f = fixture(t);
  const entries = [
    { type: 'event_msg', timestamp: 'one', payload: { type: 'task_started', turn_id: 'old' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: { success: true, outputPath: f.file } } },
    { type: 'event_msg', timestamp: 'two', payload: { type: 'task_started', turn_id: 'new' } },
    { type: 'turn_context', payload: { turn_id: 'new' } },
    { type: 'event_msg', timestamp: 'three', payload: { type: 'task_complete' } },
  ];
  const index = indexArtifactEntries(entries);
  assert.equal(index.scope, 'latest_turn'); assert.equal(index.turnId, 'new');
  assert.equal(index.startedAt, 'two'); assert.equal(index.completedAt, 'three');
  assert.deepEqual(collectArtifacts(index.items, f.access), []);
  const fallback = indexArtifactEntries([entries[1]]);
  assert.equal(fallback.scope, 'session_confirmed'); assert.equal(fallback.turnId, null);
  const rollout = path.join(f.workspace, 'rollout.jsonl');
  fs.writeFileSync(rollout, entries.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)));
  assert.equal(readArtifactItems(rollout).coverage.truncated, false);
  assert.equal(readArtifactItems(rollout, 80).coverage.truncated, true);
});

test('actual HTTP original route bypasses Office sidecar and sends hash/name', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, '.web-preview'));
  fs.writeFileSync(path.join(f.workspace, '.web-preview', 'report.pdf'), 'not original');
  const begin = source.indexOf("  if (reqUrl.pathname === '/api/file')");
  const end = source.indexOf("  if (reqUrl.pathname === '/api/push", begin);
  const handler = vm.runInNewContext(`(function(req,res,reqUrl) { ${source.slice(begin, end)} })`, {
    fs, path, Buffer, crypto, readBoundedFile, fileAccessFor: () => f.access,
    RAW_IMAGE_MIME: {}, FILE_RAW_LIMIT: DOWNLOAD_LIMIT, pickRawServePath,
    corsHeaders: () => ({}), rawPreviewHeaders: () => ({}),
    sendJson: (_req, res, status, data) => { res.writeHead(status, {}); res.end(Buffer.from(JSON.stringify(data))); },
  });
  const bytes = await new Promise((resolve) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(buffer) { resolve({ status: this.status, headers: this.headers, buffer }); } };
    handler({}, res, new URL(`http://localhost/api/file?download=original&path=${encodeURIComponent(f.file)}`));
  });
  assert.equal(bytes.status, 200); assert.deepEqual(bytes.buffer, fs.readFileSync(f.file));
  assert.equal(bytes.headers['X-File-SHA256'], crypto.createHash('sha256').update(bytes.buffer).digest('hex'));
  assert.match(bytes.headers['Content-Disposition'], /report.docx/);
});

test('actual WS successful file/tree/search/artifacts replies carry request and thread', async (t) => {
  const f = fixture(t), replies = [];
  const handler = isolatedHandler({
    fileAccessFor: () => ({ ...f.access, cwd: f.workspace }), path,
    packFileForClient: () => ({ encoding: 'utf8', content: 'ok', truncated: false }),
    buildWorkspaceDirectoryTreeAsync: async () => [{ path: f.file }],
    searchWorkspaceFiles: () => [{ path: f.file }],
    artifactListing: () => ({ files: [], artifacts: [], recentDocuments: [] }),
    findRolloutFilePathFast: () => 'isolated', searchThreadHistory: () => [{ text: 'hit' }],
  });
  const expected = { get_file: 'file_data', get_workspace_tree: 'workspace_tree', search_workspace: 'workspace_search', search_thread: 'search_results', list_artifacts: 'artifacts_list' };
  for (const [type, response] of Object.entries(expected)) {
    replies.length = 0;
    await handler({ send: (s) => replies.push(JSON.parse(s)) }, { type, requestId: 'r', threadId: 't', path: f.file, q: 'report' });
    await Promise.resolve();
    assert.equal(replies[0].type, response); assert.equal(replies[0].requestId, 'r'); assert.equal(replies[0].threadId, 't'); assert.equal(replies[0].error, null);
  }
});


test('actual host status returns launch/version/build/instance/pid only through local gate', () => {
  const line = source.split(String.fromCharCode(10)).find((s) => s.startsWith('const HOST_INSTANCE ='));
  const identity = vm.runInNewContext(`${line}; HOST_INSTANCE`, { require: () => ({ version: '1.2.3' }), process: { env: { CODESK_LAUNCH_ID: 'installer-launch', CODESK_BUILD: 'build-test' }, pid: 123 }, crypto });
  const start = source.indexOf('function handleHostApi(');
  const end = source.indexOf("  if (reqUrl.pathname === '/api/host/pair-code'", start);
  let local = true, result;
  const handler = vm.runInNewContext(`${source.slice(start, end)} }; handleHostApi`, {
    isLoopbackReq: () => local, expoWebDevUp: (cb) => cb(false), HOST_INSTANCE: identity,
    sendJson: (_req, _res, status, body) => { result = { status, body }; },
    identity: { hubId: 'hub' }, PORT: 18990, relayPublicState: () => ({}), lanClients: new Map(), auth: {}, localLanCode: '', listLanUrls: () => [], EXPO_WEB_PORT: 18991,
  });
  handler({ method: 'GET' }, {}, { pathname: '/api/host/status' });
  assert.equal(result.status, 200); assert.equal(result.body.launchId, 'installer-launch');
  assert.equal(result.body.version, '1.2.3'); assert.equal(result.body.build, 'build-test'); assert.equal(result.body.pid, 123);
  assert.match(result.body.instanceId, /^[a-f0-9-]{36}$/);
  local = false; handler({ method: 'GET' }, {}, { pathname: '/api/host/status' });
  assert.equal(result.status, 403); assert.equal(result.body.launchId, undefined);
});

test('actual HTTP JSON responses preserve optional query request/upload correlation', () => {
  const begin = source.indexOf('function sendJson('), end = source.indexOf('function searchThreadHistory(', begin);
  let response;
  const send = vm.runInNewContext(`${source.slice(begin, end)}; sendJson`, { URL, Object, Buffer, JSON, correlationFields, corsHeaders: () => ({}), sendBuffer: (_req, _res, _status, _mime, body) => { response = JSON.parse(body); } });
  send({ url: '/api/upload?requestId=r&taskId=u&threadId=t' }, {}, 200, { success: true });
  assert.deepEqual(response, { success: true, requestId: 'r', taskId: 'u', threadId: 't' });
  send({ url: '/api/threads?requestId=threads' }, {}, 200, { data: [] }); assert.equal(response.requestId, 'threads');
  send({ url: '/api/threads' }, {}, 200, { data: [] }); assert.equal(response.requestId, undefined);
});

test('apply_patch artifacts correlate call_id and accept standard A/M with optional colon', (t) => {
  const f = fixture(t);
  const call = { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1' };
  for (const status of ['A', 'A:', 'M', 'M:']) {
    const output = { type: 'custom_tool_call_output', call_id: 'patch-1', output: `Success. Updated the following files:\n${status} report.docx` };
    const artifacts = collectArtifacts([call, output], f.access);
    assert.equal(artifacts.length, 1, status);
    assert.equal(artifacts[0].path, fs.realpathSync(f.file));
    assert.equal(artifacts[0].callId, 'patch-1');
    assert.equal(artifacts[0].evidence.stat, true);
  }
  const functionCall = { type: 'function_call', name: 'functions.apply_patch', call_id: 'patch-2' };
  const output = { type: 'function_call_output', call_id: 'patch-2', output: 'Success. Updated the following files:\nA report.docx' };
  assert.equal(collectArtifacts([functionCall, output], f.access).length, 1);
});

test('apply_patch artifacts reject failed, uncorrelated or impersonated tool output', (t) => {
  const f = fixture(t);
  const call = { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1' };
  const output = { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'Success. Updated the following files:\nA report.docx' };
  const cases = [
    [call, { ...output, output: 'Failed to apply patch\nA report.docx' }],
    [call, { ...output, success: false }],
    [call, { ...output, isError: true }],
    [call, { ...output, output: output.output + '\nError: write failed' }],
    [{ ...call, name: 'read_file' }, output],
    [{ ...call, name: 'fake.apply_patch' }, output],
    [output],
    [call, { ...output, call_id: 'different', name: 'apply_patch' }],
    [{ type: 'message', name: 'apply_patch', call_id: 'patch-1' }, output],
    [call, { ...call, name: 'read_file' }, output],
  ];
  for (const items of cases) assert.deepEqual(collectArtifacts(items, f.access), []);
});

test('apply_patch deletes are excluded and add/modify still require authorization and stat', (t) => {
  const f = fixture(t);
  const call = { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch' };
  const result = (lines) => ({ type: 'custom_tool_call_output', call_id: 'patch', output: `Success. Updated the following files:\n${lines}` });
  for (const status of ['D', 'D:']) {
    // File deliberately exists: deletion exclusion must not rely on missing stat.
    assert.deepEqual(collectArtifacts([call, result(`${status} report.docx`)], f.access), []);
  }
  const outside = path.join(f.outside, 'secret.md'); fs.writeFileSync(outside, 'outside');
  assert.deepEqual(collectArtifacts([call, result(`A ${outside}\nM missing.md`)], f.access), []);
  const mixed = collectArtifacts([call, result('D removed.md\nM: report.docx')], f.access);
  assert.equal(mixed.length, 1); assert.equal(mixed[0].path, fs.realpathSync(f.file));
});
