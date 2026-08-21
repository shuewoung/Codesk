import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAuth, corsHeaders, isAllowedCorsOrigin, isPublicApi, parseCookies } from '../../apps/web-hub/server/auth.js';
import { loadOrCreateIdentity } from '../../apps/web-hub/server/identity.js';
import { runGitReadonly, spawnCommand } from '../../apps/web-hub/server/local-cmd.js';
import { envelopeHasSecrets, toRelayWsUrl } from '../../apps/web-hub/server/relay-client.js';
import { approvalMethodFromKind, buildApprovalParams } from '../../apps/web-hub/server/ipc-client.js';
import { inspectTailLines, threadLooksLive } from '../../apps/web-hub/server/turn-status.js';
import { anonymousBox, anonymousOpen, generateKeyPair, generateSecret, secretOpen, secretSeal } from '../../apps/web-hub/server/e2e.js';

const results = [];
function record(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, detail: err.message });
      console.log(`FAIL ${name} — ${err.message}`);
    });
}

await record('public api allowlist', () => {
  assert.equal(isPublicApi('/api/auth/status', 'GET'), true);
  assert.equal(isPublicApi('/api/discover', 'GET'), true);
  assert.equal(isPublicApi('/api/auth/login', 'POST'), true);
  assert.equal(isPublicApi('/api/threads', 'GET'), false);
  assert.equal(isPublicApi('/api/upload', 'POST'), false);
});

await record('cors allows expo web and lan origins', () => {
  assert.equal(isAllowedCorsOrigin('http://localhost:8081'), true);
  assert.equal(isAllowedCorsOrigin('http://127.0.0.1:8081'), true);
  assert.equal(isAllowedCorsOrigin('http://192.168.1.8:8081'), true);
  assert.equal(isAllowedCorsOrigin('https://example.com'), false);
  const headers = corsHeaders({ headers: { origin: 'http://localhost:8081' } });
  assert.equal(headers['Access-Control-Allow-Origin'], 'http://localhost:8081');
  assert.equal(headers['Access-Control-Allow-Methods'].includes('OPTIONS'), true);
});

await record('identity persists hubId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-id-'));
  const a = loadOrCreateIdentity(dir);
  const b = loadOrCreateIdentity(dir);
  assert.equal(a.hubId, b.hubId);
  assert.equal(a.hubSecret, b.hubSecret);
  const raw = fs.readFileSync(path.join(dir, 'identity.json'), 'utf8');
  assert.equal(raw.includes('hubId'), true);
});

await record('auth cookie Path=/ and unauthorized without login', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-auth-'));
  const auth = createAuth({ dataDir: dir, env: { ONEDESK_PASSWORD: 'secret' } });
  const req = { headers: {} };
  assert.equal(auth.authorize(req), false);
  const bad = auth.login('nope', req);
  assert.equal(bad.ok, false);
  const ok = auth.login('secret', req);
  assert.equal(ok.ok, true);
  assert.match(ok.headers['Set-Cookie'], /Path=\//);
  assert.match(ok.headers['Set-Cookie'], /HttpOnly/);
  const cookies = parseCookies(ok.headers['Set-Cookie'].split(';')[0]);
  assert.equal(auth.authorize({ headers: { cookie: `${Object.keys(cookies)[0]}=${Object.values(cookies)[0]}` } }), true);
  assert.equal(auth.authorize({ headers: { authorization: 'Bearer secret' } }), true);
  assert.equal(auth.authorize({ headers: {}, url: `/?token=${ok.token}` }), true);
});

await record('local command streams stdout', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-cmd-'));
  const chunks = [];
  const run = spawnCommand({
    command: 'echo hub-cmd-ok',
    cwd,
    onChunk: (item) => chunks.push(item),
  });
  const done = await run.done;
  assert.equal(done.exitCode, 0);
  assert.equal(chunks.some((item) => item.stream === 'stdout' && item.chunk.includes('hub-cmd-ok')), true);
});

