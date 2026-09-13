import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSendingDraft,
  createDraftStorage,
  isDraftEmpty,
  MAX_DRAFT_THREADS,
  normalizeDraft,
  parseDraftMap,
  pendingFromComposerInput,
  upsertDraft,
  writerLockErrorCode,
} from './composer-draft';

test('writer lock recovery requires a structured supported code and exact current thread', () => {
  for (const code of ['writer_lock_conflict', 'writer_owner_unknown']) {
    const feedback = { threadId: 't1', code };
    assert.equal(writerLockErrorCode('t1', feedback), code);
    assert.equal(writerLockErrorCode('t2', feedback), undefined);
    assert.equal(writerLockErrorCode(undefined, feedback), undefined);
    assert.equal(writerLockErrorCode('t1', { code }), undefined);
    assert.equal(writerLockErrorCode('', { threadId: '', code }), undefined);
    assert.deepEqual(feedback, { threadId: 't1', code });
  }
  assert.equal(writerLockErrorCode('t1', { threadId: 't1', code: 'quota' }), undefined);
  const textOnly = { threadId: 't1', error: 'writer_lock_conflict 写入锁' };
  assert.equal(writerLockErrorCode('t1', textOnly), undefined);
});

test('draft storage serializes concurrent thread saves and navigation reads', async () => {
  let raw: string | null = null;
  const store = createDraftStorage(async () => raw, async value => {
    await new Promise(resolve => setTimeout(resolve, 2));
    raw = value;
  });
  const a = store.save('a', { text: 'draft A', pending: [], updatedAt: 1 });
  const b = store.save('b', { text: 'draft B', pending: [], updatedAt: 2 });
  const restored = store.load('a');
  await Promise.all([a, b]);
  assert.equal((await restored)?.text, 'draft A');
  assert.equal((await store.load('b'))?.text, 'draft B');
});

test('draft storage serializes send acknowledgement and newer edits without losing other threads', async () => {
  let raw: string | null = null;
  const store = createDraftStorage(async () => raw, async value => { raw = value; });
  await Promise.all([
    store.save('a', { text: 'sent', pending: [], sending: true, updatedAt: 1 }),
    store.save('b', { text: 'other thread', pending: [], updatedAt: 2 }),
    store.clearSending('a', 'sent'),
    store.save('a', { text: 'new edit', pending: [], updatedAt: 3 }),
  ]);
  assert.equal((await store.load('a'))?.text, 'new edit');
  assert.equal((await store.load('b'))?.text, 'other thread');
});

test('draft storage recovers after rejected writes', async () => {
  let raw: string | null = null;
  let fail = true;
  const store = createDraftStorage(async () => raw, async value => {
    if (fail) { fail = false; throw new Error('storage unavailable'); }
    raw = value;
  });
  await assert.rejects(store.save('a', { text: 'first', pending: [], updatedAt: 1 }));
  await store.save('b', { text: 'survives', pending: [], updatedAt: 2 });
  assert.equal((await store.load('b'))?.text, 'survives');
});

test('pendingFromComposerInput keeps files and drops text', () => {
  assert.deepEqual(
    pendingFromComposerInput([
      { type: 'text', text: 'hi' },
      { type: 'mention', name: 'a.ts', path: 'D:\\\\repo\\\\a.ts' },
      { type: 'localImage', path: 'D:\\\\pic.png' },
      { type: 'skill', name: 'review', path: 'C:\\\\skills\\\\review' },
    ]),
    [
      { name: 'a.ts', path: 'D:\\\\repo\\\\a.ts', image: false },
      { name: 'image', path: 'D:\\\\pic.png', image: true },
      { name: 'review', path: 'C:\\\\skills\\\\review', image: false, skill: true },
    ],
  );
});

test('upsertDraft drops empty and caps thread count', () => {
  let map = upsertDraft({}, 't1', { text: 'hello', pending: [], updatedAt: 1 });
  map = upsertDraft(map, 't1', { text: '  ', pending: [], updatedAt: 2 });
  assert.deepEqual(map, {});
  const many: Record<string, { text: string; pending: []; updatedAt: number }> = {};
  for (let i = 0; i < MAX_DRAFT_THREADS + 5; i += 1) {
    many[`t${i}`] = { text: `n${i}`, pending: [], updatedAt: i };
  }
  const pruned = upsertDraft(many, 'fresh', { text: 'x', pending: [], updatedAt: 999 });
  assert.equal(Object.keys(pruned).length, MAX_DRAFT_THREADS);
  assert.equal(pruned.fresh.text, 'x');
  assert.equal(pruned.t0, undefined);
});

test('parseDraftMap ignores junk and empty rows', () => {
  assert.deepEqual(parseDraftMap('not-json'), {});
  const parsed = parseDraftMap(JSON.stringify({
    a: { text: 'keep', pending: [], updatedAt: 3 },
    b: { text: '', pending: [], updatedAt: 1 },
  }));
  assert.equal(normalizeDraft(parsed.a)?.text, 'keep');
  assert.equal(parsed.b, undefined);
  assert.equal(isDraftEmpty(parsed.a), false);
});

test('clearSendingDraft only drops matching in-flight text', () => {
  const map = {
    t1: { text: 'hello', pending: [], updatedAt: 1, sending: true as const },
  };
  assert.equal(clearSendingDraft(map, 't1', 'hello').t1, undefined);
  assert.equal(clearSendingDraft(map, 't1', 'other').t1?.sending, false);
  assert.equal(clearSendingDraft(map, 't1', 'other').t1?.text, 'hello');
});
