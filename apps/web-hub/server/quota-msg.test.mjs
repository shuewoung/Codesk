import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatQuotaReset,
  isQuotaError,
  isQuotaExhausted,
  quotaExhaustedMessage,
} from './quota-msg.js';

test('isQuotaExhausted at 100 percent', () => {
  assert.equal(isQuotaExhausted({ primaryUsedPercent: 100 }), true);
  assert.equal(isQuotaExhausted({ primaryUsedPercent: 99 }), false);
  assert.equal(isQuotaExhausted({}), false);
});

test('isQuotaError matches 429 and quota language', () => {
  assert.equal(isQuotaError('HTTP 429 rate_limit exceeded'), true);
  assert.equal(isQuotaError('insufficient_quota'), true);
  assert.equal(isQuotaError('writer lock conflict'), false);
});

test('formatQuotaReset uses today/tomorrow', () => {
  const now = new Date('2026-08-22T10:00:00').getTime();
  const today = new Date('2026-08-22T18:30:00').getTime();
  const tomorrow = new Date('2026-08-23T09:05:00').getTime();
  assert.equal(formatQuotaReset(today, now), '今天 18:30');
  assert.equal(formatQuotaReset(tomorrow, now), '明天 09:05');
  assert.equal(formatQuotaReset(now - 1000, now), '');
});

test('quotaExhaustedMessage prefers reset time', () => {
  const resetAtMs = Date.now() + 6 * 60 * 60 * 1000;
  const when = formatQuotaReset(resetAtMs);
  assert.match(quotaExhaustedMessage({ resetAtMs }, '429'), new RegExp(when.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(quotaExhaustedMessage({}, 'rate_limit'), /额度用完/);
});
