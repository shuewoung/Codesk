import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';
import { CodexAppServer, isWriterLockError, normalizeDecision, normalizeInput } from './appserver.js';
import { getIpcClient } from './ipc-client.js';
import { createAuth, corsHeaders, isLoopbackAddress, isPublicApi } from './auth.js';
import { defaultDataDir, loadOrCreateIdentity, loadRelayConfig } from './identity.js';
import { createRelayClient, pairLandingUrl } from './relay-client.js';
import { spawnCommand, runGitReadonly } from './local-cmd.js';
import { createGoalsStore } from './goals.js';
import { APPROVAL_TTL_MS, commandFromFunctionCall, inspectRolloutTail, isNonUserThreadRecord, parseThreadSpawn, resolveLiveStatus, snapshotParseState, threadLooksLive } from './turn-status.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT) || 18990;
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const goals = createGoalsStore(CODEX_HOME);
function resolvePublicDir() {
  const candidates = [
    // 单一维护目录（浏览器/PWA 多端一致版）
    path.join(__dirname, '..', '..', 'web'),
    path.join(__dirname, '..', 'public'),
    path.join(path.dirname(process.execPath), 'public'),
    path.join(process.cwd(), 'public'),
    path.join(process.cwd(), 'apps', 'web'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}
const PUBLIC_DIR = resolvePublicDir();
const UPLOAD_DIR = path.join(CODEX_HOME, 'hub-uploads');
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const CONFIG_TOML_PATH = path.join(CODEX_HOME, 'config.toml');
const AUTH_JSON_PATH = path.join(CODEX_HOME, 'auth.json');
const HISTORY_LIMIT = 250; // 服务端保留的尾部消息窗口大小
const FULL_HISTORY_LIMIT = 2000; // all=true 全量加载上限（配合前端渐进渲染）
const ACCOUNT_QUOTA_TTL_MS = 60 * 1000;
const DATA_DIR = defaultDataDir(process.env);
const identity = loadOrCreateIdentity(DATA_DIR);
const auth = createAuth({ dataDir: DATA_DIR, env: process.env, port: PORT });
const liveCommands = new Map();
const LAN_CODE_FILE = path.join(DATA_DIR, 'lan-code');
const LAN_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function randomLanCode() {
  const bytes = crypto.randomBytes(4);
  let out = '';
  for (const b of bytes) out += LAN_CODE_ALPHABET[b % LAN_CODE_ALPHABET.length];
  return out;
}
function normalizeLanCode(value) {
  const next = String(value || '').replace(/^\uFEFF/, '').trim().toUpperCase();
  return /^[0-9A-Z]{4}$/.test(next) ? next : '';
}
function persistLanCode(code) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LAN_CODE_FILE, `${code}\n`, { encoding: 'utf-8', mode: 0o600 });
  return code;
}
function loadLanCode() {
  try {
    const existing = normalizeLanCode(fs.readFileSync(LAN_CODE_FILE, 'utf8'));
    if (existing) return existing;
  } catch {
    /* create */
  }
  return persistLanCode(randomLanCode());
}
let localLanCode = loadLanCode();

console.log(`[Codex Remote Hub] CODEX_HOME: ${CODEX_HOME}`);
console.log(`[Codex Remote Hub] hubId: ${identity.hubId}`);
if (auth.generated && auth.generatedPassword) {
  console.log(`[auth] 已生成本机口令，保存在 ${auth.passwordFile}`);
  console.log(`[auth] 口令: ${auth.generatedPassword}`);
}

const relayConfig = loadRelayConfig(DATA_DIR, process.env);
const relay = createRelayClient({
  url: relayConfig.url,
  inviteCode: relayConfig.invite,
  identity,
  onFwd(envelope) {
    const payload = envelope?.payload;
    if (!payload || typeof payload !== 'object') return;
    const ws = {
      readyState: 1,
      send(data) {
        const appMsg = typeof data === 'string' ? JSON.parse(data) : data;
        relay.forwardApp(slimRelayApp(appMsg), { deviceId: envelope.deviceId || null });
      },
    };
    handleClientMessage(ws, payload);
  },
  onState(s) {
    if (s?.online) flushJpushToRelay();
  },
});

// ----------------------------------------------------
// TOML Config File Parser & Updater
// ----------------------------------------------------
function readCodexConfig() {
  const defaultConfig = {
    model: 'gpt-5.6-sol',
    rawModel: 'gpt-5.6-sol',
    effort: 'xhigh',
    rawEffort: 'xhigh',
    sandboxMode: '完全访问',
    rawSandboxMode: 'danger-full-access',
    accessMode: 'full',
    approvalPolicy: 'never'
  };

  if (!fs.existsSync(CONFIG_TOML_PATH)) return defaultConfig;

  try {
    const content = fs.readFileSync(CONFIG_TOML_PATH, 'utf-8');
    const lines = content.split('\n');
    let model = defaultConfig.model;
    let rawModel = defaultConfig.rawModel;
    let effort = defaultConfig.effort;
    let rawEffort = defaultConfig.rawEffort;
    let sandboxMode = defaultConfig.sandboxMode;
    let rawSandboxMode = defaultConfig.rawSandboxMode;
    let approvalPolicy = defaultConfig.approvalPolicy;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('model =')) {
        const match = trimmed.match(/model\s*=\s*"([^"]+)"/);
        if (match) {
          rawModel = match[1];
          model = rawModel;
        }
      } else if (trimmed.startsWith('model_reasoning_effort =')) {
        const match = trimmed.match(/model_reasoning_effort\s*=\s*"([^"]+)"/);
        if (match) {
          rawEffort = normalizeEffortId(match[1]);
          effort = rawEffort;
        }
      } else if (trimmed.startsWith('sandbox_mode =')) {
        const match = trimmed.match(/sandbox_mode\s*=\s*"([^"]+)"/);
        if (match) rawSandboxMode = match[1];
      } else if (trimmed.startsWith('approval_policy =')) {
        const match = trimmed.match(/approval_policy\s*=\s*"([^"]+)"/);
        if (match) approvalPolicy = match[1];
      }
    }

    let accessMode = 'ask';
    if (rawSandboxMode === 'danger-full-access' && (approvalPolicy === 'never' || !approvalPolicy)) {
      accessMode = 'full';
      sandboxMode = '完全访问';
    } else if (rawSandboxMode === 'workspace-write') {
      accessMode = 'auto';
      sandboxMode = '帮我批准';
    } else {
      accessMode = 'ask';
      sandboxMode = '请求批准';
    }

    return { model, rawModel, effort, rawEffort, sandboxMode, rawSandboxMode, accessMode, approvalPolicy };
  } catch (e) {
    console.error('Error reading config.toml:', e);
    return defaultConfig;
  }
}

function normalizeEffortId(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase();
  const map = {
    none: 'none',
    minimal: 'minimal',
    low: 'low',
    轻度: 'low',
    medium: 'medium',
    中: 'medium',
    high: 'high',
    高: 'high',
    xhigh: 'xhigh',
    'x-high': 'xhigh',
    'very-high': 'xhigh',
    极高: 'xhigh',
    max: 'max',
    maximum: 'max',
    最高: 'max',
    ultra: 'ultra',
    超高: 'ultra'
  };
  return map[key] || map[raw] || raw;
}

function updateCodexConfig(key, value) {
  if (!fs.existsSync(CONFIG_TOML_PATH)) return;

  try {
    let content = fs.readFileSync(CONFIG_TOML_PATH, 'utf-8');

    if (key === 'model') {
      const rawModel = String(value || '').trim();
      if (!rawModel) return;
      content = content.replace(/model\s*=\s*"[^"]+"/, `model = "${rawModel}"`);
      if (!/^model\s*=/m.test(content)) content = `model = "${rawModel}"\n${content}`;
    } else if (key === 'effort') {
      const rawEffort = normalizeEffortId(value);
      if (!rawEffort) return;
      if (/^model_reasoning_effort\s*=/m.test(content)) {
        content = content.replace(/model_reasoning_effort\s*=\s*"[^"]+"/, `model_reasoning_effort = "${rawEffort}"`);
      } else {
        content = `model_reasoning_effort = "${rawEffort}"\n${content}`;
      }
    } else if (key === 'permission') {
      const profiles = {
        ask: { approval: 'on-request', sandbox: 'read-only' },
        auto: { approval: 'on-request', sandbox: 'workspace-write' },
        full: { approval: 'never', sandbox: 'danger-full-access' }
      };
      const profile = profiles[value] || profiles.full;
      const upsert = (src, tomlKey, tomlVal) => {
        const re = new RegExp(`^${tomlKey}\\s*=\\s*"[^"]*"`, 'm');
        if (re.test(src)) return src.replace(re, `${tomlKey} = "${tomlVal}"`);
        return `${tomlKey} = "${tomlVal}"\n${src}`;
      };
      content = upsert(content, 'approval_policy', profile.approval);
      content = upsert(content, 'sandbox_mode', profile.sandbox);
    }

    fs.writeFileSync(CONFIG_TOML_PATH, content, 'utf-8');
    console.log(`[Config Sync] Updated config.toml setting ${key} = ${value}`);
  } catch (e) {
    console.error('Error updating config.toml:', e);
  }
}

// ----------------------------------------------------
// Ultra-Fast Memory Caching for Session Index & Rollout Paths
// ----------------------------------------------------
const rolloutCache = new Map();
let lastRolloutIndexBuildAt = 0;

// ----------------------------------------------------
// Codex Desktop SQLite 权威会话元数据缓存（title / cwd / pinned / archived / 子智能体标记）
// state_5.sqlite 的 threads 表含 thread_source 字段：'user'=主会话、'subagent'=子智能体会话。
// app 左侧列表只显示主会话（thread_source='user'），子智能体会话必须过滤掉。
// 标题权威来源：session_index.jsonl 的 thread_name（LLM 生成的简洁标题，如「克隆 circle-pro 网站」），
// sqlite title 列常为原始首条消息（如「[@sites](plugin://...)」），仅作 fallback。
// 该库是 WAL 模式，node 只读打开会因 -shm 锁报 disk I/O error，因此采用「复制副本 → 临时读」策略。
// 每 3 秒检测一次主库/wal 变化，变化才复制重建缓存，避免高频 IO。
// ----------------------------------------------------
let threadMetaCache = new Map(); // threadId -> { title, cwd, isPinned, isArchived, updatedAtMs }
const titleOverrideMap = new Map(); // threadId -> { name, upd } 手动重命名优先于旧索引
let subagentThreadIds = new Set(); // threadId -> true（子智能体会话，app 列表不显示）
let subagentParentById = new Map(); // childThreadId -> parentThreadId
let lastThreadMetaStat = { mtimeMs: 0, size: 0, walMtimeMs: 0, walSize: 0 };
let threadMetaLastCheck = 0;

