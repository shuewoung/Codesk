import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeHistoryItem, deduplicateHistory, summarizeHistory } from './history-items.js';
import { createFileAccess, correlationFields } from './file-access.js';
import { artifactOutputPaths, indexArtifactEntries } from './file-artifacts.js';
import { parseGitLog, parseGitFiles, runGitReadonly } from './local-cmd.js';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

test('HTTP and WS file handlers share thread-scoped authorization; actual WS handler rejects foreign image', async t => {
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-file-ws-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imageRoot = path.join(dir, '.codex', 'generated_images', 'thread'); fs.mkdirSync(imageRoot, { recursive: true });
  const image = path.join(imageRoot, 'out.webp'); fs.writeFileSync(image, 'synthetic');
  const access = createFileAccess({ roots: [dir], deniedRoots: [path.join(dir, '.codex')], generatedImageRoot: imageRoot });
  const replies = [];
  const context = vm.createContext({ correlationFields, fileAccessFor: msg => { assert.equal(msg.threadId, 'thread'); return access; }, packFileForClient: () => ({ encoding: 'base64', content: 'c3ludGhldGlj', truncated: false }), path });
  const start = source.indexOf('async function handleLegacyClientMessage('), end = source.indexOf('\nfunction ', start);
  vm.runInContext(source.slice(start, end), context);
  const ws = { send: text => replies.push(JSON.parse(text)) };
  await context.handleLegacyClientMessage(ws, { type: 'get_file', threadId: 'thread', path: image });
  assert.equal(replies.pop().error, null);
  await context.handleLegacyClientMessage(ws, { type: 'get_file', threadId: 'thread', path: path.join(dir, '.codex', 'private.json') });
  assert.ok(replies.pop().error);
  const httpStart = source.indexOf("if (reqUrl.pathname === '/api/file')");
  assert.match(source.slice(httpStart, httpStart + 1500), /fileAccessFor\(Object.fromEntries\(reqUrl.searchParams\)\)/);
});

for (const [type, expected] of Object.entries({ Reasoning: 'reasoning', CommandExecution: 'command_execution', AgentMessage: 'agent_message', McpToolCall: 'mcp_tool_call', UserMessage: 'message', FileChange: 'file_change', ContextCompaction: 'context_compaction', ImageView: 'image_view' })) test(`normalizes ${type} and preserves metadata`, () => {
  const item = normalizeHistoryItem({ type: 'item_completed', turn_id: 'turn', item: { type, id: 'i', callId: 'c', output: { nested: ['result'] }, model: 'model' } }, 'timestamp');
  assert.equal(item.type, expected); assert.equal(item.call_id, 'c'); assert.equal(item.turn_id, 'turn'); assert.equal(item.model, 'model'); assert.deepEqual(item.output, { nested: ['result'] });
});
test('extensions retain typed search and generated-image payloads', () => {
  for (const [kind, type] of [['web.search', 'web_search'], ['image_gen.generation', 'generated_image']]) assert.equal(normalizeHistoryItem({ type: 'item_completed', item: { type: 'Extension', kind, path: 'out.webp' } }).type, type);
  assert.equal(normalizeHistoryItem({ type: 'item_completed' }), null);
});
test('dedup uses item/call aliases, keeps output separate and never dedups text', () => {
  const invocation = { type: 'function_call', id: 'item', call_id: 'call', name: 'exec' };
  const completed = { type: 'command_execution', id: 'item', completed: true, output: 'done' };
  const output = { type: 'function_call_output', call_id: 'call', output: 'done' };
  assert.equal(deduplicateHistory([invocation, completed, output]).length, 2);
  assert.equal(deduplicateHistory([completed, invocation])[0].type, 'command_execution');
  assert.equal(deduplicateHistory([{ type: 'message', text: 'repeat' }, { type: 'message', text: 'repeat' }]).length, 2);
});
test('generated images require exact authorized thread root; private files and other threads remain denied', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-images-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, '.codex'), root = path.join(home, 'generated_images', 'thread-a');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.join(home, 'generated_images', 'thread-b'));
  const good = path.join(root, 'image.webp'); fs.writeFileSync(good, 'synthetic');
  const privateFile = path.join(home, 'private.json'); fs.writeFileSync(privateFile, '{}');
  const other = path.join(home, 'generated_images', 'thread-b', 'image.png'); fs.writeFileSync(other, 'other');
  fs.writeFileSync(path.join(root, 'not-image.json'), '{}');
  const access = createFileAccess({ roots: [dir], cwd: dir, deniedRoots: [home], generatedImageRoot: root });
  assert.equal(access.authorize(good), fs.realpathSync(good));
  for (const p of [privateFile, other, root, path.join(root, 'not-image.json'), path.join(root, '..', '..', 'private.json')]) assert.equal(access.allows(p), false, p);
  assert.equal(createFileAccess({ roots: [dir], deniedRoots: [home] }).allows(good), false);
  const redirectedRoot = path.join(home, 'generated_images', 'redirected');
  fs.symlinkSync(root, redirectedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(createFileAccess({ roots: [dir], deniedRoots: [home], generatedImageRoot: redirectedRoot }).allows(path.join(redirectedRoot, 'image.webp')), false);
  const outside = path.join(dir, 'outside.png'); fs.writeFileSync(outside, 'outside');
  try { fs.symlinkSync(outside, path.join(root, 'escape.png')); assert.equal(access.allows(path.join(root, 'escape.png')), false); } catch (e) { if (e.code !== 'EPERM') throw e; t.diagnostic('File symlink creation unavailable on this Windows account'); }
});
test('typed artifact indexing preserves latest-turn boundary and excludes deleted files only from deliverables', () => {
  const indexed = indexArtifactEntries([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } }, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f', changes: [{ path: 'deliverable.txt', kind: 'add' }, { path: 'ordinary.txt', kind: 'delete' }] } } }]);
  assert.equal(indexed.turnId, 't'); assert.deepEqual(artifactOutputPaths(indexed.items[1]), ['deliverable.txt']);
  assert.equal(summarizeHistory(indexed.items).fileChanges, 2);
});
test('structured git log preserves metadata and rename destination', () => {
  const hash = 'a'.repeat(40); assert.deepEqual(parseGitLog([hash, 'Author', '2026-09-12', 'Subject', 'HEAD', '\n'].join('\0')), [{ hash, author: 'Author', date: '2026-09-12', subject: 'Subject', refs: 'HEAD' }]);
  assert.equal(parseGitFiles('R  old.txt -> new.txt\n')[0].path, 'new.txt');
});
test('git readonly includes staged deletes, binary changes, and structured commits', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-git-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  fs.writeFileSync(path.join(dir, 'delete.txt'), 'before\n'); fs.writeFileSync(path.join(dir, 'binary.bin'), Buffer.from([0, 1])); git('add', '.'); git('commit', '-m', 'fixture');
  git('rm', 'delete.txt'); fs.writeFileSync(path.join(dir, 'binary.bin'), Buffer.from([0, 2]));
  const result = await runGitReadonly(dir); assert.equal(result.error, null); assert.equal(result.commits[0].subject, 'fixture');
  assert.match(result.files.find(f => f.path === 'delete.txt').patch, /deleted file/); assert.equal(result.files.find(f => f.path === 'binary.bin').binary, true);
});
