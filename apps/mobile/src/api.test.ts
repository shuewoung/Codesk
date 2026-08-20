import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { loginLan, pairWithCode, revokeDevice } from './api';

const originalFetch = globalThis.fetch;
const calls: { url: string; init: RequestInit }[] = [];

afterEach(() => {
  calls.length = 0;
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const req = init || {};
    calls.push({ url, init: req });
    return handler(url, req);
  }) as typeof fetch;
}

test('pairWithCode requires relay url and code', async () => {
  await assert.rejects(() => pairWithCode('', 'ABC'), /中继地址/);
  await assert.rejects(() => pairWithCode('https://relay.example.com', '  '), /配对码/);
});

test('pairWithCode posts JSON and returns deviceToken/hubId', async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ deviceToken: 'odt_x', hubId: 'hub-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const result = await pairWithCode('relay.example.com/', 'abc123');
  assert.deepEqual(result, { deviceToken: 'odt_x', hubId: 'hub-1', hubE2ePub: '' });
  assert.equal(calls[0].url, 'https://relay.example.com/api/relay/pair');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, JSON.stringify({ code: 'abc123' }));
});

test('pairWithCode surfaces relay error message', async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ code: 'invalid_code', message: 'invalid pairing code' }), { status: 401 }),
  );
  await assert.rejects(() => pairWithCode('https://relay.example.com', 'NOPE'), /配对码不对/);
});

test('pairWithCode maps fetch failure to network error', async () => {
  mockFetch(() => {
    throw new TypeError('Network request failed');
  });
  await assert.rejects(() => pairWithCode('https://relay.example.com', 'ABC'), /网络不通/);
});

test('loginLan posts password/code to hub', async () => {
  mockFetch(() =>
    new Response(JSON.stringify({ token: 'sess', hubId: 'hub-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const result = await loginLan('127.0.0.1:18990', 'ABC123');
  assert.deepEqual(result, { token: 'sess', hubId: 'hub-1' });
  assert.equal(calls[0].url, 'http://127.0.0.1:18990/api/auth/login');
  assert.equal(calls[0].init.body, JSON.stringify({ password: 'ABC123', code: 'ABC123' }));
});

test('loginLan maps fetch failure to a chinese error', async () => {
  mockFetch(() => {
    throw new TypeError('Network request failed');
  });
  await assert.rejects(() => loginLan('http://192.168.1.8:18990', 'ABC'), /同一 WiFi/);
});

test('revokeDevice sends Bearer token and does nothing without creds', async () => {
  mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await revokeDevice('', 'tok');
  await revokeDevice('https://relay.example.com', '');
  assert.equal(calls.length, 0);
  await revokeDevice('https://relay.example.com', 'odt_x');
  assert.equal(calls[0].url, 'https://relay.example.com/api/relay/revoke');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer odt_x');
});
