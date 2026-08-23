import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlanPrompt,
  buildReviewPrompt,
  filesMatchingPlanStep,
  planFromItems,
  reviewFilesFrom,
} from './workspace';

test('planFromItems keeps the latest update_plan', () => {
  const plan = planFromItems([
    {
      type: 'function_call',
      name: 'update_plan',
      arguments: JSON.stringify({
        explanation: 'old',
        plan: [{ step: 'A', status: 'completed' }],
      }),
    },
    {
      type: 'function_call',
      name: 'update_plan',
      arguments: {
        explanation: 'new',
        plan: [
          { step: '读代码', status: 'completed' },
          { step: '改接口', status: 'in_progress' },
          { step: '补测试', status: 'pending' },
        ],
      },
    },
  ]);
  assert.equal(plan?.explanation, 'new');
  assert.equal(plan?.steps.length, 3);
  assert.equal(plan?.steps[1].status, 'in_progress');
});

test('reviewFilesFrom merges git status, diff and timeline diffs', () => {
  const files = reviewFilesFrom({
    gitStatus: ' M src/a.ts\n?? src/b.ts\n',
    gitDiff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+ok\n-old\n',
    diffs: [{ id: '1', kind: 'diff', text: 'c.ts', path: 'src/c.ts', add: 2, del: 1 }],
  });
  assert.deepEqual(files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  const a = files.find((f) => f.path === 'src/a.ts');
  assert.equal(a?.add, 1);
  assert.equal(a?.del, 1);
});

test('filesMatchingPlanStep matches a filename in the step', () => {
  const hits = filesMatchingPlanStep('改 api.ts 接口', [{ path: 'src/api.ts' }, { path: 'src/other.ts' }]);
  assert.deepEqual(hits.map((f) => f.path), ['src/api.ts']);
});

test('buildPlanPrompt and buildReviewPrompt stay as slash workspaces', () => {
  assert.match(buildPlanPrompt('加登录'), /规划模式/);
  assert.match(buildPlanPrompt('加登录'), /加登录/);
  assert.match(buildReviewPrompt('注意鉴权', [{ path: 'src/auth.ts' }]), /\/review/);
  assert.match(buildReviewPrompt('注意鉴权', [{ path: 'src/auth.ts' }]), /src\/auth\.ts/);
});
