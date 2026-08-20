import assert from 'node:assert/strict';
import test from 'node:test';
import { APPROVAL_TTL_MS, isApprovalExpired } from './turn-status.js';

test('isApprovalExpired requires a timestamp and respects TTL', () => {
  assert.equal(isApprovalExpired(null), false);
  assert.equal(isApprovalExpired({}), false);
  assert.equal(isApprovalExpired({ at: Date.now() }), false);
  assert.equal(isApprovalExpired({ at: Date.now() - APPROVAL_TTL_MS - 1 }), true);
});
