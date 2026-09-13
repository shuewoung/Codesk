import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenItems, groupCommandNodes, normalizeTimelineItems, mergeHistory } from './history';
import { resolveTimelineImage } from './utils/localFileUrl';

test('completion aliases prefer typed records and outputs correlate out of order', () => {
  const items = [{ type: 'function_call_output', call_id: 'call', output: { result: 'done' } }, { type: 'function_call', id: 'item', call_id: 'call', name: 'exec', arguments: '{"cmd":"pwd"}' }, { type: 'item_completed', item: { type: 'CommandExecution', id: 'item', command: 'pwd', status: 'completed' } }];
  const nodes = flattenItems(items); assert.equal(nodes.length, 1); assert.equal(nodes[0].command, 'pwd'); assert.match(nodes[0].output || '', /done/);
  assert.equal(normalizeTimelineItems(items).length, 2);
});
test('distinct messages are not deduplicated by text; empty typed reasoning hides', () => {
  assert.match(flattenItems([{ type: 'message', role: 'assistant', content: 'repeat' }, { type: 'message', role: 'assistant', content: 'repeat' }])[0].text, /repeat\n\nrepeat/);
  assert.equal(flattenItems([{ type: 'item_completed', item: { type: 'Reasoning', summary: [] } }]).length, 0);
});
test('typed files preserve ordinary deletions and all codex-named user paths', () => {
  const nodes = flattenItems([{ type: 'item_completed', item: { type: 'FileChange', id: 'change', changes: [{ path: 'ordinary.txt', kind: 'delete', diff: '-gone' }, { path: '.codex/user-document.md', kind: 'add', diff: '+keep' }] } }]);
  assert.deepEqual(nodes.map(n => n.path), ['ordinary.txt', '.codex/user-document.md']); assert.equal(nodes[0].del, 1);
  const legacy = { type: 'custom_tool_call', id: 'patch', name: 'functions.apply_patch', input: '*** Begin Patch\n*** Add File: a.txt\n+one\n*** Delete File: b.txt\n-old\n*** End Patch' };
  assert.deepEqual(flattenItems([legacy]).map(n => n.path), ['a.txt', 'b.txt']);
  assert.equal(flattenItems([legacy, { type: 'item_completed', item: { type: 'FileChange', id: 'patch', changes: [{ path: 'a.txt', kind: 'add', diff: '+one' }] } }]).length, 1);
});
test('typed search, image generation, view and compaction get dedicated nodes', () => {
  const nodes = flattenItems([{ type: 'Extension', kind: 'web.search', query: 'synthetic', results: [{ url: 'https://example.invalid' }] }, { type: 'Extension', kind: 'image_gen.generation', path: '/work/out.webp' }, { type: 'ImageView', path: '/work/input.webp' }, { type: 'ContextCompaction' }]);
  assert.deepEqual(nodes.map(n => n.kind), ['search', 'generated-image', 'image-view', 'compaction']);
});
test('errors remain important and outside command folding; output is bounded', () => {
  const nodes = flattenItems([{ type: 'function_call', call_id: 'c', name: 'exec' }, { type: 'function_call_output', call_id: 'c', status: 'failed', output: 'x'.repeat(20000) }]);
  assert.equal(nodes[0].important, true); assert.ok(nodes[0].output!.length < 16100); assert.equal(groupCommandNodes(nodes)[0].kind, 'command');
  assert.equal(flattenItems([{ type: 'function_call_output', call_id: 'orphan', error: 'failed' }])[0].important, true);
  assert.equal(flattenItems([{ type: 'function_call', call_id: 'exit', name: 'exec' }, { type: 'function_call_output', call_id: 'exit', output: '{"exit_code":1}' }])[0].important, true);
});
test('agent metadata keeps actual IDs, model, and interrupted/waiting/unknown states', () => {
  for (const status of ['interrupted', 'waiting', 'unknown']) {
    const node = flattenItems([{ type: 'AgentMessage', content: 'update', inter_agent_communication_metadata: { sender_thread_id: 'child', title: 'Research', model: 'model', status } }])[0];
    assert.equal(node.threadId, 'child'); assert.equal(node.model, 'model'); assert.equal(node.status, status);
  }
});
test('markdown image payloads survive text cleaning; local paths resolve against cwd', () => {
  const data = 'data:image/webp;base64,UklGRg==';
  assert.equal(flattenItems([{ type: 'message', content: `![image](${data})` }])[0].text, `![image](${data})`);
  assert.equal(resolveTimelineImage('out.webp', '/work'), '/work/out.webp');
  assert.equal(resolveTimelineImage('/work/out.webp', '/other'), '/work/out.webp');
  assert.equal(resolveTimelineImage('file:///work/out.webp', '/other'), '/work/out.webp');
  assert.equal(resolveTimelineImage('D:\\work\\out.webp', '/other'), 'D:\\work\\out.webp');
  assert.equal(resolveTimelineImage(data, '/work'), data);
});
test('deduplicated full history honors server pagination, not raw record counts', () => {
  const history = mergeHistory(undefined, { items: [{ id: 'i', type: 'message', content: 'done' }], full: true, totalItems: 2, hasMore: false });
  assert.equal(history.hasMore, false);
  assert.equal(mergeHistory(history, { items: history.items, totalItems: 2, hasMore: true }).hasMore, false);
});