function cleanTitle(raw, maxLen = 50) {
  if (!raw) return '';
  let t = String(raw)
    .replace(/\\r\\n/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*`~\-=\s]+/, '')
    .trim();
  if (t.length > maxLen) t = t.slice(0, maxLen - 1) + '…';
  return t;
}

function loadThreadMetaCache(force = false) {
  const now = Date.now();
  if (!force && now - threadMetaLastCheck < 3000) return;
  threadMetaLastCheck = now;

  const dbPath = path.join(CODEX_HOME, 'state_5.sqlite');
  const walPath = dbPath + '-wal';
  if (!fs.existsSync(dbPath)) return;

  let mtimeMs = 0, size = 0, walMtimeMs = 0, walSize = 0;
  try {
    const s = fs.statSync(dbPath);
    mtimeMs = s.mtimeMs; size = s.size;
    if (fs.existsSync(walPath)) {
      const w = fs.statSync(walPath);
      walMtimeMs = w.mtimeMs; walSize = w.size;
    }
  } catch (e) { return; }

  const sigChanged = mtimeMs !== lastThreadMetaStat.mtimeMs
    || size !== lastThreadMetaStat.size
    || walMtimeMs !== lastThreadMetaStat.walMtimeMs
    || walSize !== lastThreadMetaStat.walSize;

  if (!force && !sigChanged) return;
  lastThreadMetaStat = { mtimeMs, size, walMtimeMs, walSize };

  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-db-'));
    // 复制 db + wal（sqlite 打开副本时会自动重建 -shm）
    fs.copyFileSync(dbPath, path.join(tmpDir, 'state_5.sqlite'));
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, path.join(tmpDir, 'state_5.sqlite-wal'));
    }

    // 延迟加载 node:sqlite（Node 22+ 内置，无需第三方依赖）
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tmpDir, 'state_5.sqlite'));
    try {
      const rows = db.prepare(
        'SELECT id, title, cwd, is_pinned, archived, updated_at_ms, thread_source, source FROM threads'
      ).all();
      const next = new Map();
      const subagents = new Set();
      const parents = new Map();
      for (const r of rows) {
        if (!r.id) continue;
        // 非 app 主会话一律不显示：
        //  - thread_source='subagent' / guardian / thread_spawn JSON
        //  - source != 'vscode'：codex exec / CLI 自动化会话（如短剧工厂子任务），app 列表也不显示
        if (isNonUserThreadRecord(r.thread_source, r.source)) {
          subagents.add(r.id);
          next.delete(r.id);
          const spawn = parseThreadSpawn(r.source);
          if (spawn && spawn.parentThreadId) parents.set(r.id, spawn.parentThreadId);
          continue;
        }
        // 同一 thread 可能多行（fork/更新），保留 updated_at_ms 最新的一条
        const prev = next.get(r.id);
        if (!prev || (r.updated_at_ms || 0) >= (prev.updatedAtMs || 0)) {
          next.set(r.id, {
            title: cleanTitle(r.title),
            cwd: r.cwd || '',
            isPinned: !!r.is_pinned,
            isArchived: !!r.archived,
            updatedAtMs: r.updated_at_ms || 0
          });
        }
      }
      for (const id of subagents) next.delete(id);
      threadMetaCache = next;
      subagentThreadIds = subagents;
      subagentParentById = parents;
    } finally {
      try { db.close(); } catch (e) {}
    }
  } catch (e) {
    // node:sqlite 不可用或读失败时静默降级（沿用旧缓存 / 仅 rollout fallback）
    if (!threadMetaCache.size) console.warn('[threadMeta] sqlite read failed:', e.message);
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

// 从 rollout 文件头提取 cwd 与首条用户消息（作标题 fallback）
function extractRolloutHeadInfo(full) {
  const info = { cwd: '', firstUserText: '' };
  try {
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    const chunk = buf.toString('utf-8', 0, bytesRead);

    const cwdMatch = chunk.match(/"cwd"\s*:\s*"([^"]+)"/);
    if (cwdMatch) info.cwd = cwdMatch[1].replace(/\\\\/g, '\\');

    // 逐行解析头部，取第一条真实用户消息（跳过 developer / 环境注入）。
    // 注意新版 rollout 用户消息结构为 payload.content[0].text，
    // 旧版可能是 payload.text，两种都兼容；<recommended_plugins> 等环境注入直接跳过。
    for (const line of chunk.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const entry = JSON.parse(t);
        const payload = entry.payload || {};
        if (entry.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') continue;

        let text = '';
        if (typeof payload.text === 'string') {
          text = payload.text;
        } else if (Array.isArray(payload.content)) {
          text = payload.content
            .map(c => (c && typeof c.text === 'string') ? c.text : '')
            .join(' ');
        } else if (payload.message && typeof payload.message === 'string') {
          text = payload.message;
        }
        text = text.trim();
        if (!text) continue;

        // 过滤环境注入内容（AGENTS.md / recommended_plugins / 系统指令等）
        const isEnvNoise = text.startsWith('<')
          || /^The following is the Codex agent history/i.test(text)
          || /^Here is a list of plugins/i.test(text)
          || /instructions\s+for/i.test(text.slice(0, 60))
          || /environment|user_instructions|app-context/i.test(text.slice(0, 30));

        if (!isEnvNoise) {
          info.firstUserText = text.slice(0, 60);
          break;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return info;
}

// 增量索引刷新：未变化的文件（size/mtime 一致）复用缓存，只对新文件读头
function refreshRolloutIndex() {
  const t0 = Date.now();
  lastRolloutIndexBuildAt = Date.now();
  const sessionsDir = path.join(CODEX_HOME, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  const seen = new Set();

  function walk(dir) {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            walk(full);
          } else if (f.endsWith('.jsonl')) {
            const match = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (match) {
              const threadId = match[1];
              seen.add(threadId);
              const cached = rolloutCache.get(threadId);
              if (cached && cached.path === full && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
                continue; // 未变化，跳过读盘
              }
              const head = extractRolloutHeadInfo(full);
              const projName = head.cwd ? path.basename(path.normalize(head.cwd)) : '其他项目';
              rolloutCache.set(threadId, {
                path: full,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                cwd: head.cwd,
                projectName: projName,
                firstUserText: head.firstUserText
              });
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  walk(sessionsDir);

  // 清理已删除的文件条目
  for (const id of Array.from(rolloutCache.keys())) {
    if (!seen.has(id)) rolloutCache.delete(id);
  }

  console.log(`[refreshRolloutIndex] ${rolloutCache.size} rollout files in ${Date.now() - t0} ms`);
}

function buildRolloutIndex() {
  const sessionsDir = path.join(CODEX_HOME, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;
  rolloutCache.clear();
  refreshRolloutIndex();
}

buildRolloutIndex();

// sessions 目录监视（Windows 支持 recursive）：新会话文件落盘即广播，
// Codex 新版本不再写 session_index.jsonl，必须靠磁盘扫描发现新会话
let sessionsWatchTimer = null;
let lastSessionSetSig = '';
try {
  fs.watch(path.join(CODEX_HOME, 'sessions'), { recursive: true }, () => {
    if (sessionsWatchTimer) return;
    sessionsWatchTimer = setTimeout(() => {
      sessionsWatchTimer = null;
      try {
        refreshRolloutIndex();
        // 仅当会话集合（新增/删除）变化时广播，mtime 抖动交给 pushThreadUpdate 节流通道
        const sig = Array.from(rolloutCache.keys()).sort().join(',');
        if (sig !== lastSessionSetSig) {
          lastSessionSetSig = sig;
          broadcastToClients({ type: 'thread_list', data: getThreadList() });
        }
      } catch (e) {}
    }, 800);
  });
  lastSessionSetSig = Array.from(rolloutCache.keys()).sort().join(',');
} catch (e) {
  console.warn('[sessions watch] unavailable, fallback to poll:', e.message);
}

function findRolloutFilePathFast(threadId) {
  if (rolloutCache.has(threadId)) {
    const cachedInfo = rolloutCache.get(threadId);
    if (cachedInfo && cachedInfo.path && fs.existsSync(cachedInfo.path)) return cachedInfo.path;
  }

  // 节流：避免高并发 miss 时反复全量重建索引
  if (Date.now() - lastRolloutIndexBuildAt < 10000) return null;

  refreshRolloutIndex();
  const cachedInfo = rolloutCache.get(threadId);
  return cachedInfo ? cachedInfo.path : null;
}

function getActiveLockThreadIds() {
  const lockDir = path.join(CODEX_HOME, 'thread-writer-locks');
  if (!fs.existsSync(lockDir)) return new Set();
  try {
    const files = fs.readdirSync(lockDir);
    const active = new Set();
    for (const f of files) {
      if (f.endsWith('.lock') && f !== '.coordination.lock') {
        active.add(f.replace('.lock', ''));
      }
    }
    return active;
  } catch (e) {
    return new Set();
  }
}

function rolloutLooksLive(rolloutInfo) {
  if (!rolloutInfo || !rolloutInfo.path || !fs.existsSync(rolloutInfo.path)) return false;
  try {
    const stats = fs.statSync(rolloutInfo.path);
    return threadLooksLive(inspectRolloutTail(rolloutInfo.path, stats), stats);
  } catch {
    return false;
  }
}

function hasLiveChildAgents(threadId) {
  if (!threadId || !subagentParentById || subagentParentById.size === 0) return false;
  for (const [childId, parentId] of subagentParentById) {
    if (parentId === threadId && rolloutLooksLive(rolloutCache.get(childId))) return true;
  }
  return false;
}

function checkThreadIsActivelyWorking(threadId, rolloutInfo) {
  return rolloutLooksLive(rolloutInfo) || hasLiveChildAgents(threadId);
}

const DESKTOP_STATE_PATH = path.join(CODEX_HOME, '.codex-global-state.json');
let desktopProjectCatalog = {
  orderNames: [],
  roots: [],
  pinnedThreadIds: [],
  pinnedProjectIds: [],
  pinnedOrder: [],
  mtimeMs: 0,
  loaded: false
};

function emptyDesktopCatalog() {
  return { orderNames: [], roots: [], pinnedThreadIds: [], pinnedProjectIds: [], pinnedOrder: [] };
}

function parsePinnedOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const key of raw) {
    const s = String(key || '');
    let m = s.match(/^codex:thread:(?:local:)?(.+)$/);
    if (m) {
      out.push({ type: 'thread', id: m[1] });
      continue;
    }
    m = s.match(/^codex:project:(.+)$/);
    if (m) out.push({ type: 'project', id: m[1] });
  }
  return out;
}

function normalizePathKey(p) {
  return String(p || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/^\\\?\\/, '')
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

function collectProjectRoots(project) {
  const raw = project && (project.rootPaths || project.sources || project.roots);
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item, i) => {
    if (!item) return null;
    const root = typeof item === 'string' ? item : (item.path || item.rootPath || item.root || '');
    if (!root) return null;
    return { root, primary: i === 0 };
  }).filter(Boolean);
}

function loadDesktopProjectCatalog() {
  try {
    const st = fs.statSync(DESKTOP_STATE_PATH);
    if (desktopProjectCatalog.loaded && desktopProjectCatalog.mtimeMs === st.mtimeMs) {
      return desktopProjectCatalog;
    }
    const data = JSON.parse(fs.readFileSync(DESKTOP_STATE_PATH, 'utf8'));
    const localProjects = data['local-projects'] || {};
    const order = Array.isArray(data['project-order']) ? data['project-order'] : [];
    const atom = data['electron-persisted-atom-state'] || {};
    const pinnedThreadIds = Array.isArray(data['pinned-thread-ids']) ? data['pinned-thread-ids'].filter(Boolean) : [];
    const pinnedProjectIds = Array.isArray(data['pinned-project-ids']) ? data['pinned-project-ids'].filter(Boolean) : [];
    const pinnedOrder = parsePinnedOrder(atom['unified-sidebar-pinned-order-v1']);
    const orderNames = [];
    const seen = new Set();
    const roots = [];
    for (const id of order) {
      const project = localProjects[id];
      if (!project || !project.name) continue;
      const projectId = project.id || id;
      if (!seen.has(project.name)) {
        seen.add(project.name);
        orderNames.push(project.name);
      }
      for (const item of collectProjectRoots(project)) {
        roots.push({ root: item.root, name: project.name, id: projectId, primary: item.primary });
      }
    }
    for (const [id, project] of Object.entries(localProjects)) {
      if (!project || !project.name) continue;
      const projectId = project.id || id;
      for (const item of collectProjectRoots(project)) {
        roots.push({ root: item.root, name: project.name, id: projectId, primary: item.primary });
      }
    }
    desktopProjectCatalog = {
      orderNames,
      roots,
      pinnedThreadIds,
      pinnedProjectIds,
      pinnedOrder,
      localProjects,
      mtimeMs: st.mtimeMs,
      loaded: true
    };
    return desktopProjectCatalog;
  } catch (e) {
    return desktopProjectCatalog.loaded ? desktopProjectCatalog : emptyDesktopCatalog();
  }
}

function resolveProject(cwd, catalog) {
  const fallback = cwd ? path.basename(path.normalize(cwd)) : '其他项目';
  const roots = catalog && catalog.roots;
  if (!cwd || !roots || !roots.length) return { name: fallback || '其他项目', id: '' };
  const key = normalizePathKey(cwd);
  let best = '';
  let bestId = '';
  let bestLen = -1;
  let bestPrimary = false;
  for (const item of roots) {
    const rootKey = normalizePathKey(item.root);
    if (!rootKey) continue;
    if (key === rootKey || key.startsWith(rootKey + '\\')) {
      const primary = !!item.primary;
      if (rootKey.length > bestLen || (rootKey.length === bestLen && primary && !bestPrimary)) {
        best = item.name;
        bestId = item.id || '';
        bestLen = rootKey.length;
        bestPrimary = primary;
      }
    }
  }
  return { name: best || fallback || '其他项目', id: bestId };
}

function resolveProjectName(cwd, catalog) {
  return resolveProject(cwd, catalog).name;
}

function sortProjectsByDesktopOrder(projects, orderNames) {
  const order = Array.isArray(orderNames) ? orderNames : [];
  if (!order.length) {
    projects.sort((a, b) => (b.maxMtimeMs || 0) - (a.maxMtimeMs || 0));
    return projects;
  }
  const idx = new Map(order.map((name, i) => [name, i]));
  projects.sort((a, b) => {
    const ai = idx.has(a.name) ? idx.get(a.name) : Number.MAX_SAFE_INTEGER;
    const bi = idx.has(b.name) ? idx.get(b.name) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return (b.maxMtimeMs || 0) - (a.maxMtimeMs || 0);
  });
  return projects;
}

// Fast Thread List Generator with Accurate Working Status Check
// 数据源主次反转：磁盘 rollout 文件扫描为主（Codex 新版已不写 session_index.jsonl），
// 标题/元数据以 state_5.sqlite 的 threads 表为权威，rollout 文件头仅作 fallback
function getThreadList() {
  const tStart = Date.now();
  const catalog = loadDesktopProjectCatalog();

  // 权威元数据缓存（state_5.sqlite，3 秒粒度）
  loadThreadMetaCache();

  // 标题表：session_index.jsonl（app 权威标题来源，LLM 生成的简洁标题）
  const titleMap = new Map();
  const idxPath = path.join(CODEX_HOME, 'session_index.jsonl');
  if (fs.existsSync(idxPath)) {
    try {
      const content = fs.readFileSync(idxPath, 'utf-8');
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const item = JSON.parse(t);
          const tid = item.id || item.thread_id;
          const name = item.thread_name || item.title;
          if (tid && name) {
            // 同一线程可能多条记录（标题会被 app 更新），取 updated_at 最新
            const prev = titleMap.get(tid);
            if (!prev || (item.updated_at || '') >= (prev.upd || '')) {
              titleMap.set(tid, { name: cleanTitle(name), upd: item.updated_at || '' });
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 轻量保鲜：距上次索引刷新超过 5 秒则增量扫一次（watch 失效时的兜底）
  if (Date.now() - lastRolloutIndexBuildAt > 5000) {
    try { refreshRolloutIndex(); } catch (e) {}
  }

  // cwd 规范化：剥离 sqlite 的 \\?\ 长路径前缀
  function normCwd(cwd) {
    if (!cwd) return '';
    return String(cwd).replace(/^\\\\\?\\/, '').replace(/^\\\?\\/, '');
  }

  const pinnedThreadSet = new Set(catalog.pinnedThreadIds || []);
  const rawThreads = [];
  for (const [threadId, info] of rolloutCache) {
    if (!info || !info.path || !fs.existsSync(info.path)) continue;
    // 过滤子智能体会话（app 左侧列表不显示）
    if (subagentThreadIds.has(threadId)) continue;
    const meta = threadMetaCache.get(threadId);
    if (meta && meta.isArchived) continue;
    let mtimeMs = info.mtimeMs;
    try {
      mtimeMs = fs.statSync(info.path).mtimeMs;
    } catch (e) {}
    const sortMs = Number(meta && meta.updatedAtMs) || mtimeMs || 0;

    const isActiveWorking = checkThreadIsActivelyWorking(threadId, info);
    const live = liveApprovalState(threadId);
    let needsApproval = live.live === true;
    if (live.live == null) {
      const parsed = rolloutParseState.get(threadId);
      needsApproval = Boolean(parsed?.pendingApproval && !isParsedApprovalClosed(threadId, parsed.pendingApproval));
    }

    // 元数据优先级：session_index thread_name（app 权威）→ sqlite title → rollout 首条用户消息 → 时间戳
    const cwd = normCwd(meta && meta.cwd ? meta.cwd : (info.cwd || ''));
    const idx = titleMap.get(threadId);
    const override = titleOverrideMap.get(threadId);
    let named = '';
    if (override && idx) named = (override.upd || '') >= (idx.upd || '') ? override.name : idx.name;
    else named = (override && override.name) || (idx && idx.name) || '';
    const title = named
      || (meta && meta.title)
      || (info.firstUserText ? cleanTitle(info.firstUserText) : '')
      || `会话 ${new Date(mtimeMs).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;

    const project = resolveProject(cwd, catalog);

    rawThreads.push({
      id: threadId,
      title,
      updatedAt: sortMs ? new Date(sortMs).toISOString() : new Date().toISOString(),
      mtimeMs: sortMs,
      isActive: isActiveWorking,
      working: isActiveWorking,
      status: needsApproval ? 'waiting_approval' : (isActiveWorking ? 'working' : 'idle'),
      needsApproval,
      isPinned: pinnedThreadSet.has(threadId) || !!(meta && meta.isPinned),
      cwd,
      projectId: project.id || '',
      projectName: project.name
    });
  }

  rawThreads.sort((a, b) => {
    if (!!b.isPinned !== !!a.isPinned) return a.isPinned ? -1 : 1;
    if (!!b.isActive !== !!a.isActive) return a.isActive ? 1 : -1;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });

  const pinnedProjectSet = new Set(catalog.pinnedProjectIds || []);
  const projectMap = new Map();
  for (const t of rawThreads) {
    const key = t.projectName || '其他项目';
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        id: t.projectId || '',
        name: key,
        cwd: t.cwd,
        isPinned: !!(t.projectId && pinnedProjectSet.has(t.projectId)),
        maxMtimeMs: t.mtimeMs,
        threads: []
      });
    }
    const proj = projectMap.get(key);
    if (!proj.id && t.projectId) proj.id = t.projectId;
    if (t.projectId && pinnedProjectSet.has(t.projectId)) proj.isPinned = true;
    proj.threads.push(t);
    if (t.mtimeMs > proj.maxMtimeMs) {
      proj.maxMtimeMs = t.mtimeMs;
    }
  }

  const localProjects = catalog.localProjects || {};
  for (const projectId of pinnedProjectSet) {
    const info = localProjects[projectId];
    if (!info || !info.name) continue;
    const existing = projectMap.get(info.name);
    const roots = collectProjectRoots(info);
    const primaryRoot = roots[0] && roots[0].root ? roots[0].root : '';
    if (existing) {
      existing.id = existing.id || projectId;
      existing.isPinned = true;
      if (!existing.cwd && primaryRoot) existing.cwd = primaryRoot;
      continue;
    }
    projectMap.set(info.name, {
      id: projectId,
      name: info.name,
      cwd: primaryRoot,
      isPinned: true,
      maxMtimeMs: 0,
      threads: []
    });
  }

  const projects = sortProjectsByDesktopOrder(Array.from(projectMap.values()), catalog.orderNames);

  // 避免高频轮询下日志刷屏：仅慢查询才输出
  const elapsed = Date.now() - tStart;
  if (elapsed > 100) {
    console.log(`[getThreadList] Completed in ${elapsed} ms! (${rawThreads.length} threads across ${projects.length} projects)`);
  }
  return {
    threads: rawThreads,
    projects,
    projectOrder: catalog.orderNames,
    pinnedOrder: Array.isArray(catalog.pinnedOrder) ? catalog.pinnedOrder : []
  };
}

