#!/usr/bin/env node
// 决定性实验：initialize 后发真实 app-server 请求，验证桌面 app-server 经路由器应答
import net from 'node:net';
import crypto from 'node:crypto';

const PIPE = '\\\\.\\pipe\\codex-ipc';

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

const sock = net.createConnection({ path: PIPE });
let buf = Buffer.alloc(0);
const pendingInit = [];

sock.on('connect', () => {
  console.log('[probe] 已连接管道');
  sock.write(frame({ type: 'request', requestId: 'init-1', method: 'initialize', params: { clientType: 'desktop' } }));
  // 依次发几个真实方法
  setTimeout(() => sock.write(frame({ type: 'request', requestId: 'm1', method: 'thread/list', params: {} })), 500);
  setTimeout(() => sock.write(frame({ type: 'request', requestId: 'm2', method: 'account/status', params: {} })), 900);
});

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    if (buf.length < 4) break;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const json = buf.slice(4, 4 + len).toString('utf8');
    buf = buf.slice(4 + len);
    let msg;
    try { msg = JSON.parse(json); } catch { console.log('[probe] 非JSON:', json.slice(0, 100)); continue; }
    const brief = JSON.stringify(msg);
    console.log('[probe] <<', brief.length > 700 ? brief.slice(0, 700) + ` …(共${brief.length}字符)` : brief);
  }
});

sock.on('error', (e) => { console.log('[probe] 错误:', e.message); process.exit(1); });
setTimeout(() => { console.log('[probe] 结束'); sock.destroy(); process.exit(0); }, 6000);
