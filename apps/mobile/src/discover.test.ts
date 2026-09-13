import assert from 'node:assert/strict';
import test from 'node:test';
import { canLanProbe, candidateHubUrls, HUB_PORT, hubUrlForPage, isColocatedWebShell, isPrivateIPv4, isPublicPageHost, isRelayPageHost, normalizeHubUrl, pageHubUrl, sameHostHubUrl } from './discover';

test('normalizeHubUrl uses http for lan and loopback', () => {
  assert.equal(normalizeHubUrl('127.0.0.1:18990'), 'http://127.0.0.1:18990');
  assert.equal(normalizeHubUrl('localhost:18990/'), 'http://localhost:18990');
  assert.equal(normalizeHubUrl('192.168.1.8:18990'), 'http://192.168.1.8:18990');
  assert.equal(normalizeHubUrl('http://192.168.1.8:18990/'), 'http://192.168.1.8:18990');
});

test('candidateHubUrls follows protocol order and does not sweep 1-254', () => {
  const urls = candidateHubUrls({
    pageOrigin: 'http://192.168.1.8:18991',
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

test('canLanProbe default (node) is false', () => {
  assert.equal(canLanProbe(), false);
});

test('canLanProbe native always true', () => {
  assert.equal(canLanProbe({ os: 'ios' }), true);
  assert.equal(canLanProbe({ os: 'android' }), true);
});

test('canLanProbe expo web allows non-relay hosts', () => {
  assert.equal(canLanProbe({ os: 'web', hostname: 'localhost', port: '18991' }), true);
  assert.equal(canLanProbe({ os: 'web', hostname: '192.168.1.8', port: '18991' }), true);
});

test('sameHostHubUrl uses the page host and hub port', () => {
  assert.equal(sameHostHubUrl({ hostname: '127.0.0.1' }), 'http://127.0.0.1:18990');
  assert.equal(sameHostHubUrl({ hostname: '192.168.1.8' }), 'http://192.168.1.8:18990');
  assert.equal(sameHostHubUrl({ hostname: '100.66.1.5' }), 'http://100.66.1.5:18990');
  assert.equal(sameHostHubUrl({ hostname: 'hub.codesk.icu' }), '');
  assert.equal(pageHubUrl({ hostname: '100.66.1.5', port: '18991', protocol: 'http:' }), 'http://100.66.1.5:18990');
  assert.equal(pageHubUrl({ hostname: '100.66.1.5', port: '18990', origin: 'http://100.66.1.5:18990' }), 'http://100.66.1.5:18990');
  assert.equal(isPublicPageHost('cds.zhangsw.work'), true);
  assert.equal(isPublicPageHost('192.168.1.8'), false);
  assert.equal(pageHubUrl({
    hostname: 'cds.zhangsw.work',
    port: '',
    protocol: 'https:',
    origin: 'https://cds.zhangsw.work',
  }), 'https://cds.zhangsw.work');
  assert.equal(pageHubUrl({
    hostname: 'cds.zhangsw.work',
    port: '18991',
    protocol: 'https:',
    origin: 'https://cds.zhangsw.work',
  }), 'https://cds.zhangsw.work');
  assert.equal(pageHubUrl({
    hostname: 'codex.zhangsw.work',
    port: '',
    protocol: 'https:',
    origin: 'https://codex.zhangsw.work',
  }), 'https://codex.zhangsw.work');
  assert.equal(hubUrlForPage('https://codex.zhangsw.work:18990', 'https://codex.zhangsw.work'), 'https://codex.zhangsw.work');
  assert.equal(hubUrlForPage('http://192.168.1.8:18990', 'http://192.168.1.8:18991'), 'http://192.168.1.8:18990');
  assert.equal(isColocatedWebShell({ os: 'web', hostname: 'localhost', port: '18991' }), true);
  assert.equal(isColocatedWebShell({ os: 'web', hostname: '100.66.1.5', port: '18991' }), true);
  assert.equal(isColocatedWebShell({ os: 'web', hostname: 'hub.codesk.icu' }), false);
  assert.equal(isColocatedWebShell({ os: 'ios', hostname: '192.168.1.8' }), false);
});

test('canLanProbe blocks hub-hosted PWA and relay pages', () => {
  assert.equal(canLanProbe({ os: 'web', hostname: '127.0.0.1', port: '18990' }), false);
  assert.equal(canLanProbe({ os: 'web', hostname: 'hub.codesk.icu', port: '8787' }), false);
  assert.equal(isRelayPageHost('hub.codesk.icu'), true);
  assert.equal(isRelayPageHost('localhost'), false);
});
