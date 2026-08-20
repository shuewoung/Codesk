#!/usr/bin/env node
// 集成测试：在 18991 端口起一个隔离实例（不碰 18990 上正在运行的服务与桌面 Codex）
// 全链路：create_thread(真实) → send_message(流式回复) → 审批回路(approvalPolicy=untrusted)
//        → 第二客户端抢锁被拒(writer-lock 翻译) → send_stop 打断
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 18991;
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-hub-it-'));
const PASSWORD = 'integration-pass';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-hub-it-data-'));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 起隔离服务实例
const hub = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    ONEDESK_PASSWORD: PASSWORD,
    ONEDESK_DATA_DIR: DATA_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
hub.stdout.on('data', (d) => process.stdout.write('[hub] ' + d));
hub.stderr.on('data', (d) => process.stderr.write('[hub-err] ' + d));

let ws = null;
const waiters = [];
const broadcastLog = [];
function connectWS() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Authorization: `Bearer ${PASSWORD}` },
    });
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') return;
      broadcastLog.push(msg);
      for (const w of [...waiters]) w(msg);
    });
  });
}
function send(msg) {
  ws.send(JSON.stringify(msg));
}
// 等待下一条满足条件的广播（不消费已到的历史广播）
function waitFor(pred, timeoutMs = 90000) {
  const existing = broadcastLog.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    const w = (msg) => {
      if (pred(msg)) {
        clearTimeout(timer);
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        resolve(msg);
      }
    };
    waiters.push(w);
  });
}

async function waitServerUp() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/status`);
      if (r.ok) return;
    } catch (e) { /* not yet */ }
    await sleep(500);
  }
  throw new Error('server did not start');
}

async function pollAssistantContent(threadId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/thread-history?threadId=${threadId}`, {
        headers: { Authorization: `Bearer ${PASSWORD}` },
      });
      const j = await r.json();
      const items = j?.data?.items || [];
      const reply = items.filter((it) => it.type === 'agent_message' || it.type === 'message')
        .map((it) => String(it.message || it.content || it.text || ''))
        .find((t) => t.trim().length > 0);
      if (reply) return reply;
    } catch (e) { /* retry */ }
    await sleep(2500);
  }
  return null;
}

async function main() {
  await waitServerUp();
  record('隔离实例启动(18991)', true);
  await connectWS();
  record('WS 连接', true);

  // ---- create_thread（真实 app-server 会话）----
  send({ type: 'create_thread', targetCwd: CWD, title: '集成测试-链路' });
  const created = await waitFor((m) => m.type === 'thread_created', 60000);
  const threadId = created?.threadId;
  record('create_thread 真实会话', !!threadId, threadId ? threadId.slice(0, 13) + '…' : '超时');

  // ---- send_message + 流式回复 ----
  send({ type: 'send_message', threadId, text: '请只回复四个字：链路正常' });
  const feedback = await waitFor((m) => m.type === 'action_feedback' && /Send/.test(m.message), 60000);
  record('send_message 提交', feedback?.status === 'success', feedback?.message || '超时');
  const reply = await pollAssistantContent(threadId);
  record('流式回复到达(jsonl 管线)', !!reply, reply ? String(reply).slice(0, 40) : '120s 内未见回复');

  // ---- 审批回路（approvalPolicy=untrusted 强制触发）----
  send({ type: 'create_thread', targetCwd: CWD, title: '集成测试-审批', approvalPolicy: 'untrusted' });
  const created2 = await waitFor((m) => m.type === 'thread_created' && m.threadId !== threadId, 60000);
  const apThread = created2?.threadId;
  record('create_thread(untrusted)', !!apThread);

  if (apThread) {
    send({ type: 'send_message', threadId: apThread, text: '请运行命令：echo integration-approval-test，然后告诉我输出。' });
    const approval = await waitFor((m) => m.type === 'approval_request' && m.threadId === apThread, 90000);
    record('审批请求实时广播', !!approval, approval ? String(approval.command || approval.kind).slice(0, 60) : '90s 未触发');
    if (approval) {
      send({ type: 'send_approval', threadId: apThread, requestId: approval.requestId, decision: 'accept' });
      const apFeedback = await waitFor((m) => m.type === 'action_feedback' && /审批/.test(m.message), 15000);
      record('审批决策送达', apFeedback?.status === 'success', apFeedback?.message || '无反馈');
      const apReply = await pollAssistantContent(apThread, 90000);
      record('审批后会话继续完成', !!apReply, apReply ? String(apReply).slice(0, 50) : '90s 内未完成');
    }
  }

  // ---- writer-lock 冲突翻译（第二个客户端抢我们持有的线程）----
  const { CodexAppServer, isWriterLockError } = await import('./appserver.js');
  send({ type: 'send_message', threadId, text: '请从 1 慢慢数到 50，每个数字一行。' });
  await sleep(2500);
  const rival = new CodexAppServer();
  let lockErr = null;
  try {
    await rival.ensureStarted();
    await rival.resumeThread(threadId);
  } catch (e) {
    lockErr = e;
  }
  record('writer-lock 冲突被拒', isWriterLockError(lockErr), lockErr ? String(lockErr.message).slice(0, 70) : '竟然成功了(不应发生)');
  rival.stop();

  // ---- send_stop 打断 ----
  send({ type: 'send_stop', threadId });
  const stopFeedback = await waitFor((m) => m.type === 'action_feedback' && /打断/.test(m.message), 30000);
  record('send_stop 打断', stopFeedback?.status === 'success', stopFeedback?.message || '超时');

  // 汇总
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 集成测试: ${results.length - failed.length}/${results.length} 通过 =====`);
  process.exitCode = failed.length ? 1 : 0;
}

main()
  .catch((e) => {
    console.error('[integration] 异常:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    try { ws?.close(); } catch (e) {}
    hub.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