// ----------------------------------------------------
// Incremental Rollout Parsing Engine (O(new bytes) instead of O(file size))
// ----------------------------------------------------
// 每个 thread 维护 { offset, rev, items, ... } 状态：
// - JSONL 是 append-only 的，只读取自上次解析以来的新增字节
// - rev 是已处理行数的版本号，用于客户端 delta 合并与 unchanged 短路
const rolloutParseState = new Map();
const lastHttpHistoryMeta = new Map();
const lanClients = new Map();
const approvalClosedIds = new Map(); // threadId -> Set(requestId)
const approvalClosedAt = new Map(); // threadId -> ts

function createEmptyParseState(itemCap = HISTORY_LIMIT * 2) {
  return {
    offset: 0,          // 已解析到的文件字节位置
    mtimeMs: 0,
    rev: 0,             // 已处理行版本号
    items: [],          // 尾部消息窗口
    itemCap,            // 内存中保留的最大 items 数
    totalItems: 0,      // 历史消息总数（用于 hasMore 计算）
    status: 'idle',
    startedAt: null,    // 最早一次 task_started / turn_started 的时间戳
    completedAt: null,  // 最近一次 task_complete / turn_completed 的时间戳
    pendingApproval: null,
    cwd: '',
    tokenUsage: {},
    activeActionText: '',
    restBytes: '',
    openCalls: new Map()
  };
}

// 工具名 → 中文标签（function_call 的 name 字段），exec_command 特殊处理显示真实命令
const TOOL_LABELS = {
  exec_command: '执行命令',
  update_plan: '更新计划',
  write_file: '写入文件',
  read_file: '读取文件',
  apply_patch: '应用补丁',
  apply_delta: '应用补丁',
  edit: '编辑文件',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  list_directory: '浏览目录',
  get_file_info: '读取文件信息',
  run_terminal_command: '执行终端命令',
  save_memory: '保存记忆',
  add_delegated_agent: '启动子智能体'
};

// 从 function_call payload 提取"正在执行"的真实信息（与 Codex 桌面端一致）
function describeFunctionCall(payload) {
  const name = payload && payload.name ? payload.name : 'tool';
  let args = payload && payload.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { args = null; }
  }
  const cmd = args && typeof args.cmd === 'string' ? args.cmd.replace(/[\r\n]+/g, ' ').trim() : '';
  const label = TOOL_LABELS[name] || name;
  if (cmd) return `正在执行: ${cmd.substring(0, 150)}`;
  return `正在${label}...`;
}

function processRolloutLine(entry, state) {
  const topType = entry.type;
  const payload = entry.payload || {};
  const payloadType = payload.type;

  if (topType === 'session_meta') {
    state.cwd = entry.cwd || payload.cwd || state.cwd;
  }

  if (payloadType === 'task_started' || payloadType === 'turn_started') {
    state.status = 'working';
    // 记录最早一次开始时间（多个 turn 时保留首次）
    if (!state.startedAt) state.startedAt = entry.timestamp || payload.timestamp || null;
    if (payload.model_context_window) {
      state.tokenUsage.maxContext = payload.model_context_window;
    }
  } else if (payloadType === 'task_complete' || payloadType === 'turn_completed' || topType === 'turn_completed') {
    state.status = 'idle';
    state.pendingApproval = null;
    state.activeActionText = '';
    if (state.openCalls) state.openCalls.clear();
    // 记录任务完成时间（rollout 行内 timestamp，如 2026-08-15T08:29:45.563Z）
    state.completedAt = entry.timestamp || payload.timestamp || null;
  } else if (payloadType === 'token_count') {
    if (payload.rate_limits) {
      if (payload.rate_limits.primary) {
        state.tokenUsage.primaryUsedPercent = Math.round(payload.rate_limits.primary.used_percent);
        if (payload.rate_limits.primary.resets_at) {
          // 传 epoch ms，前端负责本地化格式化（带日期）
          state.tokenUsage.resetAtMs = payload.rate_limits.primary.resets_at * 1000;
        }
      }
      if (payload.rate_limits.plan_type) {
        state.tokenUsage.planType = payload.rate_limits.plan_type;
      }
    }
    if (payload.info) {
      if (payload.info.last_token_usage && payload.info.last_token_usage.total_tokens) {
        state.tokenUsage.totalTokens = payload.info.last_token_usage.total_tokens;
      }
      if (payload.info.model_context_window) {
        state.tokenUsage.maxContext = payload.info.model_context_window;
        if (state.tokenUsage.totalTokens && state.tokenUsage.maxContext) {
          state.tokenUsage.usedPercent = Math.min(99, Math.round((state.tokenUsage.totalTokens / state.tokenUsage.maxContext) * 100));
        }
      }
    }
  } else if (topType === 'response_item' || topType === 'event_msg') {
    state.items.push(payload);
    if (state.items.length > state.itemCap) {
      state.items.splice(0, state.items.length - state.itemCap);
    }
    state.totalItems++;
    if (payloadType === 'custom_tool_call' || payloadType === 'tool_call') {
      state.status = 'working';
      const inputStr = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input || {});
      const cleanCmd = inputStr.replace(/[\r\n]+/g, ' ').trim();
      if (cleanCmd) state.activeActionText = `正在运行 ${cleanCmd.substring(0, 150)}`;
    } else if (payloadType === 'function_call') {
      state.status = 'working';
      state.activeActionText = describeFunctionCall(payload);
      const callId = String(payload.call_id || payload.callId || payload.id || '');
      if (callId) {
        if (!state.openCalls) state.openCalls = new Map();
        state.openCalls.set(callId, {
          id: String(payload.id || callId),
          callId,
          name: payload.name || '',
          command: commandFromFunctionCall(payload),
        });
      }
    } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const callId = String(payload.call_id || payload.callId || payload.id || '');
      if (callId && state.openCalls) state.openCalls.delete(callId);
    } else if (payloadType === 'reasoning' || payloadType === 'agent_reasoning') {
      state.status = 'working';
      state.activeActionText = '正在深度思考与推理中...';
    }
  } else if (
    topType === 'item/commandExecution/requestApproval'
    || topType === 'item/fileChange/requestApproval'
    || topType === 'item/permissions/requestApproval'
  ) {
    state.status = 'waiting_approval';
    const ids = [
      payload.request_id,
      payload.requestId,
      payload.call_id,
      payload.callId,
      payload.id,
      entry.id,
    ].map((v) => (v == null ? '' : String(v))).filter(Boolean);
    state.pendingApproval = {
      id: ids[0] || '',
      ids: [...new Set(ids)],
      type: topType,
      threadId: payload.threadId,
      command: payload.command || payload.patch,
      reason: payload.reason || 'Permission approval required',
      at: Date.parse(entry.timestamp || payload.timestamp || '') || Date.now()
    };
  }
}

function rolloutTailIsComplete(filePath, stats) {
  return inspectRolloutTail(filePath, stats).complete;
}

function collectPendingIds(pending) {
  if (!pending) return [];
  return [...new Set(
    [pending.id, pending.requestId, ...(Array.isArray(pending.ids) ? pending.ids : [])]
      .map((v) => (v == null ? '' : String(v)))
      .filter(Boolean)
  )];
}

function liveApprovalForThread(threadId) {
  if (!codex || !threadId) return null;
  for (const entry of codex.pendingApprovals.values()) {
    if (String(entry.threadId) === String(threadId)) return entry;
  }
  return null;
}

function desktopPendingForThread(threadId) {
  if (!threadId) return null;
  try {
    const ipc = getIpcClient();
    if (!ipc.pendingByThread.has(threadId)) return null;
    return ipc.pendingByThread.get(threadId) || [];
  } catch {
    return null;
  }
}

function liveApprovalState(threadId) {
  if (!threadId) return { live: null };
  const hubLive = liveApprovalForThread(threadId);
  if (hubLive) return { live: true, entry: hubLive };
  if (codex?.ownedThreads?.has(threadId)) return { live: false };
  const desktop = desktopPendingForThread(threadId);
  if (desktop) return { live: desktop.length > 0, entry: desktop[0] || null };
  return { live: null };
}

function isParsedApprovalClosed(threadId, pending) {
  if (!threadId || !pending) return false;
  const closed = approvalClosedIds.get(threadId);
  if (closed && collectPendingIds(pending).some((id) => closed.has(id))) return true;
  const closedAt = approvalClosedAt.get(threadId);
  if (!closedAt || liveApprovalForThread(threadId)) return false;
  const at = Number(pending.at) || 0;
  return !at || at <= closedAt;
}