await record('readonly git status/diff/log', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-git-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout || args.join(' '));
  };
  git(['init']);
  git(['config', 'user.email', 'hub@test.local']);
  git(['config', 'user.name', 'Hub Test']);
  fs.writeFileSync(path.join(cwd, 'readme.txt'), 'hello\n');
  git(['add', 'readme.txt']);
  git(['commit', '-m', 'init']);
  fs.writeFileSync(path.join(cwd, 'readme.txt'), 'hello world\n');
  const result = await runGitReadonly(cwd, 'all');
  assert.equal(result.error, null);
  assert.equal(result.status.includes('readme.txt') || result.diff.includes('hello world'), true);
  assert.equal(Boolean(result.log.trim()), true);
});

await record('relay envelope rejects auth.json / tokens', () => {
  assert.equal(envelopeHasSecrets({ type: 'fwd', payload: { type: 'get_threads' } }), false);
  assert.equal(envelopeHasSecrets({ payload: { access_token: 'x' } }), true);
  assert.equal(envelopeHasSecrets({ file: 'C:\\\\Users\\\\x\\\\.codex\\\\auth.json' }), true);
  assert.equal(toRelayWsUrl('https://relay.example/hub'), 'wss://relay.example/hub');
});

await record('follower approval method mapping', () => {
  assert.equal(approvalMethodFromKind('item/commandExecution/requestApproval'), 'thread-follower-command-approval-decision');
  assert.equal(approvalMethodFromKind('item/fileChange/requestApproval'), 'thread-follower-file-approval-decision');
  assert.equal(approvalMethodFromKind('item/permissions/requestApproval'), 'thread-follower-permissions-request-approval-response');
  const cmd = buildApprovalParams({ conversationId: 't', requestId: 'r', decision: 'accept', kind: 'command' });
  assert.deepEqual(cmd.params, { conversationId: 't', requestId: 'r', decision: 'accept' });
  const perm = buildApprovalParams({ conversationId: 't', requestId: 'r', decision: 'accept', kind: 'permissions' });
  assert.equal(perm.params.response.scope, 'turn');
});

await record('e2e handshake and secretbox hide plaintext', () => {
  const hub = generateKeyPair();
  const device = generateKeyPair();
  const boxed = anonymousBox({ v: 1, devicePub: device.publicKey }, hub.publicKey);
  const opened = anonymousOpen(boxed, hub.secretKey);
  assert.equal(opened.devicePub, device.publicKey);
  const key = generateSecret();
  const enc = secretSeal({ type: 'send_message', text: 'SECRET_CHAT_BODY' }, key, 'kid-1');
  assert.equal(JSON.stringify(enc).includes('SECRET_CHAT_BODY'), false);
  assert.deepEqual(secretOpen(enc, key), { type: 'send_message', text: 'SECRET_CHAT_BODY' });
});

await record('turn tail ignores token_count after complete', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'agent_message' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_completed' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
  ];
  const tail = inspectTailLines(lines);
  assert.equal(tail.open, false);
  assert.equal(tail.complete, true);
});

await record('turn tail stays open after start and tools', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }),
  ];
  assert.equal(inspectTailLines(lines).open, true);
});

await record('turn tail open if work continues after complete', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_completed' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started' } }),
  ];
  assert.equal(inspectTailLines(lines).open, true);
});

await record('live working requires open tail and fresh mtime', () => {
  const now = 1_000_000;
  assert.equal(threadLooksLive({ open: true }, { mtimeMs: now - 1_000 }, now), true);
  assert.equal(threadLooksLive({ open: true }, { mtimeMs: now - 180_000 }, now), false);
  assert.equal(threadLooksLive({ open: false }, { mtimeMs: now - 1_000 }, now), false);
});

const failed = results.filter((row) => !row.ok);
console.log(`\nunit ${results.length - failed.length}/${results.length}`);
if (failed.length) process.exitCode = 1;
void fileURLToPath;
