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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createAuth, createLoginLimiter, isPublicApi, parseCookies, COOKIE_NAME } from './auth.js';

test('persistent device sessions migrate, survive restart/time and revoke all sockets', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = Date.now();
  const options = { dataDir, env: { CODESK_PASSWORD: 'test-password' }, now: () => clock };
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify([
    { token: 'legacy-valid', expiresAt: clock + 1000 }, { token: 'expired', expiresAt: clock - 1 },
  ]));
  let auth = createAuth(options);
  const req = (token) => ({ socket: { remoteAddress: '192.168.1.2' }, headers: { authorization: `Bearer ${token}` } });
  const login = auth.login('ABCD', req(''), ['ABCD']);
  assert.equal(login.ok, true);
  clock += 10 * 365 * 86400000;
  auth = createAuth(options);
  assert.equal(auth.authorize(req(login.token)), true);
  assert.equal(auth.authorize(req('legacy-valid')), true);
  assert.equal(auth.authorize(req('expired')), false);
  const sockets = [new EventEmitter(), new EventEmitter()];
  let closed = 0;
  for (const ws of sockets) { ws.close = (code) => { assert.equal(code, 4403); closed++; }; auth.trackSocket(req(login.token), ws); }
  auth.logout(req(login.token));
  assert.equal(closed, 2);
  assert.equal(auth.authorize(req(login.token)), false);
  assert.equal(createAuth(options).authorize(req(login.token)), false);
  const id = auth.listDevices()[0].id;
  assert.equal(auth.revokeDevice(id), true);
  assert.equal(auth.authorize(req('legacy-valid')), false);
});

test('login limiter resists forwarded-header spoofing, bounds state and expires', () => {
  let clock = 0;
  const limiter = createLoginLimiter({ now: () => clock, maxAttempts: 2, windowMs: 1000, maxKeys: 2 });
  const req = (ip, forwarded = '') => ({ socket: { remoteAddress: ip }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(limiter.consume(req('192.0.2.1')).ok, true);
  assert.equal(limiter.consume(req('::ffff:192.0.2.1', '1.1.1.1')).ok, true);
  assert.deepEqual(limiter.consume(req('192.0.2.1', '2.2.2.2')), { ok: false, status: 429, code: 'rate_limited', retryAfterSec: 1 });
  assert.equal(limiter.consume(req('192.0.2.2')).ok, true);
  assert.equal(limiter.consume(req('192.0.2.3')).status, 429);
  assert.equal(limiter.consume(req('192.0.2.1')).status, 429);
  clock = 1000;
  assert.equal(limiter.consume(req('192.0.2.3')).ok, true);
  assert.equal(limiter.consume(req('192.0.2.1')).ok, true);
  assert.throws(() => createLoginLimiter({ maxKeys: 0 }), /invalid/);
});

test('auth.login enforces limits for empty, password and pairing-code attempts', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-limit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = 0;
  const auth = createAuth({ dataDir, env: { CODESK_PASSWORD: 'fixture-password' }, now: () => clock,
    loginLimiter: createLoginLimiter({ now: () => clock, maxAttempts: 2, windowMs: 1000 }) });
  const req = { socket: { remoteAddress: '192.0.2.1' }, headers: {} };
  assert.equal(auth.login('', req).ok, false);
  assert.equal(auth.login('wrong', req).ok, false);
  assert.equal(auth.login('fixture-password', req).status, 429);
  assert.equal(auth.login('ABCD', req, ['ABCD']).status, 429);
  assert.equal(auth.listDevices().length, 0);
  clock = 1000;
  const result = auth.login('abcd', req, ['ABCD']);
  assert.equal(result.ok, true);
  assert.equal(auth.authorize({ ...req, headers: { authorization: `Bearer ${result.token}` } }), true);
});

test('original HTTP downloads require credentials and revoked sessions cannot reauthorize', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-download-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const auth = createAuth({ dataDir, env: { CODESK_PASSWORD: 'fixture-password' } });
  const req = { url: '/api/file?download=original&path=fixture', socket: { remoteAddress: '192.0.2.1' }, headers: {} };
  assert.equal(isPublicApi('/api/file', 'GET'), false);
  assert.equal(auth.authorize(req), false);
  assert.equal(auth.authorize({ ...req, url: req.url + '&deviceId=forged' }), false);
  assert.equal(auth.authorize({ ...req, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.1' } }), false);
  const { token } = auth.login('fixture-password', req);
  const variants = [
    { ...req, headers: { authorization: `Bearer ${token}` } },
    { ...req, headers: { cookie: `${COOKIE_NAME}=${token}` } },
    { ...req, url: req.url + `&token=${token}` },
  ];
  for (const request of variants) assert.equal(auth.authorize(request), true);
  const first = new EventEmitter(), second = new EventEmitter();
  let closed = false;
  first.close = () => { throw new Error('fixture broken socket'); };
  second.close = () => { closed = true; };
  auth.trackSocket(variants[0], first);
  const id = auth.trackSocket(variants[0], second);
  assert.equal(auth.revokeDevice(id), true);
  assert.equal(first.revoked, true);
  assert.equal(second.revoked, true);
  assert.equal(closed, true);
  for (const request of variants) assert.equal(auth.authorize(request), false);
});

test('malformed cookie encoding is rejected without throwing', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cookie-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const auth = createAuth({ dataDir, env: { CODESK_PASSWORD: 'test-password' } });
  for (const value of ['%', '%E0%A4%A', '%FF']) {
    assert.equal(parseCookies(`${COOKIE_NAME}=${value}`), null);
    const req = { socket: { remoteAddress: '192.168.1.2' }, headers: { cookie: `${COOKIE_NAME}=${value}` } };
    assert.equal(auth.authorize(req), false);
    assert.doesNotThrow(() => auth.logout(req));
  }
});
