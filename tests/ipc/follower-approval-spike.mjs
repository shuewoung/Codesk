#!/usr/bin/env node
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPE = '\\\\.\\pipe\\codex-ipc';
const HOST_ID = 'local';
const VERSIONS = {
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
};
const here = path.dirname(fileURLToPath(import.meta.url));

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function createDecoder(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len === 0 || len > 45 * 1024 * 1024) {
        onMsg(new Error(`invalid frame length ${len}`));
        return;
      }
      if (buf.length < 4 + len) return;
      const json = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      try {
        onMsg(null, JSON.parse(json));
      } catch (error) {
        onMsg(error);
      }
    }
  };
}

function defaultThreadId() {
  if (process.env.CODEX_THREAD_ID?.trim()) return process.env.CODEX_THREAD_ID.trim();
  const artifact = path.resolve(here, '../artifacts/session-count.json');
  if (fs.existsSync(artifact)) {
    const data = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    return data.projectThreads?.[0]?.id || null;
  }
  return null;
}

function parseArgs(argv) {
  const out = { kind: 'command', decision: 'accept', dryRun: argv.includes('--dry-run') };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--kind') out.kind = argv[++i];
    else if (arg === '--decision') out.decision = argv[++i];
    else if (arg === '--request-id') out.requestId = argv[++i];
    else if (arg === '--dry-run') continue;
    else rest.push(arg);
  }
  out.conversationId = rest[0] || defaultThreadId();
  out.requestId = out.requestId || rest[1] || process.env.CODEX_APPROVAL_REQUEST_ID || null;
  return out;
}

function methodOf(kind) {
  const raw = String(kind || '').toLowerCase();
  if (raw.includes('file') || raw.includes('patch')) return 'thread-follower-file-approval-decision';
  if (raw.includes('permission')) return 'thread-follower-permissions-request-approval-response';
  return 'thread-follower-command-approval-decision';
}

function paramsOf({ conversationId, requestId, decision, kind }) {
  const method = methodOf(kind);
  if (method === 'thread-follower-permissions-request-approval-response') {
    const accept = ['accept', 'allow', 'approved', 'acceptforsession', 'session'].includes(String(decision).toLowerCase());
    return {
      conversationId,
      requestId,
      response: accept ? { permissions: {}, scope: 'turn' } : { decision: 'decline' },
    };
  }
  return { conversationId, requestId, decision };
}

function brief(msg) {
  const text = JSON.stringify(msg);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function writeReport(report) {
  const outDir = path.resolve(here, '../artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'follower-approval-spike.json');
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log('wrote', out);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = {
    pipe: PIPE,
    conversationId: args.conversationId,
    requestId: args.requestId,
    kind: args.kind,
    decision: args.decision,
    initialize: null,
    discovery: null,
    approval: null,
    errors: [],
  };
  if (!args.conversationId) {
    console.error('FAIL: missing conversationId');
    process.exit(2);
  }
  if (!args.requestId && !args.dryRun) {
    console.error('FAIL: missing requestId (Desktop JSON-RPC id). Pass it or use --dry-run');
    process.exit(2);
  }

  const sock = net.createConnection({ path: PIPE });
  const pending = new Map();
  const clientId = { current: 'initializing-client' };
  const send = (method, params, extra = {}) => {
    const requestId = crypto.randomUUID();
    const payload = {
      type: 'request',
      requestId,
      sourceClientId: clientId.current,
      version: VERSIONS[method] ?? 1,
      method,
      params,
      ...extra,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`timeout waiting for ${method}`));
      }, extra.timeoutMs || 8000);
      pending.set(requestId, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      sock.write(frame(payload));
    });
  };

  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
    setTimeout(() => reject(new Error('pipe connect timeout')), 3000);
  });
  console.log('PASS connect', PIPE);

  sock.on('data', createDecoder((err, msg) => {
    if (err) {
      report.errors.push(err.message);
      return;
    }
    if (msg?.type === 'client-discovery-request') {
      sock.write(frame({
        type: 'client-discovery-response',
        requestId: msg.requestId,
        response: { canHandle: false },
      }));
      return;
    }
    const waiter = pending.get(msg?.requestId);
    if (waiter) {
      pending.delete(msg.requestId);
      waiter.resolve(msg);
    }
  }));

  try {
    const init = await send('initialize', { clientType: 'vscode' });
    report.initialize = init;
    const assigned = init?.result?.clientId || init?.handledByClientId;
    if (init?.resultType !== 'success' || !assigned) {
      console.error('FAIL initialize', brief(init));
      process.exit(3);
    }
    clientId.current = assigned;
    console.log('PASS initialize clientId=', assigned);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const discovery = await send('thread-owner-discovery', {
      hostId: HOST_ID,
      conversationId: args.conversationId,
    }, { timeoutMs: 5000 });
    report.discovery = discovery;
    const ownerId = discovery?.handledByClientId;
    if (discovery?.resultType === 'error' || !ownerId) {
      console.error('FAIL discovery', discovery?.error || brief(discovery));
      writeReport(report);
      process.exit(4);
    }
    console.log('PASS discovery owner=', ownerId);

    if (args.dryRun) {
      console.log('SKIP approval (--dry-run). Need Desktop JSON-RPC requestId to decide.');
      writeReport(report);
      sock.destroy();
      process.exit(0);
    }

    const method = methodOf(args.kind);
    const params = paramsOf(args);
    report.method = method;
    report.params = params;
    const approval = await send(method, params, { targetClientId: ownerId, timeoutMs: 8000 });
    report.approval = approval;
    if (approval?.resultType === 'error') {
      console.error('FAIL approval', approval.error, brief(approval));
      writeReport(report);
      process.exit(5);
    }
    console.log('PASS approval', brief(approval));
    writeReport(report);
    sock.destroy();
    process.exit(0);
  } catch (error) {
    report.errors.push(error.message);
    console.error('FAIL', error.message);
    writeReport(report);
    sock.destroy();
    process.exit(1);
  }
}

main();
