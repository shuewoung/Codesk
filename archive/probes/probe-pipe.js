#!/usr/bin/env node
// 探测 codex-ipc 管道：连接 + initialize 握手
import net from 'net';

const PIPE = '\\\\.\\pipe\\codex-ipc';

const ipc = net.createConnection({ path: PIPE });
ipc.on('connect', () => {
  console.log('PIPE CONNECTED');
  const body = Buffer.from(JSON.stringify({ type: 'request', id: 1, method: 'initialize', params: {} }));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  ipc.write(Buffer.concat([head, body]));
});
ipc.on('data', (d) => {
  console.log('DATA:', d.slice(0, 600).toString('utf8'));
  ipc.end();
  process.exit(0);
});
ipc.on('error', (e) => {
  console.log('ERROR:', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log('TIMEOUT no data');
  process.exit(2);
}, 5000);
