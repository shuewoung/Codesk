import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadHistory } from '../types';
import { artifactCycle, canShowArtifacts, parentPath, shouldRefreshArtifacts } from './file-panel';

function history(status = 'idle', rev = 1): ThreadHistory {
  return { status, rev, cwd: 'D:\\project', pendingApproval: null, activeActionText: '', items: [{ role: 'user', content: 'create report' }] };
}

test('parentPath supports Windows, POSIX and mixed separators', () => {
  assert.equal(parentPath('D:\\project\\report.pdf'), 'D:\\project');
  assert.equal(parentPath('D:/project/report.pdf'), 'D:/project');
  assert.equal(parentPath('D:\\project/report.pdf'), 'D:\\project');
  assert.equal(parentPath('/project/report.pdf'), '/project');
  assert.equal(parentPath('project/report.pdf'), 'project');
  assert.equal(parentPath('report.pdf'), '.');
});

test('parentPath preserves drive, POSIX and UNC share roots', () => {
  for (const path of ['D:\\report.pdf', 'D:\\', 'D:\\\\']) assert.equal(parentPath(path), 'D:\\');
  for (const path of ['D:/report.pdf', 'D:/']) assert.equal(parentPath(path), 'D:/');
  assert.equal(parentPath('/report.pdf'), '/');
  assert.equal(parentPath('/'), '/');
  assert.equal(parentPath('\\\\host\\share\\report.pdf'), '\\\\host\\share\\');
  assert.equal(parentPath('\\\\host\\share'), '\\\\host\\share');
  assert.equal(parentPath('\\\\host\\share\\folder\\report.pdf'), '\\\\host\\share\\folder');
});

test('new active turn hides old records immediately; completion refreshes once', () => {
  const initial = artifactCycle(history());
  const oldRequest = { status: 'success', requestId: 'old' };
  assert.equal(canShowArtifacts(initial.key, initial.key, false, oldRequest), true);
  const active = artifactCycle(history('working'));
  assert.equal(canShowArtifacts(initial.key, active.key, active.active, oldRequest), false);
  assert.equal(shouldRefreshArtifacts(initial.key, active.key, active.active), false);
  const approval = artifactCycle(history('waiting_approval', 2));
  assert.equal(approval.key, active.key);
  const settled = artifactCycle(history('idle', 100));
  assert.equal(shouldRefreshArtifacts(active.key, settled.key, settled.active), true);
  assert.equal(shouldRefreshArtifacts(settled.key, settled.key, settled.active), false);
  // Rendering completion before the new response must not revive the old result.
  assert.equal(canShowArtifacts(undefined, settled.key, false, oldRequest), false);
  assert.equal(canShowArtifacts(settled.key, settled.key, false, oldRequest, 'old'), false);
  assert.equal(canShowArtifacts(settled.key, settled.key, false, { status: 'loading', requestId: 'new' }, 'old'), false);
  assert.equal(canShowArtifacts(settled.key, settled.key, false, { status: 'success', requestId: 'new' }, 'old'), true);
});

test('tokens, tool events and rev changes do not cause artifact requests', () => {
  const initial = artifactCycle(history('working'));
  for (let rev = 2; rev < 50; rev++) {
    const next = history('working', rev);
    next.items.push({ role: 'assistant', content: 'token'.repeat(rev) }, { type: 'tool_result', content: rev });
    const cycle = artifactCycle(next);
    assert.equal(cycle.key, initial.key);
    assert.equal(shouldRefreshArtifacts(initial.key, cycle.key, cycle.active), false);
  }
  const idle = history();
  const next = { ...idle, rev: 100, items: [...idle.items, { role: 'assistant', content: 'done' }] };
  assert.equal(artifactCycle(idle).key, artifactCycle(next).key);
});

test('a new user boundary invalidates records even if the running transition was missed', () => {
  const old = history();
  const next = { ...old, items: [...old.items, { role: 'user', content: 'create report' }] };
  const first = artifactCycle(old); const second = artifactCycle(next);
  assert.notEqual(first.key, second.key);
  assert.equal(canShowArtifacts(first.key, second.key, false, { status: 'success', requestId: 'old' }), false);
  assert.equal(shouldRefreshArtifacts(first.key, second.key, second.active), true);
  assert.equal(artifactCycle(undefined, 'working').active, true);
});
