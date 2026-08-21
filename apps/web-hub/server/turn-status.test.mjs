import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_TTL_MS,
  hasOpenDelegatedAgent,
  isApprovalExpired,
  isNonUserThreadRecord,
  parseThreadSpawn,
  resolveLiveStatus,
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
