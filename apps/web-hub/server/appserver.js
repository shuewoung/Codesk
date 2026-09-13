// ----------------------------------------------------
// codex.exe app-server 客户端（stdio 换行分隔 JSON-RPC 2.0）
//
// 协议要点（实测 + 官方开源仓库 codex-rs/app-server 对照）：
//  - 帧格式：每行一条 JSON。响应 {id,result|error}；通知 {method,params}；
//    服务端请求 {id,method,params}（如审批，必须回 {id,result:{decision}}）
//  - 审批决策值：accept | acceptForSession | decline | cancel
//  - writer-lock 冲突错误含 "already has an active writer"
// 方法名/参数形状集中在本文件，协议漂移只改这里。
// ----------------------------------------------------
import { spawn, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_TTL_MS } from './turn-status.js';
import { resolveCodexBinDir, REPO_CODEX_BIN_DIR } from './codex-bin.js';

export { APPROVAL_TTL_MS };

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
// codex.exe 目录解析（CODEX_BIN > 桌面最新 hash 目录 > 仓库 codex-bin），
// 详见 codex-bin.js；CODEX_CLI_PATH 仍是 exe 级最高优先覆盖。
export const CODEX_BIN_SELECTION = resolveCodexBinDir();
export const DEFAULT_CODEX_EXE =
  process.env.CODEX_CLI_PATH ||
  path.join(CODEX_BIN_SELECTION.dir, 'codex.exe');
export { REPO_CODEX_BIN_DIR };

export const M = {
  INITIALIZE: 'initialize',
  THREAD_LIST: 'thread/list',
  THREAD_READ: 'thread/read',
  THREAD_START: 'thread/start',
  THREAD_RESUME: 'thread/resume',
  TURN_START: 'turn/start',
  TURN_STEER: 'turn/steer',
  TURN_INTERRUPT: 'turn/interrupt',
  SKILLS_LIST: 'skills/list',
  SKILLS_CONFIG_WRITE: 'skills/config/write',
  MCP_STATUS_LIST: 'mcpServerStatus/list',
  MCP_RELOAD: 'config/mcpServer/reload',
  MODEL_LIST: 'model/list',
  THREAD_SETTINGS_UPDATE: 'thread/settings/update',
};

// 与 Desktop 权限下拉对齐：ask/auto/full → approvalPolicy + permission profile id
export const ACCESS_MODE_SETTINGS = {
  ask: {
    accessMode: 'ask',
    approvalPolicy: 'on-request',
    permissions: ':read-only',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  },
  auto: {
    accessMode: 'auto',
    approvalPolicy: 'on-request',
    permissions: ':workspace',
    sandboxPolicy: {
      type: 'workspaceWrite',
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  },
  full: {
    accessMode: 'full',
    approvalPolicy: 'never',
    permissions: ':danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  },
};

export function accessModeToThreadSettings(mode) {
  const key = String(mode || '').toLowerCase();
  return ACCESS_MODE_SETTINGS[key] || ACCESS_MODE_SETTINGS.full;
}

export function resolveThreadAccessSettings(opts = {}, fallback = ACCESS_MODE_SETTINGS.full) {
  if (opts.accessMode) {
    const base = accessModeToThreadSettings(opts.accessMode);
    if (opts.approvalPolicy) return { ...base, approvalPolicy: opts.approvalPolicy };
    return base;
  }
  const policy = opts.approvalPolicy == null ? '' : String(opts.approvalPolicy);
  if (policy === 'untrusted') return { ...ACCESS_MODE_SETTINGS.ask, approvalPolicy: 'untrusted' };
  if (policy === 'never') return ACCESS_MODE_SETTINGS.full;
  if (policy === 'on-request') return ACCESS_MODE_SETTINGS.auto;
  return fallback;
}

export function threadAccessParams(settings) {
  if (!settings) return {};
  // app-server 校验：permissions 与 sandboxPolicy 互斥。
  // Desktop 对齐走 permission profile id（:read-only / :workspace / :danger-full-access），
  // sandboxPolicy 只作内部对照，不要上 turn/start、thread/start、thread/settings/update。
  const params = {};
  if (settings.approvalPolicy != null) params.approvalPolicy = settings.approvalPolicy;
  if (settings.permissions != null) params.permissions = settings.permissions;
  return params;
}

// 会触发审批的服务端请求方法（新旧两代命名都监听）
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

// 审批决策值归一化（前端用 accept/denied，协议要 accept/acceptForSession/decline/cancel）
export function normalizeDecision(decision) {
  const d = String(decision || '').toLowerCase();
  if (d === 'accept' || d === 'allow' || d === 'approved') return 'accept';
  if (d === 'acceptforsession' || d === 'session') return 'acceptForSession';
  if (d === 'cancel') return 'cancel';
  return 'decline'; // denied / decline / reject / 其它
}

export class AppServerError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = 'AppServerError';
    this.code = code;
    this.data = data;
  }
}

