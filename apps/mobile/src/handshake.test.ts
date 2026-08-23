import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHandshake, handshakeHint } from './handshake';

test('relay connecting walks four steps', () => {
  const socket = buildHandshake({ mode: 'relay', phase: 'socket' });
  assert.equal(socket.steps[0].state, 'now');
  assert.equal(socket.steps[0].label, '连接中继');
  assert.equal(socket.active, true);

  const e2e = buildHandshake({ mode: 'relay', phase: 'e2e' });
  assert.equal(e2e.steps[0].state, 'ok');
  assert.equal(e2e.steps[1].state, 'ok');
  assert.equal(e2e.steps[2].state, 'now');
  assert.match(e2e.detail, /hk=/);

  const sync = buildHandshake({ mode: 'relay', phase: 'sync' });
  assert.equal(sync.steps[2].state, 'ok');
  assert.equal(sync.steps[3].state, 'now');

  const ready = buildHandshake({ mode: 'relay', phase: 'ready' });
  assert.equal(ready.active, false);
  assert.ok(ready.steps.every((s) => s.state === 'ok'));
});

test('lan skips encryption and names local hub', () => {
  const sync = buildHandshake({ mode: 'lan', phase: 'sync' });
  assert.equal(sync.steps[0].label, '连接电脑');
  assert.equal(sync.steps[2].state, 'skip');
  const ready = buildHandshake({ mode: 'lan', phase: 'ready' });
  assert.equal(ready.steps[2].state, 'skip');
});

test('offline and reconnect copy', () => {
  const off = buildHandshake({ mode: 'relay', phase: 'offline' });
  assert.match(off.detail, /电脑醒了/);
  assert.equal(off.steps[3].state, 'fail');
  assert.equal(off.needsRetry, true);
  const rec = buildHandshake({ mode: 'lan', phase: 'reconnecting' });
  assert.equal(rec.steps[0].state, 'now');
  assert.equal(rec.needsRetry, false);
});

test('retry only after failure, not while connecting', () => {
  const socket = buildHandshake({ mode: 'lan', phase: 'socket' });
  assert.equal(socket.needsRetry, false);
  const failed = buildHandshake({ mode: 'lan', phase: 'socket', error: '连接失败' });
  assert.equal(failed.needsRetry, true);
  const ready = buildHandshake({ mode: 'lan', phase: 'ready' });
  assert.equal(ready.needsRetry, false);
});

test('handshakeHint maps old apk and missing hk', () => {
  assert.match(handshakeHint('no PRNG'), /新版 APK/);
  assert.match(handshakeHint('握手失败'), /hk=/);
});
