import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { Audit } from './audit.js';
import { loadConfig } from './config.js';
import { createHttpHandler } from './http.js';
import { Store } from './store.js';
import { RateLimiter } from './util.js';
import { RelayNet, attachWs } from './ws.js';

export async function createRelay(overrides = {}) {
  const config = loadConfig(process.env, overrides);
  const store = new Store(config.dataDir);
  store.load();
  const audit = new Audit(path.join(config.dataDir, 'audit.ndjson'));
  const net = new RelayNet({ store, audit, config });
  const pairLimiter = new RateLimiter(config.pairFailLimit, config.pairFailWindowMs);
  const pushLimiter = new RateLimiter(config.pushLimit, config.pushWindowMs, 'too many push attempts');
  const handler = createHttpHandler({ store, audit, net, config, pairLimiter });
  const server = createServer(config, handler);
  const wss = attachWs(server, { store, audit, net, config, pairLimiter, pushLimiter });

  async function listen() {
    await new Promise((resolve) => {
      server.listen(config.port, config.host, resolve);
    });
    const addr = server.address();
    config.port = typeof addr === 'object' && addr ? addr.port : config.port;
    return addr;
  }

  async function close() {
    for (const timer of net.offlineTimers.values()) clearTimeout(timer);
    net.offlineTimers.clear();
    for (const ws of wss.clients) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => wss.close(() => resolve()));
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { server, wss, store, audit, net, config, listen, close };
}

function createServer(config, handler) {
  if (config.tlsCert && config.tlsKey) {
    return https.createServer({
      cert: fs.readFileSync(config.tlsCert),
      key: fs.readFileSync(config.tlsKey)
    }, handler);
  }
  return http.createServer(handler);
}

async function main() {
  const relay = await createRelay();
  const addr = await relay.listen();
  const scheme = relay.config.tlsCert && relay.config.tlsKey ? 'https' : 'http';
  const host = relay.config.host === '0.0.0.0' ? '127.0.0.1' : relay.config.host;
  console.log(`[relay] listening ${scheme}://${host}:${addr.port}`);
  console.log(`[relay] web root ${relay.config.webRoot}`);
  console.log(`[relay] data dir ${relay.config.dataDir}`);
  if (!relay.config.tlsCert) {
    console.log('[relay] no TLS cert; put Caddy/Nginx in front for HTTPS/WSS');
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('[relay] fatal', err.message);
    process.exit(1);
  });
}
