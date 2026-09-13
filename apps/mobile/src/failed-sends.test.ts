import test from 'node:test';
import assert from 'node:assert/strict';
import { removeFailedSend } from './failed-sends';
import type { FailedSend } from './types';

const rows: FailedSend[] = [
  { id: 'fail-1', threadId: 't-a', text: '第一条', working: false, kind: 'message', error: '未连接' },
  { id: 'fail-2', threadId: 't-a', text: '第二条', working: false, kind: 'command', error: '写入锁冲突', code: 'writer_lock_conflict' },
  { id: 'fail-3', threadId: 't-b', text: '第三条', working: true, kind: 'message', error: '超时' },
];

test('removeFailedSend deletes only the matching id and keeps others untouched', () => {
  const next = removeFailedSend(rows, 'fail-2');
  assert.deepEqual(next.map((row) => row.id), ['fail-1', 'fail-3']);
  // 未被删除的条目保持原引用（同一数据流，不改写其余记录）。
  assert.equal(next[0], rows[0]);
  assert.equal(next[1], rows[2]);
});

test('removeFailedSend with unknown or empty id keeps the list unchanged', () => {
  assert.deepEqual(removeFailedSend(rows, 'fail-404').map((row) => row.id), ['fail-1', 'fail-2', 'fail-3']);
  assert.deepEqual(removeFailedSend(rows, '').map((row) => row.id), ['fail-1', 'fail-2', 'fail-3']);
});

test('removeFailedSend supports removing every row one by one and handles empty lists', () => {
  let rest = removeFailedSend(rows, 'fail-1');
  rest = removeFailedSend(rest, 'fail-3');
  rest = removeFailedSend(rest, 'fail-2');
  assert.deepEqual(rest, []);
  assert.deepEqual(removeFailedSend([], 'fail-1'), []);
});
