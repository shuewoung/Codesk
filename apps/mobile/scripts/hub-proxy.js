'use strict';

const http = require('node:http');

const HUB_HOST = '127.0.0.1';
const HUB_PORT = Number(process.env.HUB_PORT || process.env.CODESK_HUB_PORT || 18990);

function requestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    return null;
  }
}

function isHubApiRequest(req) {
  const url = requestUrl(req);
  if (!url) return false;
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

function isHubUpgradeRequest(req) {
  const url = requestUrl(req);
  if (!url) return false;
  if (url.searchParams.has('token')) return true;
  if (url.pathname === '/ws' || url.pathname === '/api/ws') return true;
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

function forwardedHeaders(req) {
  const headers = { ...req.headers };
  const incomingHost = String(req.headers.host || '').trim();
  if (incomingHost && !headers['x-forwarded-host']) {
    headers['x-forwarded-host'] = incomingHost;
  }
  if (!headers['x-forwarded-for']) {
    headers['x-forwarded-for'] = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  }
  if (!headers['x-forwarded-proto']) {
    const xf = String(req.headers['x-forwarded-proto'] || '').trim();
    headers['x-forwarded-proto'] = xf || (req.socket?.encrypted ? 'https' : 'http');
  }
  return headers;
}

function ignoreSocketError(socket) {
  if (!socket || socket.__codeskIgnoreErr) return socket;
  socket.__codeskIgnoreErr = true;
  socket.on('error', () => {});
  return socket;
}

function writeUnavailable(res) {
  if (res.headersSent || res.writableEnded) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '无法连接' }));
}

function proxyHubHttp(req, res, opts = {}) {
  const port = Number(opts.port || HUB_PORT);
  ignoreSocketError(req);
  ignoreSocketError(res);
  const p = http.request({
    hostname: opts.host || HUB_HOST,
    port,
    path: req.url,
    method: req.method,
    headers: forwardedHeaders(req),
  }, (up) => {
    ignoreSocketError(up);
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  p.on('error', () => writeUnavailable(res));
  req.pipe(p);
}

function writeHeadFromUpgrade(socket, upRes) {
  const reason = upRes.statusMessage || (upRes.statusCode === 101 ? 'Switching Protocols' : 'OK');
  const lines = [`HTTP/1.1 ${upRes.statusCode} ${reason}`];
  for (const [key, value] of Object.entries(upRes.headers || {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
}

function proxyHubUpgrade(req, socket, head, opts = {}) {
  const port = Number(opts.port || HUB_PORT);
  ignoreSocketError(socket);
  ignoreSocketError(req);
  const p = http.request({
    hostname: opts.host || HUB_HOST,
    port,
    path: req.url,
    method: 'GET',
    headers: forwardedHeaders(req),
  });
  p.on('upgrade', (upRes, upSocket, upHead) => {
    ignoreSocketError(upSocket);
    writeHeadFromUpgrade(socket, upRes);
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  p.on('response', (upRes) => {
    ignoreSocketError(upRes);
    writeHeadFromUpgrade(socket, upRes);
    upRes.pipe(socket);
  });
  p.on('error', () => {
    try { socket.destroy(); } catch { /* ignore */ }
  });
  p.end();
}

function attachHubUpgradeProxy(httpServer, opts = {}) {
  if (!httpServer || httpServer.__codeskHubWs) return false;
  const previous = httpServer.listeners('upgrade').slice();
  if (!previous.length) return false;
  httpServer.__codeskHubWs = true;
  httpServer.removeAllListeners('upgrade');
  httpServer.on('upgrade', (req, socket, head) => {
    if (isHubUpgradeRequest(req)) {
      proxyHubUpgrade(req, socket, head, opts);
      return;
    }
    for (const fn of previous) fn.call(httpServer, req, socket, head);
  });
  return true;
}

function createHubProxyMiddleware(metroMiddleware, opts = {}) {
  return (req, res, next) => {
    attachHubUpgradeProxy(req.socket?.server, opts);
    if (isHubApiRequest(req)) {
      proxyHubHttp(req, res, opts);
      return;
    }
    return metroMiddleware(req, res, next);
  };
}

function serverPort(server) {
  try {
    const addr = server?.address?.();
    if (addr && typeof addr === 'object') return Number(addr.port);
  } catch {
    /* ignore */
  }
  return 0;
}

function installHubProxy(opts = {}) {
  if (http.Server.prototype.__codeskHubPatched) return true;
  http.Server.prototype.__codeskHubPatched = true;
  const origEmit = http.Server.prototype.emit;
  const hubPort = Number(opts.port || HUB_PORT);
  http.Server.prototype.emit = function codeskHubEmit(type, ...args) {
    if (serverPort(this) !== hubPort) {
      if (type === 'request') {
        const [req, res] = args;
        if (req && res && isHubApiRequest(req)) {
          proxyHubHttp(req, res, opts);
          return true;
        }
      }
      if (type === 'upgrade') {
        const [req, socket, head] = args;
        if (req && socket && isHubUpgradeRequest(req)) {
          proxyHubUpgrade(req, socket, head, opts);
          return true;
        }
      }
    }
    return origEmit.call(this, type, ...args);
  };
  return true;
}

module.exports = {
  HUB_PORT,
  isHubApiRequest,
  isHubUpgradeRequest,
  proxyHubHttp,
  proxyHubUpgrade,
  attachHubUpgradeProxy,
  createHubProxyMiddleware,
  installHubProxy,
};
