#!/usr/bin/env node
// 冒烟探针：确认 codex.exe app-server 的 stdio JSON-RPC 帧格式与基本方法
// 只读操作（initialize / thread/list），不写任何会话，不影响桌面进程
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODEX_EXE = process.env.CODEX_CLI_PATH || path.resolve(here, '..', '..', '..', 'codex-bin', 'codex.exe');
const TIMEOUT_MS = 15000;

const child = spawn(CODEX_EXE, ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let stdoutBuf = '';
const messages = [];

function tryParseLines() {
  // 假设：换行分隔的 JSON-RPC（每行一条）。若不成立，转储原始字节人工判断。
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      messages.push(msg);
      console.log('[<- stdout JSON]', JSON.stringify(msg).slice(0, 600));
      onMessage(msg);
    } catch {
      console.log('[<- stdout raw]', line.slice(0, 300));
    }
  }
}

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params: params ?? {} };
  const line = JSON.stringify(msg);
  console.log('[-> send]', line.slice(0, 300));
  child.stdin.write(line + '\n');
  return id;
}

function onMessage(msg) {
  // initialize 结果到达后，继续探测只读方法
  if (msg.id === 1 && (msg.result !== undefined || msg.error)) {
    send('thread/list', { useStateDbOnly: true });
  }
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  tryParseLines();
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  process.stderr.write('[<- stderr] ' + chunk);
});
child.on('exit', (code) => {
  console.log(`[exit] code=${code}`);
});

// 1. initialize 握手（clientInfo 与官方客户端同构）
send('initialize', {
  clientInfo: { name: 'codex-remote-hub', title: 'Codex Remote Hub', version: '3.7.0' },
});

setTimeout(() => {
  console.log(`\n[summary] 收到 ${messages.length} 条 JSON 消息`);
  child.kill();
  process.exit(0);
}, TIMEOUT_MS);