export function isWriterLockError(err) {
  return /already has an active writer|already has a live local writer|active writer/i.test(
    String(err?.message || err || '')
  );
}

export function isNoActiveTurnError(err) {
  return /no active turn|没有进行中的 turn/i.test(String(err?.message || err || ''));
}

export function normalizeInput(input, text) {
  const items = [];
  if (Array.isArray(input)) {
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') continue;
      const type = String(raw.type || '');
      if (type === 'text') {
        const value = String(raw.text ?? '');
        if (value) {
          items.push({
            type: 'text',
            text: value,
            text_elements: Array.isArray(raw.text_elements) ? raw.text_elements : [],
          });
        }
      } else if (type === 'localImage') {
        const filePath = String(raw.path ?? '').trim();
        if (filePath) items.push({ type: 'localImage', path: filePath });
      } else if (type === 'mention' || type === 'skill') {
        const filePath = String(raw.path ?? '').trim();
        if (!filePath) continue;
        items.push({
          type,
          name: String(raw.name ?? path.basename(filePath)),
          path: filePath,
        });
      }
    }
  }
  if (!items.length && text) {
    items.push({ type: 'text', text: String(text), text_elements: [] });
  }
  return items;
}

export class AppServerClient extends EventEmitter {
  // 事件：'notification' {method,params} / 'server-request' {id,method,params}
  //       'exit' {code} / 'log' {stream,text}
  constructor({ codexPath = DEFAULT_CODEX_EXE, clientInfo } = {}) {
    super();
    this.codexPath = codexPath;
    this.clientInfo = clientInfo || { name: 'codex-remote-hub', title: 'Codex Remote Hub', version: '3.8.0' };
    // 能力声明与官方 VS Code 扩展对齐；experimentalApi 是 runtimeWorkspaceRoots 等字段的前置条件
    this.capabilities = { experimentalApi: true, mcpServerOpenaiFormElicitation: false, requestAttestation: false };
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve,reject,timer}
    this.startingPromise = null;
  }

  get running() {
    return !!this.child && this.child.exitCode === null;
  }

  async ensureStarted() {
    if (this.startingPromise) return this.startingPromise;
    if (this.running) return this;
    const starting = this._start().finally(() => {
      if (this.startingPromise === starting) this.startingPromise = null;
    });
    this.startingPromise = starting;
    return this.startingPromise;
  }

  async _start() {
    if (!fs.existsSync(this.codexPath)) {
      throw new AppServerError(`codex.exe 不存在: ${this.codexPath}（请设置 CODEX_BIN 指向 codex 目录，或 CODEX_CLI_PATH 指向 codex.exe）`);
    }
    const child = spawn(this.codexPath, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });
    this.child = child;

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          this._dispatch(JSON.parse(line));
        } catch (e) {
          this.emit('log', { stream: 'stdout', text: line.slice(0, 300) });
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.emit('log', { stream: 'stderr', text: chunk.slice(0, 500) }));
    child.on('exit', (code) => this._disconnected(child, { code }));
    child.on('error', (error) => this._disconnected(child, { error }));
    child.stdin.on('error', (error) => {
      if (this.child !== child) return;
      this.stop();
      this.emit('log', { stream: 'stdin', text: error.message });
    });

    try {
      await this.request(
        M.INITIALIZE,
        { clientInfo: this.clientInfo, capabilities: this.capabilities },
        { timeoutMs: 20000 }
      );
    } catch (error) {
      if (this.child === child) this.stop();
      throw error;
    }
  }

  _disconnected(child, detail = {}) {
    // A delayed exit from a stopped generation must not clear its replacement.
    if (this.child !== child) return;
    this.child = null;
    this.startingPromise = null;
    const err = new AppServerError(`app-server 已退出 (code=${detail.code ?? 'unknown'})`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('exit', detail);
  }

  _dispatch(msg) {
    if (msg.method !== undefined) {
      if (msg.id !== undefined) this.emit('server-request', msg);
      else this.emit('notification', msg);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new AppServerError(msg.error.message || 'app-server error', { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
    }
  }

  request(method, params, { timeoutMs = 120000 } = {}) {
    if ((!this.running || this.startingPromise) && method !== M.INITIALIZE) {
      return this.ensureStarted().then(() => this.request(method, params, { timeoutMs }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppServerError(`发送失败: ${method}: ${e.message}`));
      }
    });
  }

  respond(id, result) {
    if (!this.running) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result: result ?? {} }) + '\n');
    } catch (e) {
      this.emit('log', { stream: 'respond', text: `响应失败 id=${id}: ${e.message}` });
    }
  }

  respondError(id, message) {
    if (!this.running) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
    } catch (e) { /* 进程退出时的响应失败可忽略 */ }
  }

  // Windows 兜底：codex.exe 可能派生子进程，child.kill() 只Terminate 直接子进程；
  // 独立成方法便于测试注入（测试用假进程，不真正执行 taskkill）。
  killProcessTree(pid) {
    if (process.platform !== 'win32' || !pid) return false;
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false; // 进程可能已随 child.kill() 退出
    }
  }

  // 终止 app-server 子进程并清理全部请求/启动状态，保证下次 ensureStarted 干净重生。
  stop() {
    const child = this.child;
    this.child = null;
    this.startingPromise = null;
    const err = new AppServerError('app-server 已停止');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('exit', { reason: 'stopped' });
    if (!child) return;
    try { child.kill(); } catch (e) { /* 忽略 */ }
    if (process.platform === 'win32' && child.pid) this.killProcessTree(child.pid);
  }
}

