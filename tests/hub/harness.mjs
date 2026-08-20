import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');
export const HUB_ENTRY = path.join(REPO_ROOT, 'apps/web-hub/server/index.js');

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

export function writeThreadFixture(codexHome, { threadId, cwd, title = 'fixture' }) {
  const now = new Date();
  const dir = path.join(
    codexHome,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${now.toISOString().replace(/[:.]/g, '-')}-${threadId}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      timestamp: now.toISOString(),
      type: 'session_meta',
      payload: { id: threadId, cwd, title },
    })}\n`,
  );
  return file;
}

export async function startHub(overrides = {}) {
  const port = overrides.PORT || await freePort();
  const dataDir = overrides.ONEDESK_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-data-'));
  const codexHome = overrides.CODEX_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'onedesk-codex-'));
  const password = overrides.ONEDESK_PASSWORD || 'test-password';
  const child = spawn(process.execPath, [HUB_ENTRY], {
    env: {
      ...process.env,
      ...overrides,
      PORT: String(port),
      ONEDESK_PASSWORD: password,
      ONEDESK_DATA_DIR: dataDir,
      CODEX_HOME: codexHome,
      ONEDESK_RELAY_URL: overrides.ONEDESK_RELAY_URL || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${base}/api/auth/status`);
      if (res.ok) {
        return { port, base, password, dataDir, codexHome, child, logs };
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  try { child.kill(); } catch { /* ignore */ }
  throw new Error(`hub did not start:\n${logs.join('')}`);
}

export function stopHub(hub) {
  try { hub.child.kill(); } catch { /* ignore */ }
}

export function authHeader(secret) {
  return { Authorization: `Bearer ${secret}` };
}

export async function connectAuthedWs(hub, secret = hub.password) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}`, { headers: authHeader(secret) });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

export function waitForWs(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(null);
    }, timeoutMs);
    const onMessage = (raw) => {
      const msg = JSON.parse(String(raw));
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}
