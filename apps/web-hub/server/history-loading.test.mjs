import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { StringDecoder } from 'node:string_decoder';
import { normalizeHistoryItem, deduplicateHistory } from './history-items.js';
import { correlationFields } from './file-access.js';
import { keepHistoryItemPayload, commandFromFunctionCall, snapshotParseState } from './turn-status.js';

// Exercise the actual parser without starting Hub, Codex or touching real sessions.
const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
function parser(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const context = vm.createContext({
    fs: { ...fs, readSync: (...args) => { reads++; return fs.readSync(...args); } },
    Buffer, StringDecoder, console, HISTORY_LIMIT: 250, FULL_HISTORY_LIMIT: 2000,
    rolloutParseState: new Map(), olderHistoryCache: new Map(),
    keepHistoryItemPayload, commandFromFunctionCall, snapshotParseState, normalizeHistoryItem, deduplicateHistory,
    applyLockOverride() {}, overlayLiveApproval: (_, value) => value,
    threadLockHolder: () => null, listSubagentsForParent: () => [], mergeAccountQuota: value => value,
  });
  vm.runInContext(section('function createEmptyParseState(', 'function rolloutTailIsComplete(')
    + section('function packHistoryResult(', 'const FILE_WALK_SKIP'), context);
  const file = path.join(dir, 'rollout.jsonl');
  return { context, file, reads: () => reads, parse: (options = {}, id = 'fixture') => context.parseRolloutHistory(file, new Set(), id, options) };
}
const line = i => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: String(i) } }) + '\n';

test('incremental typed completion enriches an invocation without losing output records', t => {
  const f = parser(t);
  fs.writeFileSync(f.file, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', id: 'item', call_id: 'call', name: 'exec', arguments: '{}' } }) + '\n');
  const first = f.parse(); assert.equal(first.items.length, 1);
  fs.appendFileSync(f.file, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'item', command: 'pwd', status: 'completed' } } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'done' } }) + '\n');
  const next = f.parse(); assert.equal(next.items.length, 2); assert.equal(next.items[0].type, 'command_execution'); assert.equal(next.items[1].output, 'done'); assert.equal(next.hasMore, false);
  assert.equal(f.parse().rev, next.rev);
});

test('real WS history handler echoes each request ID without tagging unrelated broadcasts', async () => {
  const responses = [];
  let options;
  const peer = { send: value => responses.push(JSON.parse(value)) };
  const context = vm.createContext({
    correlationFields, findRolloutFilePathFast: () => 'fixture', getActiveLockThreadIds: () => new Set(),
    parseRolloutHistory: (_path, _locks, _id, opts) => { options = opts; return { items: [], totalItems: 0 }; },
    slimRelayApp: value => value, setupRolloutWatcher() {},
  });
  const start = source.indexOf('async function handleLegacyClientMessage(');
  const end = source.indexOf('\nfunction ', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  await context.handleLegacyClientMessage(peer, { type: 'get_thread_history', threadId: 'fixture', requestId: 'first' });
  assert.equal(responses[0].requestId, 'first');
  await context.handleLegacyClientMessage(peer, { type: 'get_thread_history', threadId: 'fixture', requestId: 'older', all: true, limit: 4000 });
  assert.equal(responses[1].requestId, 'older');
  assert.equal(responses[1].data.full, true);
  assert.equal(options.limit, 4000);
  await context.handleLegacyClientMessage(peer, { type: 'get_thread_history', requestId: 'missing-thread' });
  assert.equal(responses[2].requestId, 'missing-thread');
  assert.ok(responses[2].error);
  peer.send(JSON.stringify({ type: 'thread_update' }));
  assert.equal(responses[3].requestId, undefined);
});

test('cold window, unchanged cache and saturated-window delta preserve each message', t => {
  const p = parser(t);
  fs.writeFileSync(p.file, Array.from({ length: 510 }, (_, i) => line(i)).join(''));
  const first = p.parse();
  assert.equal(first.items.length, 250);
  assert.equal(first.totalItems, 510);
  const reads = p.reads();
  assert.equal(p.parse().rev, first.rev);
  assert.equal(p.reads(), reads);
  fs.appendFileSync(p.file, line('next'));
  const next = p.parse();
  assert.equal(next.delta.baseRev, first.rev);
  assert.equal(next.delta.newItems.length, 1);
  assert.equal(next.delta.newItems[0].content, 'next');
  assert.equal(next.totalItems, 511);
  fs.appendFileSync(p.file, Array.from({ length: 251 }, (_, i) => line(i)).join(''));
  assert.equal(p.parse().delta, null, 'oversized delta cannot silently skip items');
});

test('cold and incremental partial lines preserve UTF-8 and revision exactly once', t => {
  const p = parser(t);
  const bytes = Buffer.from(line('中文'));
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  fs.writeFileSync(p.file, bytes.subarray(0, split));
  assert.equal(p.parse().rev, 0);
  fs.appendFileSync(p.file, bytes.subarray(split));
  const next = p.parse();
  assert.equal(next.rev, 1);
  assert.equal(next.items[0].content, '中文');
  assert.equal(p.parse().totalItems, 1);
  fs.writeFileSync(p.file, line('short'));
  const reset = p.parse();
  assert.equal(reset.rev, 1);
  assert.equal(reset.items[0].content, 'short');
  assert.equal(reset.delta, null);
});

test('older history expands beyond 2000, caches retries and never pollutes live state', t => {
  const p = parser(t);
  fs.writeFileSync(p.file, Array.from({ length: 2579 }, (_, i) => line(i)).join(''));
  const live = p.parse();
  const older = p.parse({ all: true });
  assert.equal(older.items.length, 2000);
  assert.equal(older.hasMore, true);
  const reads = p.reads();
  p.parse({ all: true });
  assert.equal(p.reads(), reads);
  const full = p.parse({ all: true, limit: 4000 });
  assert.equal(full.items.length, 2579);
  assert.equal(full.items[0].content, '0');
  assert.equal(full.hasMore, false);
  assert.equal(p.parse().rev, live.rev);
  fs.appendFileSync(p.file, line('appended'));
  assert.equal(p.parse().delta.newItems[0].content, 'appended');
  assert.equal(p.parse({ all: true, limit: 4000 }).items.at(-1).content, 'appended');
  p.parse({ all: true }, 'other');
  p.parse({ all: true }, 'third');
  assert.equal(p.context.olderHistoryCache.size, 2);
});
