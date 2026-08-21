import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePushPayload, sendJpush, threadIdFromPush } from '../src/push.js';

const ID = '01a01ffb-f027-7f23-8187-22f9dfc5ac34';

test('threadIdFromPush reads hash, tag and uuid', () => {
  assert.equal(threadIdFromPush(`/#thread-${ID}`), ID);
  assert.equal(threadIdFromPush(`codex-approval-${ID}`), ID);
  assert.equal(threadIdFromPush(ID), ID);
  assert.equal(threadIdFromPush('x'), '');
});

test('normalizePushPayload fills threadId from url or tag', () => {
  const fromUrl = normalizePushPayload({
    title: '审批',
    body: '需要批准',
    tag: 'codex-approval',
    url: `/#thread-${ID}`,
  });
  assert.equal(fromUrl.threadId, ID);
  assert.equal(fromUrl.url, `/#thread-${ID}`);
  const fromTag = normalizePushPayload({
    title: '完成',
    body: '已完成',
    tag: `codex-done-${ID}`,
  });
  assert.equal(fromTag.threadId, ID);
});

test('sendJpush puts threadId into android extras', async () => {
  let body;
  const result = await sendJpush({
    appKey: 'k',
    masterSecret: 's',
    registrationIds: ['rid1'],
    title: '完成',
    body: '已完成',
    tag: `codex-done-${ID}`,
    url: `/#thread-${ID}`,
    threadId: ID,
    fetchImpl: async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(body.notification.android.extras.threadId, ID);
  assert.equal(body.notification.android.extras.url, `/#thread-${ID}`);
});
