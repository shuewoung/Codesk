#!/usr/bin/env node
// run-proxy.js
// Codex 桌面版 Web 镜像 - 管道代理服务器
// 职责：
//   1. 提供提取的 Codex webview 静态文件
//   2. WebSocket <-> \\.\pipe\codex-ipc 双向字节透传
//   3. 连接管道后发送 initialize 握手（关键！旧版漏了这步导致跑不通）
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPE_NAME = '\\\\.\\pipe\\codex-ipc';
const PORT = process.env.PORT || 18992;
const HOST = process.env.HOST || '127.0.0.1';
const WEBVIEW_DIR = path.join(__dirname, 'extracted_app', 'webview');

// 帧编解码：4字节小端长度 + UTF-8 JSON
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 注入 host-polyfill 到 index.html
function serveIndex(_req, res) {
  const indexPath = path.join(WEBVIEW_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) return res.status(500).send('index.html not found');
  let html = fs.readFileSync(indexPath, 'utf8');
  // 1) 放宽 CSP：允许本页内联脚本 + 本机 ws 连接（代理转发 IPC 用）
  html = html.replace(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
    (m, csp) => {
      const relaxed = csp
        .replace(/script-src 'self' ([^;]+);/, `script-src 'self' 'unsafe-inline' $1;`)
        .replace(/connect-src ([^;]+);/, 'connect-src \'self\' ws://127.0.0.1:* ws://localhost:* sentry-ipc: $1;');
      return `<meta http-equiv="Content-Security-Policy" content="${relaxed}">`;
    }
  );
  // 2) 注入 host-polyfill，在 app 模块之前执行
  html = html.replace('</head>', '<script src="/host-polyfill.js"></script>\n</head>');
  res.type('html').send(html);
}

// 根路径优先走注入逻辑
app.get('/', serveIndex);

// 静态文件
app.use(express.static(WEBVIEW_DIR));
app.get('/host-polyfill.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'host-polyfill.js'));
});
app.use((req, res) => {
  // SPA fallback 也注入
  if (req.path.startsWith('/assets/')) return res.status(404).send('not found');
  serveIndex(req, res);
});

wss.on('connection', (ws) => {
  console.log('[Proxy] 浏览器已连接 WebSocket');
  let ipc;
  let pipeConnected = false;
  const pending = []; // 管道未就绪时暂存的浏览器消息

  try {
    ipc = net.createConnection({ path: PIPE_NAME }, () => {
      pipeConnected = true;
      console.log('[Proxy] 已连接 Codex IPC 管道');
      // 关键：发送 initialize 握手，否则服务端返回 no-client-found
      ipc.write(encodeFrame({
        type: 'request',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'codex-web', title: 'codex-web', version: '1.0.0' } },
      }));
      console.log('[Proxy] 已发送 initialize 握手');
      // 排空暂存消息
      while (pending.length) ipc.write(pending.shift());
    });
  } catch (e) {
    console.error('[Proxy] 无法连接 IPC 管道:', e.message);
    ws.close();
    return;
  }

  // 管道 -> WS（字节透传）
  ipc.on('data', (data) => {
    if (ws.readyState === ws.OPEN) {
      // 日志：截断显示帧类型
      try {
        if (data.length >= 4) {
          const len = data.readUInt32LE(0);
          const json = data.slice(4, 4 + Math.min(len, 200)).toString('utf8');
          console.log('[Proxy] IPC->WS:', json.slice(0, 160));
        }
      } catch {}
      ws.send(data);
    }
  });
  ipc.on('close', () => {
    console.log('[Proxy] IPC 管道关闭');
    if (ws.readyState === ws.OPEN) ws.close();
  });
  ipc.on('error', (err) => {
    console.error('[Proxy] IPC 错误:', err.message);
  });

  // WS -> 管道
  ws.on('message', (message) => {
    try {
      if (Buffer.isBuffer(message) && message.length >= 4) {
        const len = message.readUInt32LE(0);
        const json = message.slice(4, 4 + Math.min(len, 160)).toString('utf8');
        console.log('[Proxy] WS->IPC:', json.slice(0, 120));
      }
    } catch {}
    if (pipeConnected) ipc.write(message);
    else pending.push(message);
  });
  ws.on('close', () => {
    console.log('[Proxy] WebSocket 关闭');
    if (ipc) ipc.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[Proxy] Codex Web 运行在 http://${HOST}:${PORT}`);
  console.log(`[Proxy] 管道: ${PIPE_NAME}`);
  console.log(`[Proxy] 注意: 需先启动 Codex 桌面版 (ChatGPT.exe) 且登录`);
});
