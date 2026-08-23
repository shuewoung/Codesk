import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvalKindFallbacks,
  approvalMethodFromKind,
  approvalRequestIdCandidates,
  buildApprovalParams,
  overlayPendingWithLive,
} from './ipc-client.js';

test('approvalMethodFromKind maps file/permission/command', () => {
  assert.equal(
    approvalMethodFromKind('item/fileChange/requestApproval'),
    'thread-follower-file-approval-decision',
  );
  assert.equal(
    approvalMethodFromKind('item/permissions/requestApproval'),
    'thread-follower-permissions-request-approval-response',
  );
  assert.equal(
    approvalMethodFromKind('item/commandExecution/requestApproval'),
    'thread-follower-command-approval-decision',
  );
});

test('live JSON-RPC ids come before JSONL entry ids', () => {
  const ids = approvalRequestIdCandidates({
    liveRows: [{ id: 'rpc-live', itemId: 'item-1' }],
    requestId: 'jsonl-entry',
    extraIds: ['jsonl-call'],
  });
  assert.deepEqual(ids, ['rpc-live', 'jsonl-call', 'jsonl-entry']);
});

test('overlayPendingWithLive replaces JSONL id with Desktop snapshot id', () => {
  const overlay = overlayPendingWithLive(
    { id: 'jsonl-1', ids: ['jsonl-1', 'call-9'], type: 'item/commandExecution/requestApproval', command: 'git status' },
    [{ id: 'rpc-22', method: 'item/commandExecution/requestApproval', command: 'git status', itemId: 'item-x' }],
  );
  assert.equal(overlay.id, 'rpc-22');
  assert.ok(overlay.ids.includes('rpc-22'));
  assert.ok(overlay.ids.includes('jsonl-1'));
  assert.equal(overlay.type, 'item/commandExecution/requestApproval');
});

test('kind fallbacks try the inferred method first', () => {
  const methods = approvalKindFallbacks('item/fileChange/requestApproval');
  assert.equal(methods[0], 'thread-follower-file-approval-decision');
  assert.equal(methods.length, 3);
});

test('permissions acceptForSession uses session scope', () => {
  const { method, params } = buildApprovalParams({
    conversationId: 't1',
    requestId: 'r1',
    decision: 'acceptForSession',
    kind: 'permissions',
  });
  assert.equal(method, 'thread-follower-permissions-request-approval-response');
  assert.equal(params.response.scope, 'session');
});