function rememberClosedApproval(threadId, ids) {
  if (!threadId) return;
  approvalClosedAt.set(threadId, Date.now());
  let set = approvalClosedIds.get(threadId);
  if (!set) {
    set = new Set();
    approvalClosedIds.set(threadId, set);
  }
  for (const id of ids || []) {
    if (id) set.add(String(id));
  }
  while (set.size > 50) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

function closeParsedApproval(threadId, requestId, reason, extraIds = []) {
  const ids = collectPendingIds({ id: requestId, ids: extraIds });
  const state = rolloutParseState.get(threadId);
  if (state?.pendingApproval) ids.push(...collectPendingIds(state.pendingApproval));
  rememberClosedApproval(threadId, ids);
  if (state?.pendingApproval) {
    const pendingIds = collectPendingIds(state.pendingApproval);
    const hit = !requestId || pendingIds.includes(String(requestId)) || pendingIds.some((id) => ids.includes(id));
    if (hit) {
      state.pendingApproval = null;
      if (state.status === 'waiting_approval') state.status = 'working';
    }
  }
  if (threadId) {
    broadcastToClients({
      type: 'approval_resolved',
      threadId,
      requestId: requestId || '',
      ids,
      reason: reason || 'closed'
    });
    pushThreadUpdate(threadId, true);
    lastThreadListBroadcastAt = 0;
    broadcastToClients({ type: 'thread_list', data: getThreadList() });
  }
}

function dropStaleParsedApproval(state, threadId, activeLocks) {
  if (!state.pendingApproval) return;
  const live = liveApprovalState(threadId);
  const stale = live.live === false || isParsedApprovalClosed(threadId, state.pendingApproval);
  if (!stale) return;
  state.pendingApproval = null;
  if (state.status === 'waiting_approval') state.status = 'idle';
}

function applyLockOverride(state, activeLocks, threadId, stats, filePath) {
  dropStaleParsedApproval(state, threadId, activeLocks);
  if (state.status === 'waiting_approval') return;
  const tail = filePath && stats ? inspectRolloutTail(filePath, stats) : { open: false };
  const next = resolveLiveStatus(state.status, {
    hasLiveChildren: hasLiveChildAgents(threadId),
    tail,
    stats,
  });
  if (next === 'working') {
    state.status = 'working';
    if (!state.activeActionText) state.activeActionText = '正在处理任务...';
    return;
  }
  if (state.status === 'working') {
    state.status = 'idle';
    state.activeActionText = '';
  }
}

const PLAN_TYPE_LABELS = {
  plus: 'Codex Plus',
  pro: 'Codex Pro',
  team: 'Codex Team',
  enterprise: 'Codex Enterprise',
  free: 'Codex'
};

let accountQuotaCache = { value: null, fetchedAt: 0, inflight: null };

function mapPlanType(plan) {
  const key = String(plan || '').toLowerCase();
  return PLAN_TYPE_LABELS[key] || plan || '';
}

function readCodexAuthTokens() {
  try {
    if (!fs.existsSync(AUTH_JSON_PATH)) return null;
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON_PATH, 'utf-8'));
    const tokens = auth && auth.tokens;
    if (!tokens || !tokens.access_token) return null;
    return { accessToken: tokens.access_token, accountId: tokens.account_id || '' };
  } catch (e) {
    return null;
  }
}

async function fetchAccountQuota() {
  const creds = readCodexAuthTokens();
  if (!creds) return null;
  const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'ChatGPT-Account-Id': creds.accountId,
      'User-Agent': 'codex-web-hub'
    }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const win = data && data.rate_limit && data.rate_limit.primary_window;
  const quota = {};
  if (data && data.plan_type) quota.planType = mapPlanType(data.plan_type);
  if (win && win.used_percent != null) quota.primaryUsedPercent = Math.round(win.used_percent);
  if (win && win.reset_at) quota.resetAtMs = win.reset_at * 1000;
  return Object.keys(quota).length ? quota : null;
}

async function getAccountQuota(force = false) {
  const now = Date.now();
  if (!force && accountQuotaCache.value && (now - accountQuotaCache.fetchedAt) < ACCOUNT_QUOTA_TTL_MS) {
    return accountQuotaCache.value;
  }
  if (accountQuotaCache.inflight) return accountQuotaCache.inflight;
  accountQuotaCache.inflight = fetchAccountQuota()
    .then((value) => {
      if (value) {
        accountQuotaCache.value = value;
        accountQuotaCache.fetchedAt = Date.now();
      }
      return accountQuotaCache.value;
    })
    .catch(() => accountQuotaCache.value)
    .finally(() => { accountQuotaCache.inflight = null; });
  return accountQuotaCache.inflight;
}

function mergeAccountQuota(tokenUsage) {
  const usage = tokenUsage && typeof tokenUsage === 'object' ? { ...tokenUsage } : {};
  const quota = accountQuotaCache.value;
  if (!quota) return usage;
  if (usage.primaryUsedPercent == null && quota.primaryUsedPercent != null) {
    usage.primaryUsedPercent = quota.primaryUsedPercent;
  }
  if (!usage.resetAtMs && quota.resetAtMs) usage.resetAtMs = quota.resetAtMs;
  if (!usage.planType && quota.planType) usage.planType = quota.planType;
  return usage;
}

function packHistoryResult(state, delta, limit = HISTORY_LIMIT) {
  const items = state.items.length > limit ? state.items.slice(-limit) : state.items;
  return {
    items,
    totalItems: state.totalItems,
    hasMore: state.totalItems > items.length,
    status: state.status,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    pendingApproval: state.pendingApproval,
    cwd: state.cwd,
    tokenUsage: mergeAccountQuota(state.tokenUsage),
    activeActionText: state.activeActionText,
    rev: state.rev,
    delta: delta || null
  };
}

function fullParseIntoState(filePath, stats, cap = HISTORY_LIMIT * 2) {
  const fresh = createEmptyParseState(cap);
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    fresh.rev++;
    try { processRolloutLine(JSON.parse(t), fresh); } catch (e) {}
  }
  fresh.offset = stats.size;
  fresh.mtimeMs = stats.mtimeMs;
  return fresh;
}

function parseRolloutHistory(filePath, activeLocks, threadId, pageOptions = {}) {
  const emptyResult = {
    items: [], totalItems: 0, hasMore: false, status: 'idle', startedAt: null, completedAt: null,
    pendingApproval: null, cwd: '', tokenUsage: {}, activeActionText: '', rev: 0, delta: null
  };
  if (!filePath || !fs.existsSync(filePath)) return emptyResult;

  try {
    const stats = fs.statSync(filePath);

    // 全量模式（加载更早历史）：独立解析，上限 2000 条，不污染增量缓存
    if (pageOptions.all) {
      const fresh = fullParseIntoState(filePath, stats, FULL_HISTORY_LIMIT);
      const view = snapshotParseState(fresh);
      applyLockOverride(view, activeLocks, threadId, stats, filePath);
      return packHistoryResult(view, null, FULL_HISTORY_LIMIT);
    }

    let state = rolloutParseState.get(threadId);

    if (state && stats.size === state.offset && stats.mtimeMs === state.mtimeMs) {
      const view = snapshotParseState(state);
      applyLockOverride(view, activeLocks, threadId, stats, filePath);
      return packHistoryResult(view, null);
    }

    const incremental = state && stats.size > state.offset;
    const baseRev = incremental ? state.rev : 0;

    // 缓存 miss / 文件被截断或原地重写 → 全量重建该 thread 的解析状态
    if (!incremental) {
      state = fullParseIntoState(filePath, stats);
      rolloutParseState.set(threadId, state);
      const view = snapshotParseState(state);
      applyLockOverride(view, activeLocks, threadId, stats, filePath);
      return packHistoryResult(view, null);
    }

    // 增量路径：只读取 [offset, size) 的新增字节
    const readLen = stats.size - state.offset;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, state.offset);
    fs.closeSync(fd);

    const chunk = state.restBytes + buf.toString('utf-8');
    const lines = chunk.split('\n');
    state.restBytes = lines.pop() || ''; // 最后一段可能是被截断的半行，留待下次拼接

    const newItems = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      state.rev++;
      const prevLen = state.items.length;
      try { processRolloutLine(JSON.parse(t), state); } catch (e) {}
      if (state.items.length > prevLen) {
        newItems.push(state.items[state.items.length - 1]);
      }
    }
    state.offset = stats.size;
    state.mtimeMs = stats.mtimeMs;
    rolloutParseState.set(threadId, state);

    const view = snapshotParseState(state);
    applyLockOverride(view, activeLocks, threadId, stats, filePath);
    return packHistoryResult(
      state,
      newItems.length > 0 ? { baseRev, newItems: newItems.slice(-HISTORY_LIMIT) } : null
    );
  } catch (e) {
    console.error('Error reading rollout file:', e);
    return emptyResult;
  }
}

const FILE_WALK_SKIP = new Set(['.git', 'node_modules', '.codex', 'tmp', '.venv', '__pycache__', 'dist', 'build', '.idea', '.vscode', 'vendor', 'coverage']);

function findFileByName(root, name, maxVisits = 5000) {
  if (!root || !name) return null;
  const target = String(name).toLowerCase();
  const stack = [root];
  let visits = 0;
  while (stack.length && visits < maxVisits) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      visits++;
      if (visits > maxVisits) break;
      if (ent.name.startsWith('.') || FILE_WALK_SKIP.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.toLowerCase() === target) return full;
    }
  }
  return null;
}

function resolveRequestedFile(rawPath, cwd) {
  let filePath = String(rawPath || '').replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
  try { filePath = decodeURIComponent(filePath); } catch (e) {}
  filePath = filePath.trim();
  if (!filePath) return null;

  const tryFile = (p) => {
    try {
      const st = fs.statSync(p);
      if (st && st.isFile()) return p;
    } catch (e) {}
    return null;
  };

  let hit = tryFile(filePath);
  if (hit) return hit;
  if (!cwd) return null;

  if (!path.isAbsolute(filePath)) {
    hit = tryFile(path.join(cwd, filePath));
    if (hit) return hit;
  }
  const base = path.basename(filePath);
  return base ? findFileByName(cwd, base) : null;
}

async function buildWorkspaceDirectoryTreeAsync(targetDir, depth = 0, maxDepth = 2, state = { count: 0 }) {
  if (!targetDir || depth > maxDepth || state.count > 300) return [];
  if (!fs.existsSync(targetDir)) return [];

  const ignoreList = new Set(['.git', 'node_modules', '.codex', 'tmp', '.venv', '__pycache__', 'dist', 'build', '.idea', '.vscode', 'vendor', 'coverage']);
  const items = [];

  try {
    // withFileTypes 直接返回类型，免去对每个条目单独 stat
    const dirents = await fs.promises.readdir(targetDir, { withFileTypes: true });
    for (const d of dirents) {
      if (state.count > 300) break;
      if (ignoreList.has(d.name) || d.name.startsWith('.')) continue;

      const fullPath = path.join(targetDir, d.name);
      try {
        if (d.isDirectory()) {
          state.count++;
          items.push({
            name: d.name,
            type: 'directory',
            path: fullPath,
            children: depth < maxDepth ? await buildWorkspaceDirectoryTreeAsync(fullPath, depth + 1, maxDepth, state) : []
          });
        } else if (d.isFile()) {
          state.count++;
          items.push({
            name: d.name,
            type: 'file',
            path: fullPath,
            ext: path.extname(d.name).toLowerCase()
          });
        }
      } catch (e) {}
    }
  } catch (e) {}

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return items;
}

// 未指定目录时，默认使用最近活跃会话的工作目录（避免回退到 process.cwd() 这种无意义路径）
function pickDefaultCwd() {
  let best = null;
  for (const [, info] of rolloutCache) {
    if (!info || !info.cwd) continue;
    if (!best || (info.mtimeMs || 0) > best.mtimeMs) best = info;
  }
  return best ? best.cwd : os.homedir();
}

function ensureProjectCwd(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return pickDefaultCwd();
  const resolved = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(path.dirname(pickDefaultCwd()), trimmed);
  const { root } = path.parse(resolved);
  if (!root || resolved === root) {
    throw new Error('请填写具体项目目录，例如 D:\\projects\\my-app');
  }
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  } else if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('该路径已存在，但不是文件夹');
  }
  return resolved;
}

function placeholderTitle(cwd) {
  const resolved = path.normalize(String(cwd || '').trim());
  if (!resolved || resolved === '.' || resolved === path.sep) return '/';
  const parsed = path.parse(resolved);
  if (!parsed.base || resolved === parsed.root) return '/';
  return `${parsed.base}/新聊天`;
}

function resolveCreateTitle(cwd, title) {
  const raw = String(title || '').trim();
  if (!raw || raw === '新聊天' || raw === '/') return placeholderTitle(cwd);
  return raw;
}

function createNewSession(targetCwd, title = '新聊天') {
  const threadId = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const resolvedCwd = targetCwd || pickDefaultCwd();

  const relDir = path.join('sessions', `${now.getFullYear()}`, String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  const fullDir = path.join(CODEX_HOME, relDir);
  fs.mkdirSync(fullDir, { recursive: true });

  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
  const filename = `rollout-${dateStr}-${threadId}.jsonl`;
  const rolloutPath = path.join(fullDir, filename);

  const meta = {
    timestamp: nowIso,
    type: 'session_meta',
    payload: {
      id: threadId,
      title: title,
      cwd: resolvedCwd,
      created_at: nowIso
    }
  };

  fs.writeFileSync(rolloutPath, JSON.stringify(meta) + '\n', 'utf-8');

  const idxPath = path.join(CODEX_HOME, 'session_index.jsonl');
  const idxItem = {
    id: threadId,
    thread_name: title,
    updated_at: nowIso
  };
  // session_index.jsonl 可能被 Codex app 独占占用；写入失败不影响创建（rollout 文件为权威源）
  try {
    fs.appendFileSync(idxPath, JSON.stringify(idxItem) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[createNewSession] session_index append failed (non-fatal):', e.message);
  }

  rolloutCache.set(threadId, {
    path: rolloutPath,
    mtimeMs: Date.now(),
    size: 100,
    cwd: resolvedCwd,
    projectName: path.basename(path.normalize(resolvedCwd))
  });

  return { threadId, rolloutPath };
}

function renameThread(threadId, title) {
  const name = cleanTitle(title, 80);
  if (!threadId || !name) throw new Error('标题无效');
  const upd = new Date().toISOString();
  titleOverrideMap.set(threadId, { name, upd });
  const idxPath = path.join(CODEX_HOME, 'session_index.jsonl');
  try {
    fs.appendFileSync(idxPath, JSON.stringify({ id: threadId, thread_name: name, updated_at: upd }) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[renameThread] session_index append failed (using memory override):', e.message);
  }
  return name;
}

// ----------------------------------------------------
// HTTP Static File & REST API Server (gzip + in-memory static cache)
// ----------------------------------------------------

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// 静态资源启动时一次性读入内存，请求期零磁盘 IO
const staticCache = new Map();
function preloadStaticAssets(dir = PUBLIC_DIR) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) preloadStaticAssets(full);
        else if (entry.isFile()) staticCache.set(path.resolve(full), fs.readFileSync(full));
      } catch (e) {}
    }
    if (dir === PUBLIC_DIR) {
      console.log(`[Static Cache] Preloaded ${staticCache.size} files from public/`);
    }
  } catch (e) {}
}
preloadStaticAssets();

