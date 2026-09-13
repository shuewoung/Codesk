import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_TTL_MS,
  hasOpenDelegatedAgent,
  isApprovalExpired,
  isNonUserThreadRecord,
  keepHistoryItemPayload,
  parseThreadSpawn,
  resolveLiveStatus,
  threadIdFromRolloutName,
} from './turn-status.js';

test('isApprovalExpired requires a timestamp and respects TTL', () => {
  assert.equal(isApprovalExpired(null), false);
  assert.equal(isApprovalExpired({}), false);
  assert.equal(isApprovalExpired({ at: Date.now() }), false);
  assert.equal(isApprovalExpired({ at: Date.now() - APPROVAL_TTL_MS - 1 }), true);
});

test('hasOpenDelegatedAgent only matches add_delegated_agent', () => {
  assert.equal(hasOpenDelegatedAgent(null), false);
  assert.equal(hasOpenDelegatedAgent(new Map()), false);
  assert.equal(hasOpenDelegatedAgent(new Map([['1', { name: 'exec_command' }]])), false);
  assert.equal(hasOpenDelegatedAgent(new Map([['1', { name: 'add_delegated_agent' }]])), true);
});

test('resolveLiveStatus ignores stale locks and needs live tail or live children', () => {
  const stale = { mtimeMs: Date.now() - 180000 };
  const closedTail = { open: false };
  assert.equal(resolveLiveStatus('waiting_approval', { tail: closedTail, stats: stale }), 'waiting_approval');
  assert.equal(resolveLiveStatus('working', { tail: closedTail, stats: stale }), 'idle');
  assert.equal(resolveLiveStatus('working', { hasLock: true, tail: closedTail, stats: stale }), 'idle');
  assert.equal(resolveLiveStatus('working', {
    hasOpenDelegatedAgent: true,
    tail: closedTail,
    stats: stale,
  }), 'idle');
  assert.equal(resolveLiveStatus('idle', {
    tail: { open: true },
    stats: { mtimeMs: Date.now() },
  }), 'working');
  assert.equal(resolveLiveStatus('working', {
    hasLiveChildren: true,
    tail: closedTail,
    stats: stale,
  }), 'working');
});

test('isNonUserThreadRecord hides spawned subagents, guardians and exec', () => {
  assert.equal(isNonUserThreadRecord('user', 'vscode'), false);
  assert.equal(isNonUserThreadRecord('user', 'exec'), true);
  assert.equal(isNonUserThreadRecord('subagent', 'vscode'), true);
  const spawn = JSON.stringify({
    subagent: {
      thread_spawn: {
        parent_thread_id: 'parent-1',
        depth: 2,
        agent_nickname: 'Herschel',
      },
    },
  });
  assert.equal(isNonUserThreadRecord('subagent', spawn), true);
  assert.equal(isNonUserThreadRecord('user', spawn), true);
  assert.equal(isNonUserThreadRecord('subagent', JSON.stringify({ subagent: { other: 'guardian' } })), true);
  assert.deepEqual(parseThreadSpawn(spawn), {
    kind: 'subagent',
    parentThreadId: 'parent-1',
    depth: 2,
  });
});

test('threadIdFromRolloutName uses the last UUID for spawned subagent files', () => {
  const parent = '01a056af-3036-75d2-ba1f-46420c45c77e';
  const child = '01a0572e-33b2-7153-aa07-9e6bfe3456a8';
  assert.equal(
    threadIdFromRolloutName(`rollout-2026-08-31T15-18-36-${parent}.jsonl`),
    parent,
  );
  assert.equal(
    threadIdFromRolloutName(`rollout-2026-08-31T17-37-20-${parent}_${child}.jsonl`),
    child,
  );
  assert.equal(threadIdFromRolloutName('notes.txt'), '');
});

test('keepHistoryItemPayload retains typed completions and outputs', () => {
  assert.equal(keepHistoryItemPayload('message'), true);
  assert.equal(keepHistoryItemPayload('reasoning'), true);
  assert.equal(keepHistoryItemPayload('custom_tool_call'), true);
  assert.equal(keepHistoryItemPayload('item_completed'), true);
  assert.equal(keepHistoryItemPayload('thread_settings_applied'), false);
  assert.equal(keepHistoryItemPayload('custom_tool_call_output'), true);
});

// Exercise the real incremental orchestration without starting the Hub or reading user rollouts.
test('incremental history packs the overridden view without contaminating cached parse state', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function parseRolloutHistory(');
  const end = source.indexOf('const FILE_WALK_SKIP', start);
  assert.ok(start >= 0 && end > start);
  const cached = { items: [], rev: 1, offset: 0, mtimeMs: 0, restBytes: '', status: 'idle' };
  const chunk = Buffer.from('{}\n');
  const context = {
    Buffer, console, HISTORY_LIMIT: 200,
    rolloutParseState: new Map([['thread', cached]]),
    fs: { existsSync: () => true, statSync: () => ({ size: chunk.length, mtimeMs: 1 }),
      openSync: () => 1, readSync: (_fd, buf) => chunk.copy(buf), closeSync: () => {} },
    readRolloutIntoState: (_file, _stats, state) => { state.rev++; const item = { text: 'new' }; state.items.push(item); return [item]; },
    snapshotParseState: (state) => ({ ...state, items: [...state.items] }),
    applyLockOverride: (view) => { view.status = 'working'; },
    packHistoryResult: (state, delta) => ({ status: state.status, delta }),
  };
  const result = vm.runInNewContext(`${source.slice(start, end)}; parseRolloutHistory('fixture', new Set(), 'thread');`, context);
  assert.equal(result.status, 'working');
  assert.equal(cached.status, 'idle');
  assert.equal(result.delta.baseRev, 1);
  assert.equal(result.delta.newItems.length, 1);
});
