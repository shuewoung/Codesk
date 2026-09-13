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
  lockBannerKind,
  mergeHistory,
  parseThreadList,
} from './history';

test('flattenItems preserves long ordinary JSON and callback-looking fields', () => {
  for (const content of [
    JSON.stringify({ status: 'ok', completed: true, description: 'normal JSON '.repeat(20) }),
    JSON.stringify([{ cell_id: 'example', value: 'x'.repeat(100) }]),
    JSON.stringify({ agent_path: '/example/path', description: 'x'.repeat(100) }),
    '```json\n' + JSON.stringify({ status: 'ok', value: 'x'.repeat(100) }) + '\n```',
  ]) {
    for (const role of ['user', 'assistant']) {
      const nodes = flattenItems([{ type: 'message', role, content }]);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].text, content);
      assert.equal(nodes[0].kind, role);
    }
  }
});

test('flattenItems still unwraps explicit subagent callbacks', () => {
  const nodes = flattenItems([{ type: 'message', role: 'user', content: JSON.stringify({
    agent_path: '/agents/worker', status: { completed: 'Finished work '.repeat(10) },
  }) }]);
  assert.equal(nodes[0].kind, 'assistant');
  assert.equal(nodes[0].text, 'Finished work '.repeat(10));
});

test('flattenItems keeps image-only user messages', () => {
  const bubbles = flattenItems([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'localImage', path: 'D:\\tmp\\a.png', name: 'a.png' }],
    },
  ]);
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].kind, 'user');
  assert.equal(bubbles[0].text, '[图片]');
  assert.equal(bubbles[0].images?.[0].path, 'D:\\tmp\\a.png');
});

