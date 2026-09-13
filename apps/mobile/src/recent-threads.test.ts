import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogRows, matchesThreadQuery, isUnsentPlaceholderThread, recentThreadRows, relativeThreadTime, sortThreadsByRecent, threadTime } from './recent-threads';
import type { Thread } from './types';

const now = Date.parse('2026-09-10T12:00:00Z');
const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({ id, title: `会话 ${id}`, ...extra });

test('relative time floors minute, hour and day boundaries', () => {
  for (const [age, expected] of [
    [-60000, '刚刚'], [0, '刚刚'], [59999, '刚刚'], [60000, '1分钟前'],
    [119999, '1分钟前'], [3599999, '59分钟前'], [3600000, '1小时前'],
    [7199999, '1小时前'], [86399999, '23小时前'], [86400000, '1天前'],
    [172799999, '1天前'], [172800000, '2天前'],
  ] as const) assert.equal(relativeThreadTime({ mtimeMs: now - age }, now), expected);
  assert.equal(relativeThreadTime({ mtimeMs: now - 59999 }, now + 30000), '1分钟前');
});

test('invalid timestamps fall back to ISO or an explicit unknown placeholder', () => {
  for (const mtimeMs of [undefined, 0, -1, NaN, Infinity, -Infinity, 9e15]) {
    assert.equal(threadTime({ mtimeMs, updatedAt: '2026-09-10T12:00:00Z' }), now);
    assert.equal(threadTime({ mtimeMs, updatedAt: 'bad' }), 0);
    assert.equal(relativeThreadTime({ mtimeMs, updatedAt: 'bad' }, now), '时间未知');
  }
  assert.equal(threadTime({ mtimeMs: now, updatedAt: '2020-01-01' }), now);
  assert.equal(relativeThreadTime({}, now), '时间未知');
  assert.equal(relativeThreadTime({ mtimeMs: now }, NaN), '时间未知');
});

test('sort is descending, stable for ties, unknown last and does not mutate input', () => {
  const threads = [thread('unknown'), thread('old', { mtimeMs: now - 1 }),
    thread('new', { updatedAt: '2026-09-10T12:00:00Z' }), thread('tie', { mtimeMs: now }),
    thread('invalid', { mtimeMs: Infinity })];
  const original = threads.slice();
  assert.deepEqual(sortThreadsByRecent(threads).map((t) => t.id), ['new', 'tie', 'old', 'unknown', 'invalid']);
  assert.deepEqual(threads, original);
});

test('timeline is uncapped and approval/pinned/project membership do not split or duplicate rows', () => {
  const threads = Array.from({ length: 30 }, (_, i) => thread(String(i), {
    mtimeMs: now - i * 60000, isPinned: i === 15, needsApproval: i === 25,
  }));
  const rows = recentThreadRows(threads, [{ name: '项目', isPinned: true, threads }], ['1'], '');
  assert.equal(rows.length, 29);
  assert.deepEqual(rows.map((r) => r.thread.id), threads.filter((t) => t.id !== '1').map((t) => t.id));
  assert.equal(new Set(rows.map((r) => r.thread.id)).size, 29);
});

test('filters placeholders and searches full title or resolved project name, case insensitively', () => {
  for (const title of ['', ' ', '新聊天', '新对话', '项目/新聊天']) {
    assert.equal(isUnsentPlaceholderThread({ title }), true);
  }
  const threads = [thread('a', { title: 'Fix Layout', projectName: 'Explicit Project' }),
    thread('b'), thread('c', { cwd: '/repo' }), thread('d'), thread('placeholder', { title: '新聊天' })];
  const projects = [{ name: 'Mapped Project', threads: [threads[1]] }, { name: 'Cwd Project', cwd: '/repo', threads: [] }];
  const rows = (q: string) => recentThreadRows(threads, projects, [], q);
  assert.deepEqual(rows(' LAYOUT ').map((r) => r.thread.id), ['a']);
  assert.deepEqual(rows('explicit').map((r) => r.thread.id), ['a']);
  assert.deepEqual(rows('mapped').map((r) => r.thread.id), ['b']);
  assert.deepEqual(rows('cwd').map((r) => r.thread.id), ['c']);
  assert.equal(rows('').find((r) => r.thread.id === 'd')?.projectName, '无项目');
  assert.equal(rows('').length, 4);
  assert.deepEqual(rows('nothing matches'), []);
  assert.deepEqual(recentThreadRows(threads, projects, ['a'], 'layout'), []);
});

test('catalog search applies to pinned, waiting, projects and archives without leaking archived children', () => {
  const a = thread('a', { isPinned: true, needsApproval: true });
  const b = thread('b');
  const archived = thread('archived', { isPinned: true });
  const projects = [{ name: 'Alpha', cwd: '/Repo/Alpha', isPinned: true, threads: [a, archived] }, { name: 'Beta', threads: [b] }];
  const options = { threads: [a, b, archived], projects, archivedIds: ['archived'], archivedThreads: [archived], pinnedIds: [], openProjects: {}, query: ' ALPHA ' };
  const rows = catalogRows(options);
  assert.equal(matchesThreadQuery(a, '/repo/alpha', projects), true);
  assert.equal(rows.some(r => r.kind === 'thread' && r.thread.id === 'b'), false);
  assert.equal(rows.filter(r => r.kind === 'thread' && r.thread.id === 'archived').length, 1);
  assert.equal(rows.some(r => r.kind === 'thread' && r.archived && r.thread.id === 'archived'), true);
  assert.equal(rows.filter(r => r.kind === 'project').every(r => r.kind === 'project' && r.open && r.project.threads.length === 1), true);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
  assert.deepEqual(catalogRows({ ...options, query: 'missing' }), []);
});

test('catalog flattens large projects and preserves collapse state across searches', () => {
  const threads = Array.from({ length: 1000 }, (_, i) => thread(String(i)));
  const options = { threads, projects: [{ name: 'Large', threads }], archivedIds: [], archivedThreads: [], pinnedIds: [], query: '', openProjects: { Large: false } };
  const children = (query: string, openProjects = options.openProjects) => catalogRows({ ...options, query, openProjects }).filter(r => r.kind === 'thread' && r.indent);
  assert.equal(children('').length, 0);
  assert.equal(children('Large').length, 1000);
  assert.equal(children('').length, 0);
  assert.equal(children('', { Large: true }).length, 1000);
  assert.deepEqual(options.openProjects, { Large: false });
});