// ----------------------------------------------------
// codex 语义封装：Remote Hub 的全部真实控制能力
// ----------------------------------------------------
export class CodexAppServer extends EventEmitter {
  // 事件：
  //  'approval'   {requestId, method, threadId, payload, decide(decision)}
  //  'thread-activity' {threadId, method}  → 触发会话刷新推送
  constructor(opts = {}) {
    super();
    this.client = new AppServerClient(opts);
    this.ownedThreads = new Set(); // 本进程 resume/start 过的线程（我们持有 writer）
    this.pendingApprovals = new Map(); // appServerRequestId -> {threadId, method, payload, at}
    this.currentTurnByThread = new Map(); // threadId -> turnId（interrupt 用）
    this.defaultAccessSettings = ACCESS_MODE_SETTINGS.full;
    this.threadAccessSettings = new Map(); // threadId -> access settings for next turn/start
    this.runtimeByThread = new Map();
    this.runtimeRevisionByThread = new Map();
    this.pendingUserInputs = new Map();
    this.generation = 0;
    this.client.on('exit', (detail) => {
      this._clearRuntime('disconnected');
      this.emit('exit', detail);
    });

    this.client.on('server-request', (msg) => this._onServerRequest(msg));
    this.client.on('notification', (msg) => this._onNotification(msg));
    this.client.on('log', ({ stream, text }) => {
      if (stream === 'stderr' && /error|panic/i.test(text)) console.warn('[app-server]', text.trim());
    });
  }

