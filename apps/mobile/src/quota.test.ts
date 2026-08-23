import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatContextUsage,
  formatQuotaLine,
  formatQuotaReset,
  isQuotaError,
  isQuotaExhausted,
  quotaExhaustedMessage,
} from './quota';

test('isQuotaExhausted at 100 percent', () => {
  assert.equal(isQuotaExhausted({ primaryUsedPercent: 100 }), true);
  assert.equal(isQuotaExhausted({ primaryUsedPercent: 42 }), false);
});

test('quotaExhaustedMessage uses local reset clock', () => {
  const now = new Date('2026-08-22T10:00:00').getTime();
  const resetAtMs = new Date('2026-08-22T21:00:00').getTime();
  assert.equal(formatQuotaReset(resetAtMs, now), '今天 21:00');
  assert.equal(quotaExhaustedMessage({}, '429'), '额度用完或请求太频繁，请稍后再试');
  assert.equal(isQuotaError('rate_limit exceeded'), true);
});

test('formatContextUsage and formatQuotaLine', () => {
  assert.equal(formatContextUsage({ totalTokens: 16092, maxContext: 1000000, usedPercent: 1.6 }), '已用 16K / 1000K（2%）');
  assert.equal(formatContextUsage({ usedPercent: 12 }), '占用 12%');
  const now = new Date('2026-08-22T10:00:00').getTime();
  const resetAtMs = new Date('2026-08-22T21:00:00').getTime();
  assert.equal(formatQuotaLine({ primaryUsedPercent: 40, resetAtMs }, now), '账号剩余 60% · 今天 21:00 重置');
});
