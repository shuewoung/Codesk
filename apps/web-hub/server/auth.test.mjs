import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackAddress, isForwardedRequest, isTrustedLocalReq } from './auth.js';

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
    headers: { origin: 'http://localhost:18991' },
  }, 18990), true);
  assert.equal(isTrustedLocalReq({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://100.66.1.5:18991' },
  }, 18990), true);
  assert.equal(isTrustedLocalReq({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://localhost:9999' },
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

test('cloudflare tunnel / zero trust forwarded requests are not trusted local', () => {
  const loop = { socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(isForwardedRequest({ headers: { 'cf-connecting-ip': '203.0.113.8' } }), true);
  assert.equal(isTrustedLocalReq({
    ...loop,
    headers: { 'cf-connecting-ip': '203.0.113.8' },
  }, 18990), false);
  assert.equal(isTrustedLocalReq({
    ...loop,
    headers: { 'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.e30.sig' },
  }, 18990), false);
  assert.equal(isTrustedLocalReq({
    ...loop,
    headers: { 'x-forwarded-for': '203.0.113.8' },
  }, 18990), false);
  assert.equal(isTrustedLocalReq({
    ...loop,
    headers: { 'x-forwarded-proto': 'https' },
  }, 18990), false);
});