function sendBuffer(req, res, statusCode, contentType, data, extraHeaders = {}) {
  const headers = { ...extraHeaders, 'Content-Type': contentType };
  // 大于 1KB 的响应启用 gzip（history JSON 与文本文件收益最大）
  const accept = req.headers['accept-encoding'] || '';
  let body = data;
  if (accept.includes('gzip') && Buffer.isBuffer(data) && data.length > 1024) {
    try {
      body = zlib.gzipSync(data);
      headers['Content-Encoding'] = 'gzip';
    } catch (e) {}
  }
  headers['Content-Length'] = body.length;
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendJson(req, res, statusCode, obj, extraHeaders = {}) {
  sendBuffer(
    req,
    res,
    statusCode,
    'application/json; charset=utf-8',
    Buffer.from(JSON.stringify(obj)),
    { ...corsHeaders(req), ...extraHeaders },
  );
}

function searchThreadHistory(rolloutPath, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle || !rolloutPath || !fs.existsSync(rolloutPath)) return [];
  const results = [];
  const content = fs.readFileSync(rolloutPath, 'utf-8');
  let idx = -1;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try { entry = JSON.parse(t); } catch { continue; }
    const payload = entry.payload || {};
    if (entry.type !== 'response_item' && entry.type !== 'event_msg') continue;
    idx += 1;
    let text = '';
    if (payload.type === 'user_message' || payload.type === 'agent_message') {
      text = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload.message || '');
    } else if (payload.type === 'reasoning' || payload.type === 'agent_reasoning') {
      const s = payload.summary;
      text = typeof s === 'string' ? s : (Array.isArray(s) ? s.map((x) => x.text || '').join(' ') : '');
    } else if (payload.type === 'custom_tool_call' || payload.type === 'tool_call' || payload.type === 'function_call') {
      text = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input || payload.arguments || {});
    } else if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
      text = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output || {});
    }
    if (!text) continue;
    const pos = text.toLowerCase().indexOf(needle);
    if (pos < 0) continue;
    const start = Math.max(0, pos - 40);
    results.push({
      index: idx,
      type: payload.type,
      snippet: (start > 0 ? '…' : '') + text.slice(start, pos + needle.length + 80).replace(/\s+/g, ' ') + '…'
    });
    if (results.length >= 50) break;
  }
  return results;
}

function isLoopbackIp(ip) {
  const raw = String(ip || '').trim().toLowerCase();
  const host = raw.replace(/^::ffff:/, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || /^127\./.test(host);
}

function isLoopbackReq(req) {
  return isLoopbackIp(req.socket?.remoteAddress || '');
}

function relayPublicState() {
  const relayState = relay.getState();
  return {
    configured: relayState.configured,
    online: relayState.online,
    url: relay.publicUrl() || (relayState.configured ? relayState.url : null),
  };
}

function listLanUrls(port) {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets || {})) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

function primaryLanUrl() {
  const urls = listLanUrls(PORT);
  return urls.find((u) => u.includes('192.168.')) || urls[0] || '';
}

function handleHostApi(req, res, reqUrl) {
  if (!isLoopbackReq(req)) {
    return sendJson(req, res, 403, { success: false, error: '仅本机可打开主机台' });
  }
  if (reqUrl.pathname === '/api/host/status' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      success: true,
      hubId: identity.hubId,
      port: PORT,
      relay: relayPublicState(),
      lanCount: [...lanClients.values()].filter((ws) => !isLoopbackIp(ws.clientIp)).length,
      password: auth.hostPassword || '',
      lanCode: localLanCode,
      lanUrls: listLanUrls(PORT),
    });
  }
  if (reqUrl.pathname === '/api/host/pair-code' && req.method === 'GET') {
    (async () => {
      try {
        const pair = await relay.requestPairCode();
        sendJson(req, res, 200, {
          success: true,
          code: pair.code,
          expiresAtMs: pair.expiresAtMs,
          relayOnline: pair.relayOnline,
          relay: relayPublicState(),
          pairUrl: pairLandingUrl(relay.publicUrl() || process.env.CODESK_RELAY_URL || process.env.ONEDESK_RELAY_URL || '', pair.code, identity.e2ePub, primaryLanUrl()),
          hubE2ePub: identity.e2ePub,
        });
      } catch (err) {
        sendJson(req, res, 502, { success: false, error: err.message || '无法申请配对码' });
      }
    })();
    return;
  }
  if (reqUrl.pathname === '/api/host/clients' && req.method === 'GET') {
    (async () => {
      const lan = [...lanClients.values()]
        .filter((ws) => !isLoopbackIp(ws.clientIp))
        .map((ws) => ({
          id: ws.clientId,
          kind: 'lan',
          ip: ws.clientIp || '',
          connectedAt: ws.connectedAt || null,
          online: ws.readyState === 1,
        }));
      let devices = [];
      try {
        const listed = await relay.listDevices();
        devices = (listed.devices || [])
          .filter((d) => !d.revokedAt)
          .map((d) => ({
            id: d.id,
            kind: 'relay',
            online: Boolean(d.online),
            createdAt: d.createdAt || null,
            lastSeenAt: d.lastSeenAt || null,
          }));
      } catch {
        devices = [];
      }
      const remoteCount = lan.filter((c) => c.online && !isLoopbackAddress(c.ip)).length
        + devices.filter((d) => d.online).length;
      sendJson(req, res, 200, { success: true, lan, devices, remoteCount });
    })();
    return;
  }
  if (reqUrl.pathname === '/api/host/kick' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const kind = String(parsed.kind || '').trim();
        const id = String(parsed.id || parsed.deviceId || '').trim();
        if (!id) return sendJson(req, res, 400, { success: false, error: '缺少 id' });
        if (kind === 'lan') {
          const ws = lanClients.get(id);
          if (!ws) return sendJson(req, res, 404, { success: false, error: '局域网客户端不在线' });
          try { ws.close(4001, 'kicked'); } catch { /* ignore */ }
          lanClients.delete(id);
          return sendJson(req, res, 200, { success: true });
        }
        await relay.kickDevice(id);
        return sendJson(req, res, 200, { success: true });
      } catch (err) {
        return sendJson(req, res, 400, { success: false, error: err.message || '踢出失败' });
      }
    });
    return;
  }
  if (reqUrl.pathname === '/api/host/shutdown' && req.method === 'POST') {
    sendJson(req, res, 200, { success: true });
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (reqUrl.pathname === '/api/host/lan-code' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const wanted = String(parsed.code || parsed.lanCode || '').trim();
        if (wanted) {
          const next = normalizeLanCode(wanted);
          if (!next) return sendJson(req, res, 400, { success: false, error: '家里码须为 4 位字母或数字' });
          localLanCode = persistLanCode(next);
          return sendJson(req, res, 200, { success: true, lanCode: localLanCode });
        }
        localLanCode = persistLanCode(randomLanCode());
        return sendJson(req, res, 200, { success: true, lanCode: localLanCode });
      } catch (err) {
        return sendJson(req, res, 400, { success: false, error: err.message || '家里码没改成' });
      }
    });
    return;
  }
  return sendJson(req, res, 404, { success: false, error: 'unknown host api' });
}

// ----------------------------------------------------
// Web Push (VAPID)：任务完成 / 需要审批时向已订阅设备推系统通知
// 密钥对首次运行自动生成并持久化到 server/.vapid.json
// ----------------------------------------------------
const VAPID_FILE = path.join(__dirname, '.vapid.json');
const PUSH_SUBS_FILE = path.join(__dirname, '.push-subscriptions.json');

let vapidKeys = null;
try {
  if (fs.existsSync(VAPID_FILE)) vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8'));
} catch (e) {}

if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
  vapidKeys = webpush.generateVAPIDKeys();
  vapidKeys.subject = 'mailto:codex-remote@local';
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2)); } catch (e) {}
}
webpush.setVapidDetails(vapidKeys.subject, vapidKeys.publicKey, vapidKeys.privateKey);

let pushSubscriptions = [];
try {
  if (fs.existsSync(PUSH_SUBS_FILE)) pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf-8'));
} catch (e) {}

function savePushSubscriptions() {
  try { fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2)); } catch (e) {}
}

// fire-and-forget 推送；404/410 视为订阅失效自动清理
const JPUSH_FILE = path.join(__dirname, '.jpush-devices.json');
let jpushDevices = [];
try {
  if (fs.existsSync(JPUSH_FILE)) jpushDevices = JSON.parse(fs.readFileSync(JPUSH_FILE, 'utf-8'));
  if (!Array.isArray(jpushDevices)) jpushDevices = [];
} catch {
  jpushDevices = [];
}

function saveJpushDevices() {
  try { fs.writeFileSync(JPUSH_FILE, JSON.stringify(jpushDevices, null, 2)); } catch (e) {}
}

function flushJpushToRelay() {
  for (const d of jpushDevices) {
    if (d && d.registrationId) {
      try { relay.sendPushRegister(d.registrationId); } catch (e) {}
    }
  }
}

function rememberJpushDevice(registrationId) {
  const id = String(registrationId || '').trim();
  if (!id) return;
  jpushDevices = [{ registrationId: id, updatedAt: new Date().toISOString() }]
    .concat(jpushDevices.filter((d) => d && d.registrationId !== id))
    .slice(0, 20);
  saveJpushDevices();
  try { relay.sendPushRegister(id); } catch (e) {}
}

function pushToJPush(payload) {
  try { relay.sendPush(payload); } catch (e) {}
}

