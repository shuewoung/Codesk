import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer, accessModeToThreadSettings, isNoActiveTurnError, isWriterLockError, resolveThreadAccessSettings, threadAccessParams } from './appserver.js';

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

test('access mode maps to Desktop permission profiles', () => {
  assert.equal(accessModeToThreadSettings('ask').permissions, ':read-only');
  assert.equal(accessModeToThreadSettings('auto').permissions, ':workspace');
  assert.deepEqual(threadAccessParams(accessModeToThreadSettings('full')), {
    approvalPolicy: 'never',
    permissions: ':danger-full-access',
  });
  assert.equal('sandboxPolicy' in threadAccessParams(accessModeToThreadSettings('ask')), false);
  assert.equal('sandboxPolicy' in threadAccessParams(accessModeToThreadSettings('auto')), false);
  assert.equal(resolveThreadAccessSettings({ approvalPolicy: 'untrusted' }).approvalPolicy, 'untrusted');
  assert.equal(resolveThreadAccessSettings({ approvalPolicy: 'untrusted' }).permissions, ':read-only');
  const server = new CodexAppServer();
  server.setDefaultAccessMode('ask');
  server.rememberThreadAccess('t1', accessModeToThreadSettings('auto'));
  assert.equal(server.accessFor('t1').accessMode, 'auto');
  assert.equal(server.accessFor('t2').accessMode, 'ask');
  server.setDefaultAccessMode('full');
  assert.equal(server.accessFor('t1').permissions, ':danger-full-access');
  assert.equal(server.accessFor('t2').permissions, ':danger-full-access');
});
