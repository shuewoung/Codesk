import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createHubProxyMiddleware, installHubProxy, isHubApiRequest, isHubUpgradeRequest } from './hub-proxy.js';

test('hub proxy matches api and token websocket', () => {
  assert.equal(isHubApiRequest({ url: '/api/auth/login' }), true);
  assert.equal(isHubApiRequest({ url: '/index.html' }), false);
  assert.equal(isHubUpgradeRequest({ url: '/?token=abc' }), true);
  assert.equal(isHubUpgradeRequest({ url: '/api/ws?token=abc' }), true);
  assert.equal(isHubUpgradeRequest({ url: '/hot' }), false);
});

test('hub proxy forwards /api to hub', async () => {
  const hub = http.createServer((req, res) => {
    assert.equal(req.url, '/api/discover');
    assert.equal(String(req.headers['x-forwarded-for'] || '').length > 0, true);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hub: true }));
  });
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const port = hub.address().port;
  const middleware = createHubProxyMiddleware(() => {
    throw new Error('metro should not run');
  }, { port });
  const expo = http.createServer((req, res) => middleware(req, res, () => {}));
  await new Promise((resolve) => expo.listen(0, '127.0.0.1', resolve));
  const expoPort = expo.address().port;
  const res = await fetch(`http://127.0.0.1:${expoPort}/api/discover`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  await new Promise((resolve) => expo.close(resolve));
  await new Promise((resolve) => hub.close(resolve));
});

test('installHubProxy intercepts before expo cors 403', async () => {
  const hub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, via: 'hub', url: req.url }));
  });
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const port = hub.address().port;
  installHubProxy({ port });
  const expo = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized request from origin');
  });
  await new Promise((resolve) => expo.listen(0, '127.0.0.1', resolve));
  const expoPort = expo.address().port;
  const res = await fetch(`http://127.0.0.1:${expoPort}/api/discover`, {
    headers: { Origin: 'https://cds.zhangsw.work', Host: 'cds.zhangsw.work' },
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.via, 'hub');
  await new Promise((resolve) => expo.close(resolve));
  await new Promise((resolve) => hub.close(resolve));
});