  async ensureStarted() {
    return this.client.ensureStarted();
  }

  setDefaultAccessMode(mode) {
    this.defaultAccessSettings = accessModeToThreadSettings(mode);
    for (const id of this.threadAccessSettings.keys()) {
      this.threadAccessSettings.set(id, this.defaultAccessSettings);
    }
    return this.defaultAccessSettings;
  }

  rememberThreadAccess(threadId, settings) {
    if (threadId && settings) this.threadAccessSettings.set(threadId, settings);
  }

  accessFor(threadId, opts = {}) {
    return resolveThreadAccessSettings(
      opts,
      (threadId && this.threadAccessSettings.get(threadId)) || this.defaultAccessSettings
    );
  }

  get running() {
    return this.client.running;
  }

  _clearRuntime(reason) {
    this.generation += 1;
    for (const entry of [...this.pendingApprovals.values()]) this._closePending(entry, reason);
    for (const entry of [...this.pendingUserInputs.values()]) this._closeUserInput(entry, reason);
    this.ownedThreads.clear();
    this.currentTurnByThread.clear();
    this.runtimeByThread.clear();
    this.runtimeRevisionByThread.clear();
    this.threadAccessSettings.clear();
  }

  runtimeStatus(threadId) {
    let status = this.runtimeByThread.get(threadId) || 'unknown';
    if (this.currentTurnByThread.has(threadId)) status = 'working';
    if ([...this.pendingApprovals.values()].some((p) => p.threadId === threadId)) status = 'waiting_approval';
    if ([...this.pendingUserInputs.values()].some((p) => p.threadId === threadId && p.payload?.isBlocking !== false)) status = 'waiting_user_input';
    return { known: status !== 'unknown', status, busy: status === 'unknown' ? null : status !== 'idle', source: 'appserver' };
  }

  _recordStatus(threadId, status) {
    const type = typeof status === 'string' ? status : status?.type;
    const value = type === 'active'
      ? (status?.activeFlags?.includes('waitingOnApproval') ? 'waiting_approval'
        : status?.activeFlags?.includes('waitingOnUserInput') ? 'waiting_user_input' : 'working')
      : type === 'idle' ? 'idle' : 'unknown';
    this.runtimeByThread.set(threadId, value);
    if (value === 'idle') this.currentTurnByThread.delete(threadId);
  }

  _closeUserInput(entry, reason) {
    clearTimeout(entry.timer);
    this.pendingUserInputs.delete(String(entry.requestId));
    this.emit('user-input-closed', { ...entry, reason });
  }

