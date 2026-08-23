import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer, isNoActiveTurnError, isWriterLockError } from './appserver.js';

test('isNoActiveTurnError matches steer miss and not writer lock', () => {
  assert.equal(isNoActiveTurnError(new Error('no active turn to steer')), true);
  assert.equal(isNoActiveTurnError(new Error('缺少 turnId：该线程当前没有进行中的 turn（可能已结束）')), true);
  assert.equal(isNoActiveTurnError(new Error('already has an active writer')), false);
  assert.equal(isWriterLockError(new Error('already has an active writer')), true);
});

test('turn completed and interrupted clear currentTurnByThread', () => {
  const server = new CodexAppServer();
  server.currentTurnByThread.set('t1', 'turn-1');
  server.currentTurnByThread.set('t2', 'turn-2');
  server._onNotification({ method: 'turn/started', params: { threadId: 't3', turn: { id: 'turn-3' } } });
  assert.equal(server.currentTurnByThread.get('t3'), 'turn-3');
  server._onNotification({ method: 'turn/completed', params: { threadId: 't1' } });
  server._onNotification({ method: 'turn/interrupted', params: { threadId: 't2' } });
  assert.equal(server.currentTurnByThread.has('t1'), false);
  assert.equal(server.currentTurnByThread.has('t2'), false);
  assert.equal(server.currentTurnByThread.get('t3'), 'turn-3');
});
