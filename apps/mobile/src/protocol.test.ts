import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractPairFromInput,
  nextBackoffMs,
  normalizeRelayUrl,
  toWsUrl,
  unwrapIncoming,
  wrapFwd,
  wrapPing,
} from './protocol';

test('normalizeRelayUrl adds https and strips slash', () => {
  assert.equal(normalizeRelayUrl('relay.example.com/'), 'https://relay.example.com');
  assert.equal(normalizeRelayUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(normalizeRelayUrl('hub.codesk.icu:8787'), 'https://hub.codesk.icu:8787');
  assert.equal(normalizeRelayUrl('http://hub.codesk.icu:8787'), 'https://hub.codesk.icu:8787');
  assert.equal(normalizeRelayUrl('https://hub.codesk.icu'), 'https://hub.codesk.icu:8787');
});

test('extractPairFromInput reads /?pair=', () => {
  const hit = extractPairFromInput('https://relay.example.com/?pair=ABC123');
  assert.equal(hit.code, 'ABC123');
  assert.equal(hit.relayUrl, 'https://relay.example.com');
  const withHk = extractPairFromInput('https://relay.example.com/?pair=ABC123&hk=abc&lan=http://192.168.1.8:18990');
  assert.equal(withHk.hubE2ePub, 'abc');
  assert.equal(withHk.lanUrl, 'http://192.168.1.8:18990');
  assert.equal(extractPairFromInput('XYZ789').code, 'XYZ789');
  assert.equal(extractPairFromInput('URL:https://relay.example.com/?pair=ab12cd').code, 'AB12CD');
  assert.equal(extractPairFromInput('http://192.168.1.8:18990').code, '');
  assert.equal(extractPairFromInput('http://192.168.1.8:18990/').lanUrl, 'http://192.168.1.8:18990');
});

test('toWsUrl maps scheme and token query', () => {
  assert.equal(
    toWsUrl('https://relay.example.com', 'tok'),
    'wss://relay.example.com/?token=tok',
  );
});

test('wrapFwd keeps application payload', () => {
  assert.deepEqual(wrapFwd('hub-1', { type: 'get_threads' }), {
    v: 1,
    type: 'fwd',
    hubId: 'hub-1',
    payload: { type: 'get_threads' },
  });
});

test('unwrapIncoming splits envelope types', () => {
  assert.deepEqual(
    unwrapIncoming({ v: 1, type: 'fwd', payload: { type: 'thread_list' } }),
    { kind: 'app', message: { type: 'thread_list' } },
  );
  assert.equal(unwrapIncoming({ v: 1, type: 'hub_offline', hubId: 'h' }).kind, 'hub_offline');
  assert.equal(unwrapIncoming({ v: 1, type: 'ping', payload: {} }).kind, 'ping');
  assert.deepEqual(unwrapIncoming({ v: 1, type: 'error', payload: { code: 'revoked', message: '已吊销' } }), {
    kind: 'error',
    code: 'revoked',
    message: '已吊销',
  });
});

test('keepalive ping is envelope, not fwd payload', () => {
  assert.deepEqual(wrapPing(), { v: 1, type: 'ping', payload: {} });
  assert.notEqual(wrapFwd('hub', { type: 'ping' }).type, 'ping');
});

test('backoff caps at 15s', () => {
  assert.equal(nextBackoffMs(0), 1000);
  assert.equal(nextBackoffMs(1), 2000);
  assert.equal(nextBackoffMs(4), 15000);
  assert.equal(nextBackoffMs(9), 15000);
});
