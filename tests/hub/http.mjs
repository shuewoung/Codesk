import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { authHeader, connectAuthedWs, startHub, stopHub, waitForWs, writeThreadFixture } from './harness.mjs';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-repo-'));
const git = (args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || args.join(' '));
};
git(['init']);
git(['config', 'user.email', 'hub@test.local']);
git(['config', 'user.name', 'Hub Test']);
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
git(['add', 'a.txt']);
git(['commit', '-m', 'init']);

const threadId = crypto.randomUUID();
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-codex-'));
writeThreadFixture(codexHome, { threadId, cwd: repo });

const hub = await startHub({ CODEX_HOME: codexHome, ONEDESK_PASSWORD: 'lane-pass' });
const headers = authHeader('lane-pass');

try {
  const status = await (await fetch(`${hub.base}/api/auth/status`)).json();
  record('status without login', status.loggedIn === false && Boolean(status.hubId), status.hubId);

  const denied = await fetch(`${hub.base}/api/threads`);
  record('threads denied without login', denied.status === 401);

  const historyDenied = await fetch(`${hub.base}/api/thread-history?threadId=${threadId}`);
  record('history denied without login', historyDenied.status === 401);

  const uploadDenied = await fetch(`${hub.base}/api/upload?name=x.txt`, { method: 'POST', body: 'x' });
  record('upload denied without login', uploadDenied.status === 401);

  let wsDenied = false;
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}`);
      ws.once('open', () => {
        ws.close();
        reject(new Error('opened'));
      });
      ws.once('error', () => {
        wsDenied = true;
        resolve();
      });
    });
  } catch {
    wsDenied = false;
  }
  record('ws denied without login', wsDenied);

  const hostStatus = await (await fetch(`${hub.base}/api/host/status`)).json();
  record('lan code is 4 chars', /^[0-9A-Z]{4}$/.test(hostStatus.lanCode || ''), hostStatus.lanCode);

  const badLanCode = await fetch(`${hub.base}/api/host/lan-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'TOOLONG' }),
  });
  record('rejects non-4-char lan code', badLanCode.status === 400);

  const setLan = await fetch(`${hub.base}/api/host/lan-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'home' }),
  });
  const setLanJson = await setLan.json();
  record('can set custom lan code', setLan.ok && setLanJson.lanCode === 'HOME', setLanJson.lanCode);

  const lanLogin = await fetch(`${hub.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'HOME' }),
  });
  record('login accepts custom lan code', lanLogin.ok);

  const regenLan = await fetch(`${hub.base}/api/host/lan-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const regenLanJson = await regenLan.json();
  record('regen yields new 4-char lan code', regenLan.ok && /^[0-9A-Z]{4}$/.test(regenLanJson.lanCode || '') && regenLanJson.lanCode !== 'HOME', regenLanJson.lanCode);

  const badLogin = await fetch(`${hub.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  record('login rejects bad password', badLogin.status === 401);

  const login = await fetch(`${hub.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'lane-pass' }),
  });
  const loginJson = await login.json();
  const setCookie = login.headers.get('set-cookie') || '';
  record('login sets Path=/ cookie', login.ok && loginJson.success && /Path=\//i.test(setCookie), setCookie.split(';')[0]);

  const threads = await fetch(`${hub.base}/api/threads`, { headers });
  const threadJson = await threads.json();
  record('threads readable after login', threads.ok && Array.isArray(threadJson.data?.threads), String(threadJson.data?.threads?.length || 0));

  const ws = await connectAuthedWs(hub);
  const gitWait = waitForWs(ws, (msg) => msg.type === 'git_status' && msg.threadId === threadId, 10000);
  ws.send(JSON.stringify({ type: 'git_status', threadId, action: 'all' }));
  const gitMsg = await gitWait;
  record('git_status readonly', Boolean(gitMsg && !gitMsg.error && (gitMsg.status || gitMsg.log)), gitMsg?.error || '');

  const out = [];
  const exitWait = waitForWs(ws, (msg) => {
    if (msg.type === 'command_output' && msg.threadId === threadId) out.push(msg);
    return msg.type === 'command_output' && msg.stream === 'exit' && msg.threadId === threadId;
  }, 10000);
  ws.send(JSON.stringify({ type: 'run_command', threadId, command: 'echo hub-cmd-ok' }));
  const exitMsg = await exitWait;
  const stdout = out.filter((msg) => msg.stream === 'stdout').map((msg) => msg.chunk).join('');
  record('run_command streams output', Boolean(exitMsg && exitMsg.exitCode === 0 && stdout.includes('hub-cmd-ok')), stdout.trim());
  ws.close();

  const cookie = setCookie.split(';')[0];
  await fetch(`${hub.base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  const afterLogout = await fetch(`${hub.base}/api/threads`, { headers: { cookie } });
  record('logout clears session', afterLogout.status === 401);
} catch (err) {
  record('http suite crashed', false, err.message);
} finally {
  stopHub(hub);
}

const failed = results.filter((row) => !row.ok);
console.log(`\nhttp ${results.length - failed.length}/${results.length}`);
if (failed.length) process.exitCode = 1;
