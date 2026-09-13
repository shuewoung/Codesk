import test from 'node:test';
import assert from 'node:assert/strict';
import { draftNamespace, scopedDraftKey, canSubmitComposer, createDraftStorage, normalizeDraft } from './composer-draft';
import { emptyHistory, resultSummary } from './history';

test('draft namespaces isolate equal thread IDs across hosts without retaining URL credentials', () => {
  const a = draftNamespace({ mode: 'relay', hubId: 'a', relayUrl: 'https://user:secret@relay.example/path?token=hidden' });
  const b = draftNamespace({ mode: 'relay', hubId: 'b', relayUrl: 'https://relay.example' });
  assert.notEqual(scopedDraftKey('same-thread', a), scopedDraftKey('same-thread', b));
  assert.equal(a.includes('secret'), false); assert.equal(a.includes('hidden'), false);
  assert.notEqual(draftNamespace({ mode: 'lan', lanUrl: 'http://one:8787' }), draftNamespace({ mode: 'lan', lanUrl: 'http://two:8787' }));
  assert.equal(scopedDraftKey('thread', ''), '');
});
test('legacy draft is explicitly claimed atomically by one host only', async () => {
  let raw: string | null = null;
  const storage = createDraftStorage(async () => raw, async next => { raw = next; });
  await storage.save('legacy-thread', { text: 'legacy', pending: [], updatedAt: 1 });
  const keys = [scopedDraftKey('legacy-thread', 'host-a'), scopedDraftKey('legacy-thread', 'host-b')];
  assert.equal(await storage.load(keys[0]), null); // Merely opening a host does not import.
  const claims = await Promise.all(keys.map(key => storage.claimLegacy('legacy-thread', key)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await storage.load('legacy-thread'), null);
  assert.equal((await storage.load(keys[0]))?.text, 'legacy');
  assert.equal(await storage.load(keys[1]), null);
});

test('editing state does not permit offline, IME, concurrent upload/send, approval or quota sends', () => {
  assert.equal(canSubmitComposer({ connected: true }), true);
  assert.equal(canSubmitComposer({ connected: false }), false);
  for (const guard of ['composing', 'sending', 'uploading', 'approval', 'quotaExhausted']) assert.equal(canSubmitComposer({ connected: true, [guard]: true }), false);
});
test('parallel uploads append to original drafts without overwriting text or other attachments', async () => {
  let raw: string | null = null;
  const storage = createDraftStorage(async () => raw, async next => { raw = next; });
  await storage.save('a', { text: 'original text', pending: [], updatedAt: 1 });
  await storage.save('b', { text: 'other thread', pending: [], updatedAt: 1 });
  await Promise.all([
    storage.appendAttachment('a', { taskId: 'one', name: 'one', path: '/one', image: false, source: 'device' }),
    storage.appendAttachment('a', { taskId: 'two', name: 'two', path: '/two', image: false, source: 'device' }),
    storage.appendAttachment('a', { taskId: 'one', name: 'one', path: '/one', image: false, source: 'device' }),
  ]);
  const a = await storage.load('a');
  assert.equal(a?.text, 'original text');
  assert.deepEqual(a?.pending.map(p => p.taskId), ['one', 'two']);
  assert.equal(a?.pending[0].source, 'device');
  assert.deepEqual((await storage.load('b'))?.pending, []);
});
test('late upload survives stale navigation cleanup, but explicit removal stays removed', async () => {
  let raw: string | null = null;
  const storage = createDraftStorage(async () => raw, async next => { raw = next; });
  await storage.appendAttachment('a', { taskId: 'late', name: 'f', path: '/late', image: false, source: 'device' });
  await storage.save('a', { text: 'stale navigation snapshot', pending: [], updatedAt: 3 });
  assert.equal((await storage.load('a'))?.pending[0].taskId, 'late');
  await storage.removeAttachment('a', 'late');
  await storage.save('a', { text: 'stale navigation snapshot', pending: [], updatedAt: 4 });
  assert.deepEqual((await storage.load('a'))?.pending, []);
});

test('failed attachment storage write can be retried without poisoning queue', async () => {
  let raw: string | null = null; let fail = true;
  const storage = createDraftStorage(async () => raw, async next => { if (fail) { fail = false; throw new Error('full'); } raw = next; });
  const attachment = { taskId: 't', name: 'f', path: '/file', image: false, source: 'device' as const };
  await assert.rejects(storage.appendAttachment('a', attachment), /full/);
  await storage.appendAttachment('a', attachment);
  assert.equal((await storage.load('a'))?.pending.length, 1);
});
test('draft normalization preserves explicit attachment provenance', () => {
  const draft = normalizeDraft({ text: '', pending: [{ name: 'a', path: '/a', image: false, source: 'host' }, { name: 'b', path: '/b', image: true, source: 'device', taskId: 'upload' }] });
  assert.deepEqual(draft?.pending.map(p => p.source), ['host', 'device']);
});
test('summary never reuses prior-turn answer or calls an idle turn successful', () => {
  const h = emptyHistory();
  h.items = [{ type: 'message', role: 'assistant', content: 'Old successful reply' }, { type: 'message', role: 'user', content: 'New request' }];
  assert.equal(resultSummary(h).reply, '');
  h.items.push({ type: 'message', role: 'assistant', channel: 'analysis', content: 'thinking only' });
  assert.equal(resultSummary(h).reply, '');
  h.items.push({ type: 'message', role: 'assistant', channel: 'final', content: 'Unable to complete the task' });
  assert.match(resultSummary(h).reply, /Unable/);
  assert.equal(resultSummary(h).status, '最新答复（请核对结果）');
  h.status = 'working'; assert.equal(resultSummary(h).status, '仍在运行');
  h.status = 'waiting_approval'; assert.equal(resultSummary(h).status, '等待审批');
  h.status = 'error'; assert.equal(resultSummary(h).status, '执行异常');
});