function pushToAllDevices(payload) {
  pushToJPush(payload);
  if (!pushSubscriptions.length) return;
  const deadline = Promise.resolve();
  for (const sub of pushSubscriptions) {
    deadline.then(() => webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
        savePushSubscriptions();
      }
    }));
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (reqUrl.pathname === '/api/discover' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      ok: true,
      hub: true,
      port: PORT,
      hubId: identity.hubId,
    });
  }

  if (reqUrl.pathname === '/api/auth/status' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      success: true,
      loggedIn: auth.authorize(req),
      configured: auth.configured,
      hubId: identity.hubId,
      relay: relayPublicState(),
    });
  }

  if (reqUrl.pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const pairCode = relay.getPairCode?.()?.code || '';
        const result = auth.login(parsed.password || parsed.token || parsed.code, req, [pairCode, localLanCode]);
        if (!result.ok) {
          return sendJson(req, res, 401, { success: false, error: '口令错误。请输入电脑主机台上那个码。' });
        }
        return sendJson(req, res, 200, { success: true, hubId: identity.hubId, token: result.token }, result.headers);
      } catch (e) {
        return sendJson(req, res, 400, { success: false, error: 'Bad JSON' });
      }
    });
    return;
  }

  if (reqUrl.pathname === '/api/auth/logout' && req.method === 'POST') {
    return sendJson(req, res, 200, { success: true }, auth.logout(req));
  }

  if (reqUrl.pathname === '/host' || reqUrl.pathname === '/host.html') {
    if (!isLoopbackReq(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('本机主机台只能在这台电脑上打开');
    }
    reqUrl.pathname = '/host.html';
  }

  if (reqUrl.pathname.startsWith('/api/host/')) {
    return handleHostApi(req, res, reqUrl);
  }

  if (reqUrl.pathname.startsWith('/api/') && !isPublicApi(reqUrl.pathname, req.method) && !auth.authorize(req)) {
    return sendJson(req, res, 401, { success: false, error: '未登录' });
  }

  if (reqUrl.pathname === '/api/auth/pair-code' && req.method === 'GET') {
    (async () => {
      const pair = await relay.requestPairCode();
      sendJson(req, res, 200, {
        success: true,
        code: pair.code,
        expiresAtMs: pair.expiresAtMs,
        relayOnline: pair.relayOnline,
        relay: relayPublicState(),
        pairUrl: pairLandingUrl(relay.publicUrl() || process.env.CODESK_RELAY_URL || process.env.ONEDESK_RELAY_URL || '', pair.code, identity.e2ePub, primaryLanUrl()),
        hubE2ePub: identity.e2ePub,
      });
    })();
    return;
  }

  if (reqUrl.pathname === '/api/thread-goal' && req.method === 'GET') {
    const threadId = String(reqUrl.searchParams.get('threadId') || '').trim();
    if (!threadId) return sendJson(req, res, 400, { success: false, error: '缺少会话' });
    return sendJson(req, res, 200, { success: true, threadId, goal: goals.getThreadGoal(threadId) });
  }

  if (reqUrl.pathname === '/api/thread-goal' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const threadId = String(parsed.threadId || '').trim();
        if (!threadId) return sendJson(req, res, 400, { success: false, error: '缺少会话' });
        const goal = goals.setThreadGoal(threadId, parsed.objective);
        broadcastToClients({ type: 'goal_data', threadId, goal });
        sendJson(req, res, 200, { success: true, threadId, goal });
      } catch (e) {
        sendJson(req, res, 400, { success: false, error: e.message });
      }
    });
    return;
  }

  if (reqUrl.pathname === '/api/threads/rename' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const title = renameThread(parsed.threadId, parsed.title);
        const threadData = getThreadList();
        broadcastToClients({ type: 'thread_list', data: threadData });
        sendJson(req, res, 200, { success: true, threadId: parsed.threadId, title });
      } catch (e) {
        sendJson(req, res, 400, { success: false, error: e.message });
      }
    });
    return;
  }

  // 新建会话（HTTP 兜底：WS 未就绪/重连中时前端走此接口）
  if (reqUrl.pathname === '/api/threads' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      (async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const created = await createThreadSmart(parsed.targetCwd || '', parsed.title || '新聊天');
          const threadData = getThreadList();
          broadcastToClients({ type: 'thread_list', data: threadData });
          sendJson(req, res, 200, {
            success: true,
            threadId: created.threadId,
            title: created.title || parsed.title || '新聊天'
          });
        } catch (e) {
          console.error('[HTTP] create thread failed:', e);
          sendJson(req, res, 500, { success: false, error: e.message });
        }
      })();
    });
    return;
  }

  if (reqUrl.pathname === '/api/threads') {
    (async () => {
      const threadData = getThreadList();
      const configData = readCodexConfig();
      const quota = await getAccountQuota();
      sendJson(req, res, 200, { success: true, data: threadData, config: configData, quota });
    })();
    return;
  }

  if (reqUrl.pathname === '/api/thread-history') {
    const threadId = reqUrl.searchParams.get('threadId');
    const all = reqUrl.searchParams.get('all') === 'true';
    if (!threadId) {
      return sendJson(req, res, 400, { success: false, error: 'Missing threadId parameter' });
    }

    const rolloutPath = findRolloutFilePathFast(threadId);
    const activeLocks = getActiveLockThreadIds();
    const history = parseRolloutHistory(rolloutPath, activeLocks, threadId, { all });

    const baseRevRaw = reqUrl.searchParams.get('baseRev');
    const baseRev = baseRevRaw === null ? NaN : parseInt(baseRevRaw, 10);
    const prevHttp = lastHttpHistoryMeta.get(threadId);
    lastHttpHistoryMeta.set(threadId, { rev: history.rev, status: history.status });
    if (
      !all
      && Number.isFinite(baseRev)
      && history.rev === baseRev
      && prevHttp
      && prevHttp.status === history.status
      && (!history.delta || history.delta.newItems.length === 0)
    ) {
      return sendJson(req, res, 200, { success: true, threadId, unchanged: true });
    }

    return sendJson(req, res, 200, { success: true, threadId, data: history });
  }

  if (reqUrl.pathname === '/api/workspace-tree') {
    const targetCwd = reqUrl.searchParams.get('cwd');
    if (!targetCwd || !fs.existsSync(targetCwd)) {
      return sendJson(req, res, 400, { success: false, error: 'Directory does not exist' });
    }

    (async () => {
      try {
        const tree = await buildWorkspaceDirectoryTreeAsync(targetCwd);
        const rootName = path.basename(path.normalize(targetCwd));
        sendJson(req, res, 200, {
          success: true,
          rootName,
          rootPath: targetCwd,
          tree
        });
      } catch (err) {
        sendJson(req, res, 500, { success: false, error: err.message });
      }
    })();
    return;
  }

  if (reqUrl.pathname === '/api/models' && req.method === 'GET') {
    (async () => {
      try {
        const client = getCodex();
        const models = (await client.listModels())
          .filter((model) => model && !model.hidden)
          .map((model) => ({
            id: model.model || model.id,
            displayName: model.displayName || model.model || model.id,
            description: model.description || '',
            defaultReasoningEffort: normalizeEffortId(model.defaultReasoningEffort),
            supportedReasoningEfforts: (model.supportedReasoningEfforts || []).map((item) => ({
              id: normalizeEffortId(item.reasoningEffort || item),
              description: item.description || ''
            })).filter((item) => item.id)
          }));
        sendJson(req, res, 200, { success: true, models });
      } catch (err) {
        sendJson(req, res, 500, { success: false, error: err.message, models: [] });
      }
    })();
    return;
  }

  if (reqUrl.pathname === '/api/skills' && req.method === 'GET') {
    (async () => {
      try {
        const cwd = reqUrl.searchParams.get('cwd') || '';
        const client = getCodex();
        const result = await client.listSkills(cwd);
        const groups = Array.isArray(result?.data) ? result.data : [];
        const skills = groups.flatMap((group) => Array.isArray(group.skills) ? group.skills : []);
        sendJson(req, res, 200, { success: true, skills });
      } catch (err) {
        sendJson(req, res, 500, { success: false, error: err.message, skills: [] });
      }
    })();
    return;
  }

  if (reqUrl.pathname === '/api/skills/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      (async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const client = getCodex();
          await client.writeSkillConfig({
            path: parsed.path || null,
            name: parsed.name || null,
            enabled: !!parsed.enabled
          });
          sendJson(req, res, 200, { success: true });
        } catch (err) {
          sendJson(req, res, 500, { success: false, error: err.message });
        }
      })();
    });
    return;
  }

  if (reqUrl.pathname === '/api/mcp-servers' && req.method === 'GET') {
    (async () => {
      try {
        const client = getCodex();
        const result = await client.listMcpServers();
        const servers = Array.isArray(result?.data) ? result.data : [];
        sendJson(req, res, 200, {
          success: true,
          servers: servers.map((server) => ({
            name: server.name,
            authStatus: server.authStatus || null,
            toolCount: server.tools ? Object.keys(server.tools).length : 0
          }))
        });
      } catch (err) {
        sendJson(req, res, 500, { success: false, error: err.message, servers: [] });
      }
    })();
    return;
  }

  if (reqUrl.pathname === '/api/mcp-servers/reload' && req.method === 'POST') {
    (async () => {
      try {
        const client = getCodex();
        await client.reloadMcpServers();
        sendJson(req, res, 200, { success: true });
      } catch (err) {
        sendJson(req, res, 500, { success: false, error: err.message });
      }
    })();
    return;
  }

  if (reqUrl.pathname === '/api/upload' && req.method === 'POST') {
    const rawName = reqUrl.searchParams.get('name') || req.headers['x-filename'] || 'file';
    const safeName = path.basename(String(rawName).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')) || 'file';
    const ext = path.extname(safeName).slice(0, 16);
    const chunks = [];
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (received > MAX_UPLOAD_BYTES) {
        return sendJson(req, res, 413, { success: false, error: '文件超过 20MB' });
      }
      try {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const storedName = `${crypto.randomUUID()}${ext}`;
        const targetPath = path.join(UPLOAD_DIR, storedName);
        fs.writeFileSync(targetPath, Buffer.concat(chunks));
        sendJson(req, res, 200, {
          success: true,
          path: targetPath,
          name: safeName,
          size: received
        });
      } catch (err) {
        sendJson(req, res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  if (reqUrl.pathname === '/api/file') {
    const rawPath = reqUrl.searchParams.get('path');
    if (!rawPath) {
      return sendJson(req, res, 400, { success: false, error: 'Missing path parameter' });
    }

    const filePath = resolveRequestedFile(rawPath, reqUrl.searchParams.get('cwd') || '');
    if (!filePath) {
      return sendJson(req, res, 404, { success: false, error: `File not found on host disk: ${rawPath}` });
    }

    const ext = path.extname(filePath).toLowerCase();
    const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp'].includes(ext);

    if (isImg) {
      fs.readFile(filePath, (readErr, buffer) => {
        if (readErr) {
          return sendJson(req, res, 500, { success: false, error: `Error reading file: ${readErr.message}` });
        }
        sendJson(req, res, 200, {
          success: true,
          path: filePath,
          fileName: path.basename(filePath),
          ext,
          encoding: 'base64',
          content: buffer.toString('base64')
        });
      });
      return;
    }

    fs.readFile(filePath, 'utf-8', (readErr, content) => {
      if (readErr) {
        return sendJson(req, res, 500, { success: false, error: `Error reading file: ${readErr.message}` });
      }
      sendJson(req, res, 200, {
        success: true,
        path: filePath,
        fileName: path.basename(filePath),
        ext,
        encoding: 'utf8',
        content
      });
    });
    return;
  }

  // ---- Web Push 订阅管理 ----
  if (reqUrl.pathname === '/api/push/public-key') {
    return sendJson(req, res, 200, { success: true, publicKey: vapidKeys.publicKey });
  }

  if (reqUrl.pathname === '/api/push/subscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const sub = JSON.parse(body);
        if (sub && sub.endpoint) {
          if (!pushSubscriptions.some(s => s.endpoint === sub.endpoint)) {
            pushSubscriptions.push(sub);
            savePushSubscriptions();
          }
          return sendJson(req, res, 200, { success: true });
        }
        sendJson(req, res, 400, { success: false, error: 'Invalid subscription' });
      } catch (e) {
        sendJson(req, res, 400, { success: false, error: 'Bad JSON' });
      }
    });
    return;
  }

  // ---- 会话内全文搜索：跨完整历史（不受 250 条窗口限制）----
  if (reqUrl.pathname === '/api/search') {
    const threadId = reqUrl.searchParams.get('threadId');
    const q = (reqUrl.searchParams.get('q') || '').trim();
    if (!threadId || !q) {
      return sendJson(req, res, 400, { success: false, error: 'Missing threadId or q' });
    }

    const rolloutPath = findRolloutFilePathFast(threadId);
    if (!rolloutPath || !fs.existsSync(rolloutPath)) {
      return sendJson(req, res, 404, { success: false, error: 'Thread not found' });
    }

    try {
      return sendJson(req, res, 200, { success: true, results: searchThreadHistory(rolloutPath, q) });
    } catch (e) {
      return sendJson(req, res, 500, { success: false, error: e.message });
    }
  }

  // ---- 静态资源 ----
  let pathname = reqUrl.pathname;
  try { pathname = decodeURIComponent(pathname); } catch (e) {}
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // 防目录穿越：解析后的路径必须仍在 public 目录内
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  const ext = path.extname(resolved).toLowerCase();
  let body = null;
  // 静态前端文件总是从磁盘读取最新内容，确保修改 CSS/JS 后刷新页面实时生效（零缓存延迟）
  if (['.html', '.css', '.js', '.json', '.svg', '.png', '.ico', '.jpg', '.webp'].includes(ext)) {
    try {
      body = fs.readFileSync(resolved);
      staticCache.set(resolved, body);
    } catch (e) {
      body = staticCache.get(resolved) || null;
    }
  } else {
    body = staticCache.get(resolved);
  }
  if (!body) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  sendBuffer(req, res, 200, mimeTypes[ext] || 'application/octet-stream', body, {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
});

// ----------------------------------------------------
// WebSocket Server for Live Stream & Remote Actions
// ----------------------------------------------------

let wss = null;
const fileWatchers = new Map();

function initWebSocketServer() {
  if (wss) return;
  wss = new WebSocketServer({
    server,
    verifyClient: (info) => auth.authorize(info.req),
  });

  wss.on('connection', (ws, req) => {
    const clientId = crypto.randomUUID();
    ws.clientId = clientId;
    ws.clientIp = req?.socket?.remoteAddress || '';
    ws.connectedAt = Date.now();
    lanClients.set(clientId, ws);
    console.log('[WS] Client connected');

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        handleClientMessage(ws, msg);
      } catch (e) {
        console.error('[WS] Bad message:', e);
      }
    });

    ws.on('close', () => {
      lanClients.delete(clientId);
      console.log('[WS] Client disconnected');
    });
  });
}

// WebSocket 应用层心跳：Cloudflare Tunnel 代理会关闭约 100 秒无流量的连接，
// 空闲期（无活跃会话推送）定期发 ping 保活，避免手机端反复"断开→重连"
setInterval(() => {
  if (!wss || wss.clients.size === 0) return;
  broadcastToClients({ type: 'ping', t: Date.now() });
}, 25000);

// ----------------------------------------------------
// 真实控制通道：第二个 codex app-server 客户端（与桌面共享 CODEX_HOME）
// 单写者锁语义：桌面正在运行的会话（writer-lock 被桌面持有）只读不写
// ----------------------------------------------------
let codex = null;
const appServerRefreshTimers = new Map(); // threadId -> debounce timer

function getCodex() {
  if (codex) return codex;
  codex = new CodexAppServer();
  codex.on('thread-activity', ({ threadId, method }) => {
    // rollout jsonl 是展示权威源；app-server 通知只是更快的刷新信号（300ms 去抖）
    const force = method === 'turn/completed' || method === 'error';
    scheduleAppServerRefresh(threadId, force);
  });
  codex.on('approval', (a) => {
    if (a.threadId) {
      approvalClosedAt.delete(a.threadId);
    }
    const at = a.at || Date.now();
    broadcastToClients({
      type: 'approval_request',
      threadId: a.threadId,
      requestId: a.requestId,
      ids: a.ids || [],
      kind: a.method,
      command: a.payload?.command || a.payload?.patch || '',
      reason: a.payload?.reason || '',
      at,
      expiresAt: at + APPROVAL_TTL_MS
    });
  });
  codex.on('approval-closed', (a) => {
    closeParsedApproval(a.threadId, a.requestId, a.reason || 'closed', a.ids || []);
  });
  return codex;
}

function scheduleAppServerRefresh(threadId, force = false) {
  if (!threadId) return;
  const existing = appServerRefreshTimers.get(threadId);
  if (existing) clearTimeout(existing);
  appServerRefreshTimers.set(
    threadId,
    setTimeout(() => {
      appServerRefreshTimers.delete(threadId);
      pushThreadUpdate(threadId, force);
    }, 300)
  );
}

