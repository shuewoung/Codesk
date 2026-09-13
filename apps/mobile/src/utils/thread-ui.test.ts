import assert from 'node:assert/strict';
import test from 'node:test';
import { turnAwareFeed, questionEntries, stepStatus, reviewFilePath, queueStatus, isQueueSubmissionCancelled, userInputAnswers, inputSubmissionOutcome } from './thread-ui';
import { readFileSync } from 'node:fs';
import { catalogRows, projectExpansionKey, recentThreadRows } from '../recent-threads';
import type { TimelineNode } from '../types';

const command = (id: string, turnId?: string): TimelineNode => ({ id, turnId, kind: 'command', text: 'tool' });
test('adjacent tools preserve grouping within a turn but never cross known turns', () => {
  const feed = turnAwareFeed([command('a', 'one'), command('b', 'one'), command('c', 'two')]);
  assert.equal(feed.length, 2);
  assert.equal(feed[0].kind, 'cmd-group');
  if (feed[0].kind === 'cmd-group') assert.equal(feed[0].commands.length, 2);
});
test('important errors remain uncollapsed and missing statuses are not invented successes', () => {
  const feed = turnAwareFeed([{ ...command('error'), important: true, status: 'failed' }, command('unknown')]);
  assert.equal(feed[0].kind, 'command');
  assert.equal(stepStatus(undefined), '状态未提供');
  assert.equal(stepStatus('failed'), '失败');
  assert.equal(stepStatus('in_progress'), '执行中');
  assert.equal(stepStatus('cancelled'), '已中断');
  assert.equal(stepStatus('waiting_approval'), '等待审批');
});
test('question navigation uses stable ids rather than identical question text', () => {
  const feed = turnAwareFeed([{ id: 'q1', kind: 'user', text: '重复问题' }, command('a'), { id: 'q2', kind: 'user', text: '重复问题' }, { id: 'q3', kind: 'user', text: '', images: [{ path: '/a.png' }] }]);
  assert.deepEqual(questionEntries(feed).map(({ id, index }) => ({ id, index })), [{ id: 'q1', index: 0 }, { id: 'q2', index: 2 }, { id: 'q3', index: 3 }]);
  assert.equal(questionEntries(feed)[2].title, '附件问题');
});
test('read-only review paths preserve absolute Windows POSIX and UNC paths', () => {
  assert.equal(reviewFilePath('C:\\repo\\', 'src/a.ts'), 'C:\\repo/src/a.ts');
  assert.equal(reviewFilePath('/repo', '/tmp/a'), '/tmp/a');
  assert.equal(reviewFilePath('/repo', 'D:\\a'), 'D:\\a');
  assert.equal(reviewFilePath('/repo', '\\\\server\\a'), '\\\\server\\a');
});
test('same-name projects expand independently and explicit false beats legacy name state', () => {
  const projects = [{ name: 'app', cwd: '/one/app', threads: [{ id: 'one', title: 'First' }] }, { name: 'app', cwd: '/two/app', threads: [{ id: 'two', title: 'Second' }] }];
  const rows = catalogRows({ projects, threads: projects.flatMap(p => p.threads), archivedIds: [], archivedThreads: [], pinnedIds: [], query: '', openProjects: { app: true, '/one/app': false, '/two/app': true } });
  assert.deepEqual(rows.filter(row => row.kind === 'project').map(row => row.kind === 'project' && row.open), [false, true]);
  assert.equal(projectExpansionKey(projects[0]), '/one/app');
  assert.equal(projectExpansionKey({ id: 'stable', name: 'renamed', cwd: '/a' }), 'stable');
});
test('cancelled queue status is explicit and distinct from interrupted execution', () => {
  assert.equal(queueStatus('cancelled'), '已取消');
  assert.equal(queueStatus('canceled'), '已取消');
  assert.equal(stepStatus('interrupted'), '已中断');
});
test('only confirmed cancellation of the exact submission allows deliberate requeue', () => {
  const old = { queueId: 'old', threadId: 't', requestId: 'r1', text: 'same', status: 'cancelled' };
  const current = { queueId: 'new', threadId: 't', requestId: 'r2', text: 'same', status: 'queued' };
  assert.equal(isQueueSubmissionCancelled([old, current], 'r2'), false);
  assert.equal(isQueueSubmissionCancelled([old], 'r2'), false);
  assert.equal(isQueueSubmissionCancelled([old], undefined), false);
  assert.equal(isQueueSubmissionCancelled([old, { ...current, status: 'cancelled' }], 'r2'), true);
  assert.equal(isQueueSubmissionCancelled([old, { ...current, status: 'sent' }], 'r2'), false);
});
test('Git tab and refresh request both read-only channels and render aggregate diff', () => {
  const panel = readFileSync(new URL('../screens/FilePanel.tsx', import.meta.url), 'utf8');
  assert.equal((panel.match(/gitStatus\(threadId\); gitDiff\(threadId\);/g) || []).length, 2);
  assert.match(panel, /<UnifiedDiffView patch=\{git\.diff\}/);
  const thread = readFileSync(new URL('../screens/ThreadScreen.tsx', import.meta.url), 'utf8');
  assert.match(thread, /tools\.git\?\.threadId === threadId \? tools\.git\?\.branch : undefined/);
});

