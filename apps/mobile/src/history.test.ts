import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_TTL_MS,
  approvalFromHistory,
  approvalFromMessage,
  collectApprovalIds,
  decodeApprovalCommand,
  emptyHistory,
  flattenItems,
  groupCommandNodes,
  commandGroupCounts,
  isApprovalExpired,
  mergeHistory,
  parseThreadList,
} from './history';

test('flattenItems keeps user/assistant text and skips developer/context', () => {
  const bubbles = flattenItems([
    { type: 'message', role: 'developer', content: 'hidden' },
    { type: 'message', role: 'user', content: '<app-context>skip</app-context>' },
    { type: 'message', role: 'user', content: '<user_instructions>sys</user_instructions>\n你好' },
    { type: 'message', role: 'assistant', content: [{ text: '收到' }] },
    { type: 'message', role: 'assistant', content: '继续' },
    { type: 'reasoning', content: 'think' },
  ]);
  assert.deepEqual(
    bubbles.map((b) => [b.kind, b.text]),
    [
      ['user', '你好'],
      ['assistant', '收到\n\n继续'],
    ],
  );
});

test('flattenItems folds command, patch and subagent into text', () => {
  const bubbles = flattenItems([
    { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo hi' }) },
    { type: 'file_change', patch: 'diff --git a/a' },
    { type: 'agent_message', author: 'Main writer', content: 'NEW_TASK' },
  ]);
  assert.equal(bubbles[0].kind, 'command');
  assert.match(bubbles[0].text, /echo hi/);
  assert.equal(bubbles[1].kind, 'diff');
  assert.equal(bubbles[2].kind, 'system');
  assert.match(bubbles[2].text, /已更新/);
});

test('mergeHistory applies matching delta and replaces on mismatch', () => {
  const prev = {
    ...emptyHistory(),
    items: [{ type: 'message', role: 'user', content: 'a' }],
    rev: 3,
    status: 'working',
  };
  const delta = mergeHistory(prev, {
    items: [],
    status: 'idle',
    rev: 4,
    delta: { baseRev: 3, newItems: [{ type: 'message', role: 'assistant', content: 'b' }] },
    pendingApproval: null,
  });
  assert.equal(delta.items.length, 2);
  assert.equal(delta.status, 'idle');
  assert.equal(delta.pendingApproval, null);

  const replaced = mergeHistory(prev, {
    items: [{ type: 'message', role: 'assistant', content: 'full' }],
    status: 'idle',
    rev: 9,
    delta: { baseRev: 1, newItems: [{ type: 'message', content: 'nope' }] },
  });
  assert.equal(replaced.items.length, 1);
  assert.equal((replaced.items[0] as { content?: string }).content, 'full');
});

test('parseThreadList dedupes and groups by project when projects missing', () => {
  const parsed = parseThreadList({
    threads: [
      { id: 't1', title: '一', projectName: 'A' },
      { id: 't1', title: '重复' },
      { id: 't2', title: '二' },
    ],
  });
  assert.deepEqual(parsed.threads.map((t) => t.id), ['t1', 't2']);
  assert.equal(parsed.projects.length, 2);
  assert.equal(parsed.projects[0].name, 'A');
  assert.equal(parsed.projects[1].name, '其他项目');
});

test('parseThreadList prefers server projects', () => {
  const parsed = parseThreadList({
    threads: [{ id: 't1', title: '一' }],
    projects: [{ name: '桌面项目', threads: [{ id: 't1', title: '一' }] }],
  });
  assert.equal(parsed.projects[0].name, '桌面项目');
});

test('approval parsers require ids and keep protocol decisions untouched', () => {
  assert.equal(approvalFromHistory('th', emptyHistory()), null);
  assert.deepEqual(
    approvalFromHistory('th', {
      ...emptyHistory(),
      pendingApproval: { id: 'req-1', command: 'rm -rf', reason: 'danger', type: 'command' },
    }),
    { requestId: 'req-1', ids: [], threadId: 'th', kind: 'command', command: 'rm -rf', reason: 'danger', at: undefined, source: 'history' },
  );
  assert.equal(approvalFromMessage({ type: 'approval_request', threadId: 'th' }), null);
  const at = Date.now();
  const fromMsg = approvalFromMessage({
    type: 'approval_request',
    threadId: 'th',
    requestId: 'req-2',
    kind: 'file',
    command: 'patch',
    at,
  });
  assert.equal(fromMsg?.requestId, 'req-2');
  assert.equal(fromMsg?.source, 'live');
  assert.equal(fromMsg?.at, at);
});

test('groupCommandNodes collapses consecutive terminal commands', () => {
  const grouped = groupCommandNodes([
    { id: 'u1', kind: 'user', text: 'go' },
    { id: 'c1', kind: 'command', text: 'exec' },
    { id: 'c2', kind: 'command', text: 'exec' },
    { id: 'c3', kind: 'command', text: 'followup task' },
    { id: 'a1', kind: 'assistant', text: 'done' },
    { id: 'c4', kind: 'command', text: 'exec' },
  ]);
  assert.equal(grouped.length, 4);
  assert.equal(grouped[0].kind, 'user');
  assert.equal(grouped[1].kind, 'cmd-group');
  if (grouped[1].kind === 'cmd-group') {
    assert.equal(grouped[1].commands.length, 3);
    assert.deepEqual(commandGroupCounts(grouped[1].commands), [
      { label: 'exec', count: 2 },
      { label: 'followup task', count: 1 },
    ]);
  }
  assert.equal(grouped[2].kind, 'assistant');
  assert.equal(grouped[3].kind, 'cmd-group');
});

test('collectApprovalIds and percent-encoded commands decode', () => {
  assert.equal(isApprovalExpired({ at: Date.now() - APPROVAL_TTL_MS - 1 }), true);
  assert.deepEqual(collectApprovalIds({ requestId: 'a', id: 'a', ids: ['b', 'a'] }), ['a', 'b']);
  assert.match(decodeApprovalCommand('C:\\x\\D%3A%5C06_%E7%9F%AD'), /06_短/);
});