// 建会话：首选真实 app-server（有 writer，桌面/网页双向可见），失败降级手写 rollout
async function createThreadSmart(targetCwd, title = '新聊天', opts = {}) {
  const resolvedCwd = targetCwd ? ensureProjectCwd(targetCwd) : pickDefaultCwd();
  const nextTitle = resolveCreateTitle(resolvedCwd, title);
  try {
    const client = getCodex();
    await client.ensureStarted();
    const r = await client.startThread({
      cwd: resolvedCwd,
      approvalPolicy: opts.approvalPolicy ?? readCodexConfig().approvalPolicy ?? null
    });
    const threadId = r?.thread?.id;
    if (threadId) {
      console.log(`[Remote Action] Created real thread ${threadId} under cwd ${resolvedCwd}`);
      try { renameThread(threadId, nextTitle); } catch (e) {}
      return { threadId, real: true, title: nextTitle };
    }
    console.warn('[create_thread] app-server 未返回 thread.id:', JSON.stringify(r).slice(0, 200));
  } catch (e) {
    console.warn('[create_thread] app-server 路径失败，降级手写 rollout:', e.message);
  }
  const fallback = createNewSession(resolvedCwd, nextTitle);
  return { threadId: fallback.threadId, real: false, title: nextTitle };
}

async function handleRemoteSend(ws, threadId, text, isSteer, rawInput) {
  const action = isSteer ? 'Steer' : 'Send';
  const input = normalizeInput(rawInput, text);
  if (!input.length) {
    ws.send(JSON.stringify({ type: 'action_feedback', status: 'error', message: `${action} 失败: 内容为空` }));
    return;
  }
  console.log(`[Remote Action] ${isSteer ? 'steer' : 'send'} to thread ${threadId}: ${String(text || '').slice(0, 80)}`);
  try {
    const ipc = getIpcClient();
    let ownerId = null;
    try {
      ownerId = await ipc.findOwner(threadId);
    } catch (error) {
      console.warn(`[ipc] findOwner failed: ${error.message}`);
    }
    console.log(`[Remote Action] owner=${ownerId || 'none'} thread=${threadId}`);
    if (ownerId) {
      if (isSteer) await ipc.steerTurn(threadId, input, ownerId);
      else await ipc.startTurn(threadId, input, ownerId);
      ws.send(JSON.stringify({
        type: 'action_feedback',
        status: 'success',
        message: `${action} 已交给持锁端（follower）`
      }));
      return;
    }

    if (getActiveLockThreadIds().has(threadId)) {
      throw new Error('桌面/VSCode 正在占用该会话，但管道未找到 owner；请确认桌面已打开该会话后重试');
    }

    const client = getCodex();
    await client.ensureStarted();
    if (!client.ownedThreads.has(threadId)) {
      await client.resumeThread(threadId);
    }
    if (isSteer) {
      await client.steerTurn({
        threadId,
        text,
        input,
        expectedTurnId: client.currentTurnByThread.get(threadId) || null,
      });
    } else {
      await client.sendUserTurn({ threadId, text, input });
    }
    ws.send(JSON.stringify({
      type: 'action_feedback',
      status: 'success',
      message: `${action} 已提交，回复将实时推送到本页`
    }));
  } catch (e) {
    const message = isWriterLockError(e)
      ? '该会话正由 Codex 桌面占用（写入锁冲突），请稍后再试'
      : `${action} 失败: ${e.message}`;
    ws.send(JSON.stringify({ type: 'action_feedback', status: 'error', message }));
  }
}

function localHostName() {
  try {
    return String(os.hostname() || '').trim();
  } catch {
    return '';
  }
}

const FILE_PREVIEW_LIMIT = 800 * 1024;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function packFileForClient(filePath) {
  const stat = fs.statSync(filePath);
  const take = Math.min(stat.size, FILE_PREVIEW_LIMIT);
  const buf = Buffer.alloc(take);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, take, 0);
  fs.closeSync(fd);
  const ext = path.extname(filePath).toLowerCase();
  const truncated = stat.size > FILE_PREVIEW_LIMIT;
  if (IMAGE_EXTS.has(ext) || buf.includes(0)) {
    return { encoding: 'base64', content: buf.toString('base64'), truncated };
  }
  return { encoding: 'utf8', content: buf.toString('utf8'), truncated };
}

async function listModelsForClient() {
  const client = getCodex();
  return (await client.listModels())
    .filter((model) => model && !model.hidden)
    .map((model) => ({
      id: model.model || model.id,
      displayName: model.displayName || model.model || model.id,
      description: model.description || '',
      defaultReasoningEffort: normalizeEffortId(model.defaultReasoningEffort),
      supportedReasoningEfforts: (model.supportedReasoningEfforts || []).map((item) => ({
        id: normalizeEffortId(item.reasoningEffort || item),
        description: item.description || ''
      })).filter((item) => item.id)
    }));
}

async function handleClientMessage(ws, msg) {
  const { type, threadId, text, input, requestId, decision, targetCwd, title, key, value, approvalPolicy } = msg;

  if (type === 'get_threads') {
    const threadData = getThreadList();
    const configData = readCodexConfig();
    ws.send(JSON.stringify({
      type: 'thread_list',
      data: threadData,
      config: configData,
      quota: accountQuotaCache.value || {},
      hostName: localHostName()
    }));
    getAccountQuota().catch(() => {});
  }

  else if (type === 'get_config') {
    const configData = readCodexConfig();
    ws.send(JSON.stringify({ type: 'config_data', data: configData, hostName: localHostName() }));
  }

  else if (type === 'update_config') {
    if (key && value) {
      updateCodexConfig(key, value);
      const configData = readCodexConfig();
      broadcastToClients({ type: 'config_data', data: configData });
    }
  }

  else if (type === 'get_goal') {
    if (!threadId) return;
    ws.send(JSON.stringify({ type: 'goal_data', threadId, goal: goals.getThreadGoal(threadId) }));
  }

  else if (type === 'set_goal') {
    try {
      if (!threadId) throw new Error('缺少会话');
      const goal = goals.setThreadGoal(threadId, msg.objective);
      broadcastToClients({ type: 'goal_data', threadId, goal });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'action_feedback', status: 'error', message: e.message || '无法保存目标' }));
    }
  }

  else if (type === 'create_thread') {
    try {
      const created = await createThreadSmart(targetCwd, title || '新聊天', { approvalPolicy });

      const threadData = getThreadList();
      broadcastToClients({ type: 'thread_list', data: threadData });

      ws.send(JSON.stringify({
        type: 'thread_created',
        threadId: created.threadId,
        title: created.title || title || '新聊天'
      }));
    } catch (e) {
      console.error('[WS] create_thread failed:', e);
      ws.send(JSON.stringify({
        type: 'action_feedback',
        status: 'error',
        message: `新建会话失败: ${e.message}`
      }));
    }
  }

  else if (type === 'rename_thread') {
    try {
      const nextTitle = renameThread(threadId, title);
      const threadData = getThreadList();
      broadcastToClients({ type: 'thread_list', data: threadData });
      ws.send(JSON.stringify({ type: 'thread_renamed', threadId, title: nextTitle }));
    } catch (e) {
      ws.send(JSON.stringify({
        type: 'action_feedback',
        status: 'error',
        message: `重命名失败: ${e.message}`
      }));
    }
  }

  else if (type === 'get_thread_history') {
    if (!threadId) return;
    const rolloutPath = findRolloutFilePathFast(threadId);
    const activeLocks = getActiveLockThreadIds();
    const all = Boolean(msg.all);
    const history = parseRolloutHistory(rolloutPath, activeLocks, threadId, { all });
    ws.send(JSON.stringify({ type: 'thread_history', threadId, data: { ...history, full: all } }));
    setupRolloutWatcher(threadId, rolloutPath);
  }

  else if (type === 'send_message') {
    if (!threadId) return;
    handleRemoteSend(ws, threadId, text, false, input);
  }

  else if (type === 'send_steer') {
    if (!threadId) return;
    handleRemoteSend(ws, threadId, text, true, input);
  }

  else if (type === 'send_stop') {
    if (!threadId) return;
    console.log(`[Remote Action] Interrupt/Stop thread ${threadId}`);
    (async () => {
      try {
        const ipc = getIpcClient();
        const ownerId = await ipc.findOwner(threadId).catch(() => null);
        if (ownerId) {
          const result = await ipc.interruptTurn(threadId, ownerId);
          ws.send(JSON.stringify({
            type: 'action_feedback',
            status: 'success',
            message: result?.interruptedTurnId
              ? `已通知持锁端停止 ${result.interruptedTurnId}`
              : '已向持锁端发送停止（当前可能没有活动 Turn）'
          }));
          return;
        }
        const client = getCodex();
        await client.ensureStarted();
        if (!client.ownedThreads.has(threadId)) {
          ws.send(JSON.stringify({
            type: 'action_feedback',
            status: 'error',
            message: '该会话没有可路由的持锁端，且不由本后端运行'
          }));
          return;
        }
        await client.interruptTurn(threadId);
        ws.send(JSON.stringify({ type: 'action_feedback', status: 'success', message: '已发送打断指令' }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'action_feedback', status: 'error', message: `停止失败: ${e.message}` }));
      }
    })();
  }

  else if (type === 'send_approval') {
    if (!threadId || !requestId) {
      ws.send(JSON.stringify({ type: 'action_feedback', status: 'error', threadId, code: 'missing_id', message: '审批缺少 requestId，请刷新会话后再批' }));
      return;
    }
    console.log(`[Remote Action] Approval ${decision} for request ${requestId} on thread ${threadId}`);
    (async () => {
      const reply = (status, message, extra = {}) => {
        ws.send(JSON.stringify({
          type: 'action_feedback',
          status,
          threadId,
          requestId,
          message,
          ...extra
        }));
      };
      try {
        const ipc = getIpcClient();
        const ownerId = await ipc.findOwner(threadId).catch(() => null);
        if (ownerId) {
          const extraIds = Array.isArray(msg.ids) ? msg.ids : [];
          const cached = rolloutParseState.get(threadId)?.pendingApproval;
          const candidates = [requestId, ...extraIds, ...(cached?.ids || []), cached?.id]
            .map((v) => (v == null ? '' : String(v)))
            .filter(Boolean);
          const tried = new Set();
          let lastErr = null;
          let ok = false;
          for (const id of candidates) {
            if (tried.has(id)) continue;
            tried.add(id);
            try {
              await ipc.sendApprovalDecision({
                conversationId: threadId,
                requestId: id,
                decision: normalizeDecision(decision),
                kind: msg.kind || msg.approvalKind,
                ownerId,
              });
              ok = true;
              break;
            } catch (err) {
              lastErr = err;
            }
          }
          if (!ok) throw lastErr || new Error('follower 审批未命中 requestId');
          closeParsedApproval(threadId, requestId, 'decided', extraIds);
          reply('success', '电脑端已接住，正在继续跑', { code: 'ok', desktop: true });
          return;
        }
        const client = getCodex();
        let r = client.decideApproval(requestId, decision);
        if (!r.ok && r.code === 'not_found') r = client.decideApproval(threadId, decision);
        if (!r.ok && (r.code === 'not_found' || r.code === 'expired')) {
          closeParsedApproval(threadId, requestId, r.code, Array.isArray(msg.ids) ? msg.ids : []);
        }
        reply(r.ok ? 'success' : 'error', r.ok
          ? '本机 Hub 已处理审批（当前没有桌面持锁）'
          : r.reason, {
          code: r.ok ? 'ok' : (r.code || 'error'),
          desktop: false,
          requestId: r.requestId || requestId
        });
      } catch (e) {
        const msgText = String(e.message || e || '');
        const gone = /timeout|not found|未命中|没有找到|已超时/i.test(msgText);
        if (gone) closeParsedApproval(threadId, requestId, 'not_found', Array.isArray(msg.ids) ? msg.ids : []);
        reply('error', `审批失败: ${e.message}`, { code: gone ? 'not_found' : 'error' });
      }
    })();
  }

  else if (type === 'run_command') {
    const cwd = resolveThreadCwd(threadId);
    if (!cwd) {
      ws.send(JSON.stringify({ type: 'action_feedback', status: 'error', message: '会话没有工作目录' }));
      return;
    }
    try {
      const prev = liveCommands.get(threadId);
      if (prev) prev.kill();
      const run = spawnCommand({
        command: msg.command,
        cwd,
        onChunk: ({ runId, stream, chunk }) => {
          ws.send(JSON.stringify({ type: 'command_output', threadId, runId, stream, chunk }));
        },
      });
      liveCommands.set(threadId, run);
      ws.send(JSON.stringify({
        type: 'action_feedback',
        status: 'success',
        message: `命令已启动（${path.basename(cwd)}）`
      }));
      run.done.then((result) => {
        if (liveCommands.get(threadId) === run) liveCommands.delete(threadId);
        ws.send(JSON.stringify({
          type: 'command_output',
          threadId,
          runId: result.runId,
          stream: 'exit',
          exitCode: result.exitCode,
          signal: result.signal,
          cwd: result.cwd,
        }));
      });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'action_feedback', status: 'error', message: `命令失败: ${e.message}` }));
    }
  }

  else if (type === 'search_thread') {
    const q = String(msg.q || msg.query || '').trim();
    const rolloutPath = findRolloutFilePathFast(threadId);
    if (!threadId || !q) {
      ws.send(JSON.stringify({ type: 'search_results', threadId: threadId || '', q, results: [], error: '缺少 threadId 或关键词' }));
      return;
    }
    if (!rolloutPath) {
      ws.send(JSON.stringify({ type: 'search_results', threadId, q, results: [], error: '找不到会话' }));
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'search_results', threadId, q, results: searchThreadHistory(rolloutPath, q), error: null }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'search_results', threadId, q, results: [], error: e.message || '搜索失败' }));
    }
  }

  else if (type === 'git_status') {
    const cwd = resolveThreadCwd(threadId);
    if (!cwd) {
      ws.send(JSON.stringify({ type: 'git_status', threadId, cwd: '', action: msg.action || 'all', status: '', diff: '', log: '', error: '会话没有工作目录' }));
      return;
    }
    (async () => {
      try {
        const result = await runGitReadonly(cwd, msg.action || 'all');
        ws.send(JSON.stringify({ type: 'git_status', threadId, ...result }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'git_status', threadId, cwd, action: msg.action || 'all', status: '', diff: '', log: '', error: e.message }));
      }
    })();
  }

  else if (type === 'get_file') {
    const rawPath = msg.path || msg.filePath || '';
    const cwd = msg.cwd || resolveThreadCwd(threadId);
    const filePath = resolveRequestedFile(rawPath, cwd);
    if (!filePath) {
      ws.send(JSON.stringify({
        type: 'file_data',
        threadId: threadId || '',
        path: rawPath,
        fileName: '',
        ext: '',
        encoding: 'utf8',
        content: '',
        truncated: false,
        error: `找不到文件: ${rawPath || '(空路径)'}`
      }));
      return;
    }
    try {
      const packed = packFileForClient(filePath);
      ws.send(JSON.stringify({
        type: 'file_data',
        threadId: threadId || '',
        path: filePath,
        fileName: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        encoding: packed.encoding,
        content: packed.content,
        truncated: packed.truncated,
        error: null
      }));
    } catch (e) {
      ws.send(JSON.stringify({
        type: 'file_data',
        threadId: threadId || '',
        path: filePath,
        fileName: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        encoding: 'utf8',
        content: '',
        truncated: false,
        error: e.message || '读取失败'
      }));
    }
  }

  else if (type === 'get_models') {
    (async () => {
      try {
        ws.send(JSON.stringify({ type: 'models_list', models: await listModelsForClient() }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'models_list', models: [], error: e.message }));
      }
    })();
  }

  else if (type === 'get_workspace_tree') {
    (async () => {
      const cwd = msg.cwd || resolveThreadCwd(threadId) || pickDefaultCwd();
      try {
        const tree = await buildWorkspaceDirectoryTreeAsync(cwd, 0, 2);
        ws.send(JSON.stringify({
          type: 'workspace_tree',
          threadId: threadId || '',
          cwd,
          rootName: path.basename(cwd) || cwd,
          tree,
          error: null
        }));
      } catch (e) {
        ws.send(JSON.stringify({
          type: 'workspace_tree',
          threadId: threadId || '',
          cwd,
          rootName: '',
          tree: [],
          error: e.message || '无法读取目录'
        }));
      }
    })();
  }

  else if (type === 'register_push') {
    if (msg.vendor === 'jpush' || !msg.vendor) {
      rememberJpushDevice(msg.registrationId || msg.registrationID || msg.rid);
    }
  }

  else if (type === 'upload_file') {
    const rawName = msg.name || 'file';
    const safeName = path.basename(String(rawName).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')) || 'file';
    const ext = path.extname(safeName).slice(0, 16);
    try {
      const buf = Buffer.from(String(msg.content || ''), 'base64');
      if (!buf.length) throw new Error('空文件');
      if (buf.length > 4 * 1024 * 1024) throw new Error('经中继上传不能超过 4MB');
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const targetPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(targetPath, buf);
      ws.send(JSON.stringify({
        type: 'upload_result',
        threadId: threadId || '',
        path: targetPath,
        name: safeName,
        error: null
      }));
    } catch (e) {
      ws.send(JSON.stringify({
        type: 'upload_result',
        threadId: threadId || '',
        path: '',
        name: safeName,
        error: e.message || '上传失败'
      }));
    }
  }
}

