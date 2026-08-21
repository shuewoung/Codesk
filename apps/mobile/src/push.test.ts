import assert from 'node:assert/strict';
import test from 'node:test';
import { threadIdFromPush } from './push';

const ID = '01a01ffb-f027-7f23-8187-22f9dfc5ac34';

test('threadIdFromPush reads url, tag, extras and raw uuid', () => {
  assert.equal(threadIdFromPush(`/#thread-${ID}`), ID);
  assert.equal(threadIdFromPush(`codex-done-${ID}`), ID);
  assert.equal(threadIdFromPush(`codex-approval-${ID}`), ID);
  assert.equal(threadIdFromPush({ threadId: ID }), ID);
  assert.equal(threadIdFromPush({ url: `/#thread-${ID}` }), ID);
  assert.equal(threadIdFromPush({ extras: { tag: `codex-done-${ID}` } }), ID);
  assert.equal(threadIdFromPush('not-a-thread'), '');
});