  respondUserInput(requestId, response) {
    const entry = this.pendingUserInputs.get(String(requestId));
    if (!entry) return { ok: false, code: 'not_found' };
    if (Date.now() - entry.at > APPROVAL_TTL_MS) {
      this.client.respondError(entry.requestId, 'user input timeout');
      this._closeUserInput(entry, 'timeout');
      return { ok: false, code: 'expired' };
    }
    const answers = response?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)
      || Object.values(answers).some((a) => !Array.isArray(a?.answers) || a.answers.some((v) => typeof v !== 'string'))
      || (entry.payload?.questions || []).some((q) => !Object.hasOwn(answers, q.id))) {
      return { ok: false, code: 'invalid_answers' };
    }
    this.client.respond(entry.requestId, { answers });
    this._closeUserInput(entry, 'answered');
    return { ok: true, requestId: entry.requestId, threadId: entry.threadId };
  }

  _threadIdOf(params) {
    if (!params) return null;
    return params.threadId || params.thread?.id || null;
  }

  _approvalIds(entry) {
    const p = entry?.payload || {};
    return [...new Set(
      [entry?.requestId, p.request_id, p.requestId, p.call_id, p.callId, p.id]
        .map((v) => (v == null ? '' : String(v)))
        .filter(Boolean)
    )];
  }

  _findPendingApproval(requestId) {
    const want = String(requestId);
    const exact = this.pendingApprovals.get(want);
    if (exact) return exact;
    const matched = [];
    for (const entry of this.pendingApprovals.values()) {
      if (this._approvalIds(entry).includes(want) || String(entry.threadId) === want) matched.push(entry);
    }
    return matched.length === 1 ? matched[0] : null;
  }

  _closePending(entry, reason) {
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.pendingApprovals.delete(String(entry.requestId));
    this.emit('approval-closed', {
      ...entry,
      ids: this._approvalIds(entry),
      reason,
    });
  }

  _onServerRequest(msg) {
    if (APPROVAL_METHODS.has(msg.method)) {
      const threadId = this._threadIdOf(msg.params);
      const requestId = msg.id;
      const entry = {
        requestId,
        method: msg.method,
        threadId,
        payload: msg.params,
        at: Date.now(),
        timer: null,
      };
      const previous = this.pendingApprovals.get(String(requestId));
      if (previous) this._closePending(previous, 'replaced');
      this.pendingApprovals.set(String(requestId), entry);
      const timer = setTimeout(() => {
        if (this.pendingApprovals.get(String(requestId)) !== entry) return;
        this.client.respondError(requestId, 'approval timeout');
        this._closePending(entry, 'timeout');
      }, APPROVAL_TTL_MS);
      timer.unref?.();
      entry.timer = timer;

      const decide = (decision) => this.pendingApprovals.get(String(requestId)) === entry
        ? this.decideApproval(String(requestId), decision)
        : { ok: false, code: 'not_found' };
      this.emit('approval', { ...entry, ids: this._approvalIds(entry), decide });
      if (threadId) this.emit('thread-activity', { threadId, method: msg.method });
      return;
    }
    if (msg.method === 'item/tool/requestUserInput') {
      const entry = { requestId: msg.id, method: msg.method, threadId: this._threadIdOf(msg.params), payload: msg.params, at: Date.now() };
      const previous = this.pendingUserInputs.get(String(msg.id));
      if (previous) this._closeUserInput(previous, 'replaced');
      const timer = setTimeout(() => {
        if (this.pendingUserInputs.get(String(msg.id)) !== entry) return;
        this.client.respondError(msg.id, 'user input timeout');
        this._closeUserInput(entry, 'timeout');
      }, APPROVAL_TTL_MS);
      timer.unref?.();
      Object.defineProperty(entry, 'timer', { value: timer });
      this.pendingUserInputs.set(String(msg.id), entry);
      this.emit('user-input', entry);
      return;
    }
    // Do not acknowledge unsupported interactive requests with a bogus success.
    this.client.respondError(msg.id, `unsupported server request: ${msg.method}`);
  }

  _onNotification(msg) {
    const threadId = this._threadIdOf(msg.params);
    const method = String(msg.method || '');
    const turnId = msg.params?.turn?.id || msg.params?.turnId;
    if (threadId && ['thread/status/changed', 'turn/started', 'turn/completed', 'turn/interrupted'].includes(method)) {
      this.runtimeRevisionByThread.set(threadId, (this.runtimeRevisionByThread.get(threadId) || 0) + 1);
    }
    if (threadId && method === 'thread/status/changed') this._recordStatus(threadId, msg.params?.status);
    if (threadId && method === 'turn/started' && turnId) {
      this.currentTurnByThread.set(threadId, turnId);
      this.runtimeByThread.set(threadId, 'working');
    } else if (threadId && (method === 'turn/completed' || method === 'turn/interrupted')) {
      // A late completion for an older turn cannot clear a newer active turn.
      if (!turnId || !this.currentTurnByThread.has(threadId) || this.currentTurnByThread.get(threadId) === turnId) {
        this.currentTurnByThread.delete(threadId);
        this.runtimeByThread.set(threadId, 'idle');
        for (const entry of [...this.pendingApprovals.values()]) if (entry.threadId === threadId) this._closePending(entry, 'turn_completed');
        for (const entry of [...this.pendingUserInputs.values()]) if (entry.threadId === threadId) this._closeUserInput(entry, 'turn_completed');
      }
    }
    if (threadId) this.emit('thread-activity', { threadId, method: msg.method });
  }

  // —— 读（无锁）——
  async listThreads() {
    const r = await this.client.request(M.THREAD_LIST, { useStateDbOnly: true }, { timeoutMs: 30000 });
    return r?.data || [];
  }

  async readThread(threadId) {
    return this.client.request(M.THREAD_READ, { threadId }, { timeoutMs: 60000 });
  }

  // —— 写（需 writer）——
  async startThread({ cwd, approvalPolicy = null, accessMode = null } = {}) {
    const access = this.accessFor(null, { accessMode, approvalPolicy });
    const generation = this.generation;
    const r = await this.client.request(
      M.THREAD_START,
      {
        modelProvider: null,
        cwd: cwd || process.cwd(),
        ...threadAccessParams(access),
        runtimeWorkspaceRoots: cwd ? [cwd] : [],
        config: null,
        personality: null,
        threadSource: 'user',
        experimentalRawEvents: false,
        dynamicTools: null,
        serviceTier: null,
      },
      { timeoutMs: 60000 }
    );
    const threadId = r?.thread?.id;
    if (generation !== this.generation) throw new AppServerError('app-server connection changed');
    if (threadId) {
      this.ownedThreads.add(threadId);
      if (!this.runtimeRevisionByThread.has(threadId)) this._recordStatus(threadId, r.thread.status);
      this.rememberThreadAccess(threadId, access);
    }
    return r;
  }

  async resumeThread(threadId, { cwd } = {}) {
    const params = {
      threadId,
      history: null,
      path: null,
      model: null,
      modelProvider: null,
    };
    if (cwd) params.cwd = cwd;
    const generation = this.generation;
    const revision = this.runtimeRevisionByThread.get(threadId) || 0;
    const r = await this.client.request(M.THREAD_RESUME, params, { timeoutMs: 60000 });
    if (generation !== this.generation) throw new AppServerError('app-server connection changed');
    this.ownedThreads.add(threadId);
    if ((this.runtimeRevisionByThread.get(threadId) || 0) === revision) this._recordStatus(threadId, r?.thread?.status);
    if (!this.threadAccessSettings.has(threadId)) {
      this.rememberThreadAccess(threadId, this.defaultAccessSettings);
    }
    return r;
  }

  async updateThreadSettings(threadId, settings) {
    if (!threadId || !settings) return null;
    const access = settings.permissions
      ? settings
      : this.accessFor(threadId, settings);
    this.rememberThreadAccess(threadId, access);
    await this.ensureStarted();
    return this.client.request(
      M.THREAD_SETTINGS_UPDATE,
      { threadId, ...threadAccessParams(access) },
      { timeoutMs: 15000 }
    );
  }

  async sendUserTurn({ threadId, text, input = null, cwd = null, model = null, effort = null, collaborationMode = null, accessMode = null, approvalPolicy = null, clientUserMessageId = crypto.randomUUID() }) {
    const generation = this.generation;
    this.runtimeByThread.set(threadId, 'unknown');
    const access = this.accessFor(threadId, { accessMode, approvalPolicy });
    this.rememberThreadAccess(threadId, access);
    const r = await this.client.request(
      M.TURN_START,
      {
        threadId,
        clientUserMessageId,
        input: normalizeInput(input, text),
        cwd,
        ...threadAccessParams(access),
        runtimeWorkspaceRoots: [],
        model,
        effort,
        serviceTier: null,
        summary: null,
        personality: null,
        outputSchema: null,
        collaborationMode: collaborationMode || null,
      },
      { timeoutMs: 120000 }
    );
    if (generation !== this.generation) throw new AppServerError('app-server connection changed');
    const turnId = r?.turn?.id;
    const terminal = ['completed', 'interrupted', 'failed'].includes(r?.turn?.status);
    if (terminal && (!this.currentTurnByThread.has(threadId) || this.currentTurnByThread.get(threadId) === turnId)) {
      this.currentTurnByThread.delete(threadId);
      this.runtimeByThread.set(threadId, 'idle');
    }
    if (turnId && !terminal && this.runtimeByThread.get(threadId) !== 'idle'
      && (!this.currentTurnByThread.has(threadId) || this.currentTurnByThread.get(threadId) === turnId)) {
      this.currentTurnByThread.set(threadId, turnId);
      this.runtimeByThread.set(threadId, 'working');
    }
    return r;
  }

  async steerTurn({ threadId, text, input = null, expectedTurnId = null, clientUserMessageId = crypto.randomUUID() }) {
    return this.client.request(
      M.TURN_STEER,
      {
        threadId,
        clientUserMessageId,
        input: normalizeInput(input, text),
        expectedTurnId,
      },
      { timeoutMs: 60000 }
    );
  }

  async interruptTurn(threadId, turnId = null) {
    const tid = turnId || this.currentTurnByThread.get(threadId) || null;
    if (!tid) throw new AppServerError('缺少 turnId：该线程当前没有进行中的 turn（可能已结束）');
    return this.client.request(M.TURN_INTERRUPT, { threadId, turnId: tid }, { timeoutMs: 30000 });
  }

  // —— 审批 ——
  // requestId 匹配优先级：app-server 请求 id 精确匹配 > payload/callId > 线程唯一待审批兜底
  decideApproval(requestId, decision) {
    const entry = this._findPendingApproval(requestId);
    if (!entry) {
      return { ok: false, code: 'not_found', reason: '没有找到待处理的审批（可能已由桌面处理或已超时）' };
    }
    const ids = this._approvalIds(entry);
    if (Date.now() - entry.at > APPROVAL_TTL_MS) {
      this._closePending(entry, 'timeout');
      this.client.respondError(entry.requestId, 'approval timeout');
      return {
        ok: false,
        code: 'expired',
        reason: '审批已超时，无法批准',
        requestId: entry.requestId,
        threadId: entry.threadId,
        ids,
      };
    }
    this._closePending(entry, 'decided');
    this.client.respond(entry.requestId, { decision: normalizeDecision(decision) });
    return { ok: true, requestId: entry.requestId, threadId: entry.threadId, ids };
  }

  async listSkills(cwd) {
    await this.ensureStarted();
    return this.client.request(
      M.SKILLS_LIST,
      { cwds: cwd ? [cwd] : [], forceReload: false },
      { timeoutMs: 30000 }
    );
  }

  async writeSkillConfig({ path = null, name = null, enabled }) {
    await this.ensureStarted();
    const params = { enabled: !!enabled };
    if (path) params.path = path;
    else if (name) params.name = name;
    return this.client.request(M.SKILLS_CONFIG_WRITE, params, { timeoutMs: 15000 });
  }

  async listMcpServers() {
    await this.ensureStarted();
    return this.client.request(
      M.MCP_STATUS_LIST,
      { detail: 'toolsAndAuthOnly' },
      { timeoutMs: 30000 }
    );
  }

  async reloadMcpServers() {
    await this.ensureStarted();
    return this.client.request(M.MCP_RELOAD, {}, { timeoutMs: 30000 });
  }

  async listModels() {
    await this.ensureStarted();
    const models = [];
    let cursor = null;
    do {
      const result = await this.client.request(
        M.MODEL_LIST,
        { cursor, limit: 100, includeHidden: false },
        { timeoutMs: 30000 }
      );
      if (Array.isArray(result?.data)) models.push(...result.data);
      cursor = result?.nextCursor || null;
    } while (cursor);
    return models;
  }

  // 释放 Hub 持有的全部写入权：终止 app-server 子进程并清空会话状态
  // （ownedThreads / currentTurnByThread / 待审批 / 各线程 access 记忆），
  // 之后 running 为 false，下次 ensureStarted 会重新 spawn + initialize 干净重生。
  releaseAll() {
    const ownedCount = this.ownedThreads.size;
    this._clearRuntime('released');
    this.client.stop();
    this.emit('released', { ownedThreads: ownedCount });
  }

  stop() {
    this.releaseAll();
  }
}