function resolveThreadCwd(threadId) {
  if (!threadId) return '';
  try { loadThreadMetaCache(); } catch { /* ignore */ }
  const meta = threadMetaCache.get(threadId);
  if (meta && meta.cwd) return String(meta.cwd).replace(/^\\\\\?\\/, '').replace(/^\\\?\\/, '');
  const info = rolloutCache.get(threadId);
  if (info && info.cwd) return String(info.cwd).replace(/^\\\\\?\\/, '').replace(/^\\\?\\/, '');
  return '';
}

// ----------------------------------------------------
// Unified Thread Update Push Gate（去重 + 节流，watcher 与轮询共用）
// ----------------------------------------------------
const lastThreadBroadcast = new Map(); // threadId -> { size, mtimeMs, at }
const lastPushedStatus = new Map();    // threadId -> 'working' | 'idle' | 'waiting_approval'
let lastThreadListBroadcastAt = 0;

function isHiddenThread(threadId) {
  if (!threadId) return true;
  if (subagentThreadIds.has(threadId)) return true;
  try { loadThreadMetaCache(); } catch { /* ignore */ }
  return subagentThreadIds.has(threadId);
}

function shouldNotifyThread(threadId) {
  if (!threadId) return false;
  try { loadThreadMetaCache(); } catch { /* ignore */ }
  if (subagentThreadIds.has(threadId)) return false;
  return threadMetaCache.has(threadId);
}

function pushThreadUpdate(threadId, force = false) {
  if (isHiddenThread(threadId)) {
    lastPushedStatus.delete(threadId);
    lastThreadBroadcast.delete(threadId);
    return;
  }
  const info = rolloutCache.get(threadId);
  if (!info || !info.path) return;

  let stats;
  try { stats = fs.statSync(info.path); } catch (e) { return; }

  const prev = lastThreadBroadcast.get(threadId);
  const now = Date.now();
  const fileUnchanged = Boolean(prev && prev.size === stats.size && prev.mtimeMs === stats.mtimeMs);
  if (!force && fileUnchanged) return;

  const activeLocks = getActiveLockThreadIds();
  const history = parseRolloutHistory(info.path, activeLocks, threadId);
  if (fileUnchanged && lastPushedStatus.get(threadId) === history.status) return;
  lastThreadBroadcast.set(threadId, { size: stats.size, mtimeMs: stats.mtimeMs, at: now });
  broadcastToClients({ type: 'thread_update', threadId, data: history });

  // 状态跃迁检测 → Web Push（PWA 完全关闭也能收到）
  const prevStatus = lastPushedStatus.get(threadId);
  const newStatus = history.status;
  if (prevStatus && prevStatus !== newStatus && shouldNotifyThread(threadId)) {
    const threadTitle = getThreadTitleCached(threadId);
    if (newStatus === 'waiting_approval') {
      if (history.pendingApproval && liveApprovalState(threadId).live !== false && !isParsedApprovalClosed(threadId, history.pendingApproval)) {
        const at = history.pendingApproval.at || Date.now();
        broadcastToClients({
          type: 'approval_request',
          threadId,
          requestId: history.pendingApproval.id,
          ids: history.pendingApproval.ids || [],
          kind: history.pendingApproval.type,
          command: history.pendingApproval.command || '',
          reason: history.pendingApproval.reason || '',
          at,
          expiresAt: at + APPROVAL_TTL_MS
        });
      }
      pushToAllDevices({
        title: '🛡️ Codex 需要审批',
        body: threadTitle ? `「${threadTitle}」在等待你的批准` : 'Codex 正在等待你的批准',
        tag: 'codex-approval-' + threadId,
        url: '/#thread-' + threadId,
        threadId
      });
    } else if (prevStatus === 'working' && newStatus === 'idle' && rolloutTailIsComplete(info.path, stats)) {
      pushToAllDevices({
        title: '✅ Codex 任务完成',
        body: threadTitle ? `「${threadTitle}」已完成` : '任务已完成，点击查看结果',
        tag: 'codex-done-' + threadId,
        url: '/#thread-' + threadId,
        threadId
      });
    }
  }
  lastPushedStatus.set(threadId, newStatus);

  // thread_list 全量较大，节流到至多每 2 秒广播一次
  if (now - lastThreadListBroadcastAt > 2000) {
    lastThreadListBroadcastAt = now;
    broadcastToClients({ type: 'thread_list', data: getThreadList() });
  }
}

// 缓存 thread 标题（推送文案用），随 thread_list 广播刷新
const threadTitleCache = new Map();
function getThreadTitleCached(threadId) {
  return threadTitleCache.get(threadId) || '';
}

function closeWatcher(threadId) {
  const entry = fileWatchers.get(threadId);
  if (!entry) return;
  fileWatchers.delete(threadId);
  try { entry.close(); } catch (e) {}
}

// 为正在查看的线程挂 OS 原生事件 watcher（防抖 120ms，带数量上限与老化清理）
function setupRolloutWatcher(threadId, rolloutPath) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return;
  if (fileWatchers.has(threadId)) return;

  // 上限保护：超过 8 个时关闭最旧的 watcher
  while (fileWatchers.size >= 8) {
    const oldestKey = fileWatchers.keys().next().value;
    closeWatcher(oldestKey);
  }

  let debounceTimer = null;
  try {
    const watcher = fs.watch(rolloutPath, () => {
      // Windows 下一次写入常触发多次事件，合并为一次推送
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => pushThreadUpdate(threadId), 120);
    });
    watcher.on('error', () => closeWatcher(threadId));

    fileWatchers.set(threadId, {
      path: rolloutPath,
      close: () => {
        clearTimeout(debounceTimer);
        try { watcher.close(); } catch (e) {}
      }
    });
  } catch (e) {
    console.error(`Error setting watcher for ${threadId}:`, e);
  }
}

function broadcastToClients(msg) {
  if (!wss) return;

  // 顺带刷新标题缓存（推送文案用）
  if (msg.type === 'thread_list' && msg.data && Array.isArray(msg.data.threads)) {
    for (const t of msg.data.threads) {
      if (t.id) threadTitleCache.set(t.id, t.title || '');
    }
  }

  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
  try { relay.forwardApp(slimRelayApp(msg)); } catch { /* ignore */ }
}

function slimRelayApp(msg) {
  if (!msg || (msg.type !== 'thread_update' && msg.type !== 'thread_history')) return msg;
  const payload = msg.data;
  if (!payload || !Array.isArray(payload.items)) return msg;
  if (msg.type === 'thread_history' && payload.full) return msg;
  let items = payload.items;
  let packed = JSON.stringify(items);
  if (packed.length <= 80000) return msg;
  items = items.slice(-40);
  packed = JSON.stringify(items);
  while (packed.length > 80000 && items.length > 8) {
    items = items.slice(-Math.ceil(items.length / 2));
    packed = JSON.stringify(items);
  }
  return { ...msg, data: { ...payload, items, hasMore: true } };
}

// ----------------------------------------------------
// Global Active Thread Realtime Push Engine (Zero CPU / Active-Only Polling)
// ----------------------------------------------------
// 职责收敛为：1) 对活跃(带 lock)线程兜底推送（去重门挡住重复解析）
//            2) 老化清理不再活跃的 fs.watch watcher，防止泄漏
let prevLockIds = new Set();
let statusWatchdogTick = 0;
setInterval(() => {
  const relayOnline = relay.getState && relay.getState().online;
  if ((!wss || wss.clients.size === 0) && !relayOnline) return;

  try {
    const activeLocks = getActiveLockThreadIds();
    statusWatchdogTick += 1;

    for (const threadId of prevLockIds) {
      if (!activeLocks.has(threadId)) pushThreadUpdate(threadId, true);
    }
    prevLockIds = new Set(activeLocks);

    for (const threadId of Array.from(fileWatchers.keys())) {
      if (activeLocks.has(threadId)) continue;
      const entry = fileWatchers.get(threadId);
      try {
        const st = fs.statSync(entry.path);
        if (Date.now() - st.mtimeMs > 600000) closeWatcher(threadId);
      } catch (e) {
        closeWatcher(threadId);
      }
    }

    try {
      const ipc = getIpcClient();
      if (!ipc.onApproval) {
        ipc.onApproval = (a) => {
          const at = Date.now();
          if (a.threadId) approvalClosedAt.delete(a.threadId);
          broadcastToClients({
            type: 'approval_request',
            threadId: a.threadId,
            requestId: a.requestId,
            ids: a.ids,
            kind: a.kind,
            command: a.command || '',
            reason: 'Permission approval required',
            at,
            expiresAt: at + APPROVAL_TTL_MS,
          });
        };
        ipc.onApprovalCleared = (a) => {
          if (a?.threadId) closeParsedApproval(a.threadId, '', 'desktop_gone', a.ids || []);
        };
      }
      for (const threadId of activeLocks) {
        ipc.follow(threadId).then((rows) => {
          if (!ipc.pendingByThread.has(threadId)) return;
          if ((!rows || !rows.length) && rolloutParseState.get(threadId)?.pendingApproval) {
            closeParsedApproval(threadId, '', 'desktop_gone', []);
          }
        }).catch(() => {});
      }
    } catch {
      /* desktop pipe optional */
    }
    if (statusWatchdogTick % 4 === 0) {
      for (const [threadId, status] of lastPushedStatus) {
        if (status === 'working' || status === 'waiting_approval') {
          pushThreadUpdate(threadId, true);
        }
      }
    }

    if (activeLocks.size === 0) return;

    for (const threadId of activeLocks) {
      pushThreadUpdate(threadId);
    }
  } catch (e) {}
}, 500);

// ----------------------------------------------------
// Force Fixed Port Binding (100% Locked on Port 18990)
// ----------------------------------------------------

function describePortOccupant(port) {
  if (process.platform !== 'win32') return '';
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
    const pids = new Set();
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[1].includes(`:${port}`)) {
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0' && pid !== String(process.pid)) pids.add(pid);
      }
    }
    return [...pids].length ? ` PID ${[...pids].join(', ')}` : '';
  } catch {
    return '';
  }
}

function startServerStrict(portToUse) {
  server.listen(portToUse, '0.0.0.0', () => {
    console.log('\n======================================================');
    console.log(`Codex Remote Hub (follower) is running`);
    console.log(`Local Access:    http://localhost:${portToUse}`);

    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`LAN/Network:     http://${iface.address}:${portToUse}`);
        }
      }
    }
    console.log('======================================================\n');

    initWebSocketServer();
    relay.start();
    getAccountQuota().catch(() => {});
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${portToUse} is in use.${describePortOccupant(portToUse)} Stop the other Hub or set PORT=.`);
      process.exit(1);
    } else {
      console.error('Server Start Error:', err);
    }
  });
}

startServerStrict(PORT);
