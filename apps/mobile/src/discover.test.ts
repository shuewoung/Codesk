import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateHubUrls, HUB_PORT, isPrivateIPv4, normalizeHubUrl } from './discover';

test('normalizeHubUrl uses http for lan and loopback', () => {
  assert.equal(normalizeHubUrl('127.0.0.1:18990'), 'http://127.0.0.1:18990');
  assert.equal(normalizeHubUrl('localhost:18990/'), 'http://localhost:18990');
  assert.equal(normalizeHubUrl('192.168.1.8:18990'), 'http://192.168.1.8:18990');
  assert.equal(normalizeHubUrl('http://192.168.1.8:18990/'), 'http://192.168.1.8:18990');
});

test('candidateHubUrls follows protocol order and does not sweep 1-254', () => {
  const urls = candidateHubUrls({
    pageOrigin: 'http://192.168.1.8:8081',
    pageHostname: '192.168.1.8',
    lastLanUrl: 'http://192.168.1.20:18990',
  });
  assert.deepEqual(urls, [
    'http://192.168.1.20:18990',
    'http://127.0.0.1:18990',
    'http://localhost:18990',
    'http://192.168.1.8:18990',
    'http://192.168.1.1:18990',
    'http://192.168.1.2:18990',
  ]);
  assert.equal(urls.length <= 8, true);
  assert.equal(urls.some((u) => u.endsWith('.254:18990')), false);
});

test('page already on hub port is tried first', () => {
  const urls = candidateHubUrls({
    pageOrigin: `http://127.0.0.1:${HUB_PORT}`,
    pageHostname: '127.0.0.1',
  });
  assert.equal(urls[0], 'http://127.0.0.1:18990');
});

test('native candidates skip loopback', () => {
  const urls = candidateHubUrls({
    pageHostname: '192.168.6.147',
    includeLoopback: false,
  });
  assert.deepEqual(urls, [
    'http://192.168.6.147:18990',
    'http://192.168.6.1:18990',
    'http://192.168.6.2:18990',
  ]);
});

test('isPrivateIPv4 rejects public and loopback', () => {
  assert.equal(isPrivateIPv4('192.168.1.8'), true);
  assert.equal(isPrivateIPv4('10.0.0.2'), true);
  assert.equal(isPrivateIPv4('172.16.0.1'), true);
  assert.equal(isPrivateIPv4('127.0.0.1'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
});
