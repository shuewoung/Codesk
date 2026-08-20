import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackAddress, isTrustedLocalReq } from './auth.js';

test('loopback addresses', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.8'), false);
});

test('trusted local allows same-origin loopback and curl', () => {
  const loop = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  assert.equal(isTrustedLocalReq(loop, 18990), true);
  assert.equal(isTrustedLocalReq({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://127.0.0.1:18990' },
  }, 18990), true);
  assert.equal(isTrustedLocalReq({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://localhost:8081' },
  }, 18990), false);
  assert.equal(isTrustedLocalReq({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'https://evil.example' },
  }, 18990), false);
  assert.equal(isTrustedLocalReq({
    socket: { remoteAddress: '192.168.1.8' },
    headers: {},
  }, 18990), false);
});