test('user input requires explicit complete answers and accepts choices or custom text', () => {
  const request = { requestId: 'input', threadId: 'beta', method: 'item/tool/requestUserInput', payload: { questions: [{ id: 'format', question: 'Format?', options: [{ label: 'Markdown' }] }, { id: 'notes', question: 'Notes?' }] } };
  assert.equal(userInputAnswers(request, {}), null);
  assert.equal(userInputAnswers(request, { format: 'Markdown', notes: '  ' }), null);
  assert.deepEqual(userInputAnswers(request, { format: 'Markdown', notes: 'Custom notes', ignored: 'omit' }), { answers: { format: { answers: ['Markdown'] }, notes: { answers: ['Custom notes'] } } });
  assert.deepEqual(userInputAnswers(request, { format: 'Custom format', notes: 'Notes' })?.answers.format.answers, ['Custom format']);
  assert.equal(userInputAnswers({ ...request, payload: {} }, {}), null);
});
test('ThreadScreen wires only matching-thread user requests to a keyed input card', () => {
  const source = readFileSync(new URL('../screens/ThreadScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ UserInputBar \} from '..\/components\/UserInputBar'/);
  assert.match(source, /Object\.values\(session\.userInputs\)\.filter\(request => request\.threadId === threadId\)\.map\(request => <UserInputBar/);
  assert.match(source, /request\.threadId\}:\$\{request\.requestId\}\}\`|request\.threadId\}:\$\{request\.requestId\}\`/);
});
test('user input UI explicitly submits answers with capability, offline and duplicate guards', () => {
  const source = readFileSync(new URL('../components/UserInputBar.tsx', import.meta.url), 'utf8');
  assert.match(source, /session\.capabilities\.send_user_input === true/);
  assert.match(source, /!connected \|\| !supported \|\| submitted/);
  assert.match(source, /if \(sending\.current \|\| disabled \|\| anotherPending \|\| !payload\) return/);
  assert.match(source, /session\.respondUserInput\(request\.requestId, payload\)/);
  assert.match(source, /useState<Record<string, string>>\(\{\}\)/);
  assert.match(source, /if \(session\.respondUserInput\(request\.requestId, payload\)\) setSubmitted\(true\)/);
  assert.doesNotMatch(source, /setUserInputs|delete .*requestId/);
});

test('input submission unlocks only an explicit error for the exact request', () => {
  assert.equal(inputSubmissionOutcome({ requestId: 'current', status: 'error' }, 'current'), 'failed');
  assert.equal(inputSubmissionOutcome({ requestId: 'old', status: 'error' }, 'current'), 'waiting');
  assert.equal(inputSubmissionOutcome({ requestId: 'current', status: 'error' }), 'waiting');
  assert.equal(inputSubmissionOutcome({ requestId: 'current', status: 'timeout' }, 'current'), 'uncertain');
  assert.equal(inputSubmissionOutcome({ requestId: 'current', status: 'success' }, 'current'), 'waiting');
  assert.equal(inputSubmissionOutcome({ requestId: 'current', status: 'loading' }, 'current'), 'waiting');
});
test('input UI releases explicit failure but retains timeout and never auto-resubmits', () => {
  const source = readFileSync(new URL('../components/UserInputBar.tsx', import.meta.url), 'utf8');
  assert.match(source, /session\.requestState\('send_user_input', request\.threadId\)/);
  assert.match(source, /submission\.requestId !== previousRequestId\.current/);
  assert.match(source, /inputSubmissionOutcome\(submission, submittedRequestId\.current\)/);
  assert.match(source, /if \(outcome === 'failed'\) \{\s*sending\.current = false;\s*setSubmitted\(false\)/);
  assert.match(source, /else if \(outcome === 'uncertain'\) setTimedOut\(true\)/);
  assert.equal((source.match(/session\.respondUserInput\(/g) || []).length, 1);
  assert.doesNotMatch(source, /setTimeout|setInterval/);
});

test('project path searches and recent order retain existing behavior', () => {
  const projects = [{ name: 'app', cwd: '/one/app', threads: [{ id: 'one', title: 'First', mtimeMs: 1 }, { id: 'two', title: 'Second', mtimeMs: 2 }] }];
  assert.deepEqual(recentThreadRows(projects[0].threads, projects, [], '/one').map(row => row.thread.id), ['two', 'one']);
});