test('flattenItems keeps user/assistant text and skips developer/context', () => {
  const bubbles = flattenItems([
    { type: 'message', role: 'developer', content: 'hidden' },
    { type: 'message', role: 'user', content: '<app-context>skip</app-context>' },
    { type: 'message', role: 'user', content: '<user_instructions>sys</user_instructions>\n你好' },
    { type: 'message', role: 'assistant', content: [{ text: '收到' }] },
    { type: 'message', role: 'assistant', content: '继续' },
    { type: 'reasoning', summary: [{ text: 'think' }] },
  ]);
  assert.deepEqual(
    bubbles.map((b) => [b.kind, b.text]),
    [
      ['user', '你好'],
      ['assistant', '收到\n\n继续'],
      ['reasoning', 'think'],
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
  assert.equal(bubbles[2].kind, 'agent');
  assert.match(bubbles[2].text, /已更新/);
});

test('older windows expand past 2000 and live delta retains complete history', () => {
  const items = Array.from({ length: 2579 }, (_, i) => ({ type: 'message', role: 'user', content: String(i) }));
  const first = mergeHistory(undefined, { items: items.slice(-2000), full: true, hasMore: true, totalItems: 2579, rev: 5208 });
  const full = mergeHistory(first, { items, full: true, hasMore: false, totalItems: 2579, rev: 5208 });
  assert.equal(full.items.length, 2579);
  assert.equal(full.hasMore, false);
  const next = { type: 'message', role: 'assistant', content: 'next' };
  const updated = mergeHistory(full, { items: [next], hasMore: true, totalItems: 2580, rev: 5209, delta: { baseRev: 5208, newItems: [next] } });
  assert.equal(updated.items.length, 2580);
  assert.equal(updated.items[0].content, '0');
  assert.equal(updated.items.at(-1)?.content, 'next');
  assert.equal(updated.hasMore, false);
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

test('mergeHistory keeps a longer dump when a short snapshot arrives', () => {
  const prev = {
    ...emptyHistory(),
    items: [
      { type: 'message', role: 'user', content: 'old' },
      { type: 'message', role: 'assistant', content: 'mid' },
      { type: 'message', role: 'user', content: 'new' },
    ],
    full: true,
    rev: 8,
    hasMore: false,
    totalItems: 3,
  };
  const kept = mergeHistory(prev, {
    items: [{ type: 'message', role: 'user', content: 'new' }],
    status: 'working',
    rev: 9,
    hasMore: true,
    totalItems: 3,
  });
  assert.equal(kept.items.length, 3);
  assert.equal(kept.full, true);
  assert.equal(kept.status, 'working');
  assert.equal((kept.items[0] as { content?: string }).content, 'old');
});

test('mergeHistory honors full dumps and does not trim live deltas on them', () => {
  const items = Array.from({ length: 260 }, (_, i) => ({
    type: 'message',
    role: i % 2 ? 'assistant' : 'user',
    content: String(i),
  }));
  const full = mergeHistory(emptyHistory(), { items, full: true, hasMore: false, totalItems: 260, rev: 2 });
  assert.equal(full.items.length, 260);
  assert.equal(full.full, true);

  const live = mergeHistory(full, {
    items: [],
    rev: 3,
    full: true,
    delta: { baseRev: 2, newItems: [{ type: 'message', role: 'assistant', content: 'tail' }] },
  });
  assert.equal(live.items.length, 261);
  assert.equal(live.full, true);
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

test('mergeHistory accepts desktop-stale lockHolder and keeps null/absent semantics', () => {
  const base = { ...emptyHistory(), items: [] };
  assert.equal(mergeHistory(base, { lockHolder: 'desktop' }).lockHolder, 'desktop');
  assert.equal(mergeHistory(base, { lockHolder: 'hub' }).lockHolder, 'hub');
  assert.equal(mergeHistory(base, { lockHolder: 'desktop-stale' }).lockHolder, 'desktop-stale');

  // Missing (or unrecognized) holder keeps the previous value.
  const stale = mergeHistory(base, { lockHolder: 'desktop-stale' });
  assert.equal(mergeHistory(stale, { status: 'idle' }).lockHolder, 'desktop-stale');
  assert.equal(mergeHistory(stale, { lockHolder: 'someone-else' }).lockHolder, 'desktop-stale');
  assert.equal(mergeHistory(undefined, { status: 'idle' }).lockHolder, null);

  // Explicit null clears the holder.
  assert.equal(mergeHistory(stale, { lockHolder: null }).lockHolder, null);
  // ...and a later missing holder does not resurrect it.
  const cleared = mergeHistory(stale, { lockHolder: null });
  assert.equal(mergeHistory(cleared, { status: 'working' }).lockHolder, null);
});

test('lockBannerKind maps holders to banner cases; hub renders no banner', () => {
  assert.equal(lockBannerKind('desktop'), 'desktop');
  assert.equal(lockBannerKind('desktop-stale'), 'desktop-stale');
  assert.equal(lockBannerKind('hub'), null);
  assert.equal(lockBannerKind(null), null);
  assert.equal(lockBannerKind(undefined), null);
  assert.equal(lockBannerKind('someone-else'), null);

  // Holder transitions resolved through mergeHistory render/disappear correctly:
  // desktop -> desktop-stale -> hub (no banner) -> explicit null (still no banner).
  let h = mergeHistory(undefined, { lockHolder: 'desktop' });
  assert.equal(lockBannerKind(h.lockHolder), 'desktop');
  h = mergeHistory(h, { lockHolder: 'desktop-stale' });
  assert.equal(lockBannerKind(h.lockHolder), 'desktop-stale');
  h = mergeHistory(h, { lockHolder: 'hub' });
  assert.equal(lockBannerKind(h.lockHolder), null);
  // Missing holder in a later delta keeps the stored value (still no banner for hub).
  h = mergeHistory(h, { status: 'working' });
  assert.equal(h.lockHolder, 'hub');
  assert.equal(lockBannerKind(h.lockHolder), null);
  h = mergeHistory(h, { lockHolder: null });
  assert.equal(lockBannerKind(h.lockHolder), null);
});
