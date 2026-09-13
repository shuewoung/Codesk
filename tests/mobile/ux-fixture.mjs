// Standalone, in-memory UX Hub. Never imports/starts the real Hub or reads user data.
// Open ONLY the printed ux-fixture.localhost URL; numeric loopback is redirected.
import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = path.join(ROOT, 'apps/mobile/dist-web');
const HOST = 'ux-fixture.localhost';
const CODE = '2468';
const CWD = 'C:/UX-Fixture/Alpha';
const BETA = 'C:/UX-Fixture/Beta';
const CHUNK = 262144;
const hash = b => createHash('sha256').update(b).digest('hex');
const delay = ms => new Promise(r => setTimeout(r, ms));
const workbenchReplies = { send_user_input: 'user_input_result', query_command: 'command_status', get_execution_state: 'execution_state', handoff_thread: 'handoff_result', queue_message: 'queue_list', list_queue: 'queue_list', cancel_queued_message: 'queue_list', get_draft: 'draft_data', save_draft: 'draft_data', get_git_status: 'git_status', get_git_diff: 'git_diff' };
// Capability names are explicit wire flags, not a claim to run a real model.
const CAPABILITIES = { send_message: true, desktop_user_input: false, ...Object.fromEntries(Object.keys(workbenchReplies).map(name => [name, true])) };
const canonical = value => value && typeof value === 'object' ? (Array.isArray(value) ? `[${value.map(canonical)}]` : `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`) : JSON.stringify(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const replies = { ...workbenchReplies, get_threads: 'thread_list', get_thread_history: 'thread_history', search_thread: 'search_results', search_workspace: 'workspace_search', get_file: 'file_data', get_workspace_tree: 'workspace_tree', list_artifacts: 'artifacts_list' };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };

function seed() {
  const now = Date.now();
  const threads = [
    { id: 'ux-alpha', title: 'Alpha · 文件与交付验收', projectName: 'Alpha 虚拟项目', cwd: CWD, status: 'idle', isActive: false, updatedAt: new Date(now).toISOString(), mtimeMs: now },
    { id: 'ux-beta', title: 'Beta · 隔离会话与草稿', projectName: 'Beta 虚拟项目', cwd: BETA, status: 'idle', updatedAt: new Date(now - 60000).toISOString(), mtimeMs: now - 60000 },
  ];
  const files = new Map();
  const add = (p, content) => files.set(p, Buffer.isBuffer(content) ? content : Buffer.from(content));
  add(`${CWD}/README.md`, '# Alpha 虚拟项目\n\n仅用于 GUI 验收，不是实际用户项目。\n\n- 会话产物：outputs/report.md\n- 候选文档：docs/candidate.md\n- 大文件：outputs/chunk-test.txt\n');
  add(`${CWD}/src/main.ts`, '// Synthetic source, never executed\nexport const fixture = "alpha";\nexport function greet(name: string) { return `Hello ${name}`; }\n');
  add(`${CWD}/outputs/report.md`, '# Alpha 验收报告\n\n这是有会话历史来源的虚拟产物。\n\n| 项目 | 结果 |\n|---|---|\n| 文件预览 | 待验收 |\n| 原件下载 | SHA-256 校验 |\n');
  add(`${CWD}/outputs/result.csv`, 'name,status\nAlpha,ready\nBeta,isolated\n');
  add(`${CWD}/outputs/preview.html`, '<!doctype html><meta charset="utf-8"><title>Fixture artifact</title><h1>Alpha HTML 产物</h1><p>纯静态、无脚本、无外部资源。</p>');
  add(`${CWD}/docs/candidate.md`, '# 候选文档\n\n此文件存在于虚拟工作区，但没有会话生成来源，不能称为本会话产物。\n');
  add(`${CWD}/docs/slow-search.txt`, 'slow search fixture; alpha-only marker\n');
  add(`${CWD}/outputs/chunk-test.txt`, Buffer.from('UX-FIXTURE-CHUNK-0123456789abcdef\n'.repeat(22000)));
  add(`${CWD}/assets/pixel.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  add(`${BETA}/README.md`, '# Beta 虚拟项目\n\nBeta-only marker。此文件不应出现在 Alpha 的搜索结果中。\n');
  add(`${BETA}/outputs/beta-note.md`, '# Beta 产物\n\n独立会话的虚拟交付。\n');
  const histories = new Map(threads.map(t => [t.id, [
    { id: `${t.id}-old-user`, type: 'message', role: 'user', content: '较早消息：请保留各会话的草稿，不要串线。' },
    { id: `${t.id}-old-assistant`, type: 'message', role: 'assistant', content: '较早回复：本环境所有内容均为测试数据。' },
    { id: `${t.id}-user`, type: 'message', role: 'user', content: t.id === 'ux-alpha' ? '请生成报告、CSV 和 HTML，并验证下载。' : '请检查 Beta 项目的独立工作区。' },
    { id: `${t.id}-plan`, type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ explanation: '隔离环境验收计划', plan: [{ step: '检查 README.md', status: 'completed' }, { step: '核验 outputs 产物', status: 'in_progress' }, { step: '确认草稿隔离', status: 'pending' }] }) },
    { id: `${t.id}-assistant`, type: 'message', role: 'assistant', content: t.id === 'ux-alpha' ? `已生成 [验收报告](${CWD}/outputs/report.md)、[结果表](${CWD}/outputs/result.csv)、[HTML 预览](${CWD}/outputs/preview.html) 和 [分块测试文件](${CWD}/outputs/chunk-test.txt)。\n\n候选文档 docs/candidate.md 不是本会话产物。` : `Beta 产物：[独立记录](${BETA}/outputs/beta-note.md)。\n\nBeta-only marker。` },
  ]]));
  return { threads, files, histories, commands: new Map(), queue: new Map(), drafts: new Map(), executions: new Map(threads.map(t => [t.id, { threadId: t.id, location: 'desktop', status: 'idle' }])), config: { model: 'fixture-model', rawModel: 'fixture-model', effort: 'medium', speed: 'standard', accessMode: 'ask' } };
}

export async function startFixture({ port = 19992, distDir = DIST } = {}) {
  const staticDir = path.resolve(distDir);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || [18990, 18991, 8787].includes(port)) throw new Error('Only a new isolated port is permitted');
  let state = seed();
  let control = { commandDelayMs: 0, commandOutcome: 'succeeded', suppressResponses: [], delays: {}, errors: {}, drop: [], searchDelays: { slow: 1800 }, downloadMode: 'ok', downloadChunkDelayMs: 50, rejectWs: false };
  const controlToken = randomBytes(24).toString('hex');
  const tokens = new Set();
  const audit = [];
  let origin, authority;
  const record = entry => { audit.push({ at: new Date().toISOString(), ...entry }); if (audit.length > 2000) audit.shift(); };
  const metadata = (p, source, threadId) => ({ name: path.posix.basename(p), path: p, ext: path.posix.extname(p), size: state.files.get(p)?.length || 0, mtimeMs: 1789084800000, source, ...(threadId ? { threadId } : {}) });
  const manifest = () => ({ fixture: true, origin, code: CODE, hubId: 'ux-fixture-hub', bind: '127.0.0.1', threads: state.threads.map(t => ({ ...t, ...threadStatus(t.id) })), files: [...state.files].map(([p, b]) => ({ ...metadata(p), sha256: hash(b), totalChunks: Math.ceil(b.length / CHUNK) })), controls: control, wsClients: wss.clients.size, audit });
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
  async function body(req, max = 1024 * 1024) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('body too large'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  function authorized(req, url) {
    const token = url.searchParams.get('token') || String(req.headers.authorization || '').replace(/^Bearer /, '') || String(req.headers.cookie || '').match(/(?:^|; )ux_fixture=([^;]+)/)?.[1];
    return tokens.has(token);
  }
  const server = http.createServer(async (req, res) => {
    // CSP prevents stale browser storage, scanner buttons, or links from sending requests to real services.
    res.setHeader('Content-Security-Policy', `default-src 'self'; connect-src ${origin} ${origin?.replace('http:', 'ws:')}; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self' blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, origin);
      const host = String(req.headers.host || '');
      const setup = url.pathname.startsWith('/__fixture/');
      if (setup) {
        if (req.headers.origin || req.headers['x-fixture-control'] !== controlToken) return json(res, 403, { error: 'Setup-only endpoint; control header required; browser Origin forbidden' });
        if (url.pathname === '/__fixture/state' && req.method === 'GET') return json(res, 200, manifest());
        if (url.pathname === '/__fixture/control' && req.method === 'POST') {
          const patch = JSON.parse((await body(req)).toString() || '{}');
          for (const k of Object.keys(patch)) if (!['delays', 'errors', 'drop', 'searchDelays', 'downloadMode', 'downloadChunkDelayMs', 'rejectWs', 'disconnect', 'commandDelayMs', 'commandOutcome', 'suppressResponses', 'executionStates', 'drainQueue', 'pendingInputThreadId'].includes(k)) return json(res, 400, { error: `Unknown control ${k}` });
          if (patch.commandOutcome && !['succeeded', 'failed', 'uncertain'].includes(patch.commandOutcome)) throw new Error('Invalid commandOutcome');
          for (const [id, execution] of Object.entries(patch.executionStates || {})) {
            if (!state.executions.has(id) || !['desktop', 'hub', 'unknown'].includes(execution.location) || !['idle', 'running', 'unknown', 'waiting_approval', 'waiting_input'].includes(execution.status)) throw new Error('Invalid execution state');
            state.executions.set(id, { threadId: id, location: execution.location, status: execution.status });
          }
          control = { ...control, ...patch };
          if (patch.pendingInputThreadId) {
            const id = patch.pendingInputThreadId;
            if (!state.executions.has(id)) throw new Error('Unknown input thread');
            state.pendingInput = { type: 'user_input_request', threadId: id, requestId: 'fixture-input-1', method: 'item/tool/requestUserInput', at: Date.now(), payload: { questions: [{ id: 'fixture-choice', header: '模拟选择', question: '仅测试：选择虚拟报告格式', options: [{ label: 'Markdown', description: '模拟 Markdown 报告' }, { label: 'CSV', description: '模拟 CSV 报告' }] }] } };
            state.executions.set(id, { ...state.executions.get(id), status: 'waiting_input' });
            for (const ws of wss.clients) if (ws.readyState === 1) ws.send(JSON.stringify(state.pendingInput));
          }
          if (patch.drainQueue) await drainQueue();
          if (patch.disconnect) for (const ws of wss.clients) ws.close(1012, 'Fixture controlled disconnect');
          return json(res, 200, { ok: true, controls: control });
        }
        if (url.pathname === '/__fixture/reset' && req.method === 'POST') { state = seed(); audit.length = 0; return json(res, 200, { ok: true }); }
        return json(res, 404, { error: 'Unknown fixture setup endpoint' });
      }
      if (host !== authority) {
        if ([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`].includes(host) && req.method === 'GET') { res.writeHead(307, { Location: `${origin}${url.pathname}${url.search}` }); return res.end(); }
        return json(res, 403, { error: 'Use the canonical fixture origin' });
      }
      if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Cross-origin request forbidden' });
      record({ transport: 'http', method: req.method, path: url.pathname });
      if (url.pathname === '/api/discover') return json(res, 200, { ok: true, hub: true, hubId: 'ux-fixture-hub', localTrusted: false });
      if (url.pathname === '/api/auth/status') return json(res, 200, { authenticated: authorized(req, url), localTrusted: false });
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const data = JSON.parse((await body(req)).toString());
        if (String(data.password || data.code) !== CODE) return json(res, 401, { error: '测试家里码错误；请输入 2468' });
        const token = `ux-only-${randomBytes(12).toString('hex')}`; tokens.add(token);
        res.setHeader('Set-Cookie', `ux_fixture=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json(res, 200, { token, hubId: 'ux-fixture-hub' });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, url)) return json(res, 401, { error: 'Fixture login required' });
        if (url.pathname === '/api/auth/logout') { tokens.clear(); res.setHeader('Set-Cookie', 'ux_fixture=; Max-Age=0; Path=/'); return json(res, 200, { success: true }); }
        if (url.pathname === '/api/upload' && req.method === 'POST') { const name = path.posix.basename((url.searchParams.get('name') || 'upload.bin').replaceAll('\\', '/')); const p = `${CWD}/uploads/${name}`; state.files.set(p, await body(req, 20 * 1024 * 1024)); return json(res, 200, { success: true, path: p, name }); }
        if (url.pathname === '/api/file') {
          const p = (url.searchParams.get('path') || '').replaceAll('\\', '/'); const data = state.files.get(p);
          if (!data) return json(res, 404, { error: 'Virtual file not found; disk access is disabled' });
          res.writeHead(200, { 'Content-Type': mime[path.posix.extname(p)] || 'application/octet-stream', 'Content-Length': data.length, 'X-File-Sha256': hash(data) }); return res.end(data);
        }
        return json(res, 404, { error: 'Not implemented by isolated fixture' });
      }
      // Serve actual export bytes unchanged; never serve host.html, repository files, or symlink escapes.
      const pathname = decodeURIComponent(url.pathname);
      if (!(pathname === '/' || pathname === '/index.html' || pathname.startsWith('/_expo/') || pathname.startsWith('/assets/') || pathname.startsWith('/icons/') || /^\/favicon[^/]*$/.test(pathname))) return json(res, 404, { error: 'Static path not allowed' });
      const root = await realpath(staticDir);
      const file = await realpath(path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`));
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) return json(res, 403, { error: 'Static path forbidden' });
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
    } catch (error) { if (!res.headersSent) json(res, error.code === 'ENOENT' ? 503 : 400, { error: error.code === 'ENOENT' ? 'Export not ready: waiting for apps/mobile/dist-web' : String(error.message) }); else res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 7 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin);
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin) || url.pathname !== '/api/ws' || !authorized(req, url) || control.rejectWs) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  function threadStatus(threadId) {
    const status = state.executions.get(threadId)?.status || 'unknown';
    return { status: status === 'running' ? 'working' : status, isActive: status === 'running', working: status === 'running', needsApproval: status === 'waiting_approval' };
  }
  function list() { const threads = state.threads.filter(t => !t.archived).map(t => ({ ...t, ...threadStatus(t.id) })); return { threads, projects: [CWD, BETA].map(cwd => ({ id: cwd, name: cwd === CWD ? 'Alpha 虚拟项目' : 'Beta 虚拟项目', cwd, threads: threads.filter(t => t.cwd === cwd) })) }; }
  const executionState = threadId => {
    const current = state.executions.get(threadId) || { threadId, location: 'unknown', status: 'unknown' };
    // Only Hub-owned execution lanes participate in the global release gate.
    const globallyIdle = [...state.executions.values()].filter(s => s.location === 'hub').every(s => s.status === 'idle');
    const canHandoff = globallyIdle && current.location === 'hub' && current.status === 'idle';
    const pendingUserInputs = current.location === 'hub' && state.pendingInput?.threadId === threadId ? [{ ...state.pendingInput }] : [];
    return { ...current, pendingUserInputs, canHandoff, ...(!canHandoff ? { reason: current.reason || '模拟：仅当前 Hub 持有且所有 Hub 执行均确认空闲时可请求交回桌面' } : {}) };
  };
  const commandView = entry => { const { payload, task, ...command } = entry; return command; };
  async function execute(m) {
    const id = m.requestId || m.clientUserMessageId;
    if (typeof id !== 'string' || !id || !state.histories.has(m.threadId)) throw fail('INVALID_REQUEST', 'Command ID and known fixture thread required');
    const payload = canonical({ ...m, requestId: undefined });
    const existing = state.commands.get(id) || [...state.commands.values()].find(c => m.clientUserMessageId && c.clientUserMessageId === m.clientUserMessageId);
    if (existing) { if (existing.payload !== payload) throw fail('IDEMPOTENCY_CONFLICT', 'Same command ID used with different payload'); await existing.task; return commandView(existing); }
    const entry = { requestId: id, clientUserMessageId: m.clientUserMessageId, threadId: m.threadId, status: 'pending', payload };
    state.commands.set(id, entry);
    const owner = state;
    const outcome = control.commandOutcome;
    entry.task = (async () => {
      // Microtask exposes pending before reserving the simulated execution lane.
      await Promise.resolve();
      const previous = owner.executions.get(m.threadId);
      if (previous?.status !== 'idle' || previous.location === 'unknown') {
        entry.status = 'failed'; entry.error = { code: 'THREAD_BUSY', message: '模拟执行状态不允许发送' }; return;
      }
      entry.status = 'running'; owner.executions.set(m.threadId, { ...previous, status: 'running' });
      await delay(Math.min(Math.max(Number(control.commandDelayMs) || 0, 0), 120000));
      entry.status = outcome;
      entry.result = { status: outcome === 'succeeded' ? 'success' : 'error', message: '模拟发送；未调用模型、命令或真实文件', uncertain: outcome === 'uncertain' };
      if (outcome !== 'succeeded') entry.error = { code: outcome === 'uncertain' ? 'EXECUTION_UNCERTAIN' : 'SEND_FAILED', message: entry.result.message };
      if (outcome === 'succeeded') owner.histories.get(m.threadId).push(
        { id: m.clientUserMessageId || `user-${id}`, clientUserMessageId: m.clientUserMessageId, requestId: id, type: 'message', role: 'user', content: String(m.text || '') },
        { id: `assistant-${id}`, type: 'message', role: 'assistant', content: '模拟回复：消息已收到。未调用模型、未运行命令、未修改真实文件。' });
      owner.executions.set(m.threadId, { ...previous, status: outcome === 'uncertain' ? 'unknown' : 'idle' });
    })();
    await entry.task; return commandView(entry);
  }
  async function drainQueue() {
    for (const q of state.queue.values()) {
      const s = executionState(q.threadId);
      if (q.status !== 'queued' || s.status !== 'idle' || s.location === 'unknown') continue;
      q.status = 'sending';
      try { const c = await execute({ ...q.payload, type: 'send_message' }); q.status = c.status === 'succeeded' ? 'sent' : c.status; }
      catch (error) { q.status = 'uncertain'; q.error = { code: error.code, message: error.message }; }
    }
  }
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'hello', hubId: 'ux-fixture-hub', capabilities: CAPABILITIES, fixture: true, modelIsSimulated: true }));
    if (state.pendingInput) ws.send(JSON.stringify(state.pendingInput));
    const cancelled = new Set();
    ws.on('message', async raw => {
      let m;
      try {
        m = JSON.parse(String(raw));
        record({ transport: 'ws', type: m.type, requestId: m.requestId, threadId: m.threadId, path: m.path, q: m.q });
        const send = data => { if (ws.readyState === 1 && !control.suppressResponses.includes(m.type)) ws.send(JSON.stringify({ requestId: m.requestId, threadId: m.threadId, hubId: 'ux-fixture-hub', ...data })); };
        if (m.type === 'cancel_download') { cancelled.add(m.requestId); return; }
        const wait = Number(control.delays[m.type] || 0) + (m.type.startsWith('search_') ? Number(control.searchDelays[m.q] || 0) : 0);
        if (wait) await delay(Math.min(wait, 120000));
        if (control.drop.includes(m.type)) return;
        if (control.errors[m.type]) return send({ type: replies[m.type] || 'action_feedback', path: m.path, error: control.errors[m.type], status: 'error', message: control.errors[m.type] });
        const thread = state.threads.find(t => t.id === m.threadId);
        const cwd = thread?.cwd || CWD;
        const resolveFile = p => { const normalized = String(p || '').replaceAll('\\', '/'); return normalized === cwd || normalized.startsWith(cwd + '/') ? normalized : /^[A-Za-z]:/.test(normalized) ? '' : path.posix.join(cwd, normalized); };
        const p = resolveFile(m.path);
        const bytes = p.startsWith(cwd + '/') ? state.files.get(p) : undefined;
        const history = all => { const items = state.histories.get(m.threadId) || []; return { items: all ? items : items.slice(-3), totalItems: items.length, hasMore: !all && items.length > 3, full: !!all, rev: items.length, cwd, ...threadStatus(m.threadId), pendingApproval: null, activeActionText: '', tokenUsage: { totalTokens: 1234, maxContext: 128000 } }; };
        switch (m.type) {
          case 'send_user_input': {
            const pending = state.pendingInput;
            if (!pending || pending.threadId !== m.threadId || pending.requestId !== m.inputRequestId) return send({ type: 'user_input_result', result: { ok: false, code: 'NOT_FOUND' } });
            if (!Array.isArray(m.answers?.['fixture-choice']?.answers) || !m.answers['fixture-choice'].answers.every(a => typeof a === 'string')) throw fail('INVALID_REQUEST', 'Expected question answers');
            state.pendingInput = null;
            state.executions.set(m.threadId, { ...state.executions.get(m.threadId), status: 'idle' });
            for (const client of wss.clients) if (client.readyState === 1) client.send(JSON.stringify({ type: 'user_input_resolved', threadId: m.threadId, requestId: pending.requestId }));
            return send({ type: 'user_input_result', result: { ok: true } });
          }
          case 'query_command': {
            const c = state.commands.get(m.commandRequestId || m.requestId);
            return send({ type: 'command_status', threadId: c?.threadId || m.threadId, command: c ? commandView(c) : null });
          }
          case 'get_execution_state': {
            const execution = executionState(m.threadId);
            send({ type: 'execution_state', executionState: execution });
            // Replay after the correlated snapshot, matching production and surviving
            // login/session resets or switching to a thread after the initial hello.
            for (const pending of execution.pendingUserInputs) send({ ...pending, type: 'user_input_request' });
            return;
          }
          case 'handoff_thread': {
            const s = executionState(m.threadId);
            const ok = s.canHandoff;
            // A release request is not proof of writer release or Desktop ownership.
            if (ok) state.executions.set(m.threadId, { threadId: m.threadId, location: 'unknown', status: 'unknown', reason: '模拟：已请求释放 Hub 执行权，未确认写锁释放或桌面接管' });
            return send({ type: 'handoff_result', result: { ok, status: ok ? 'success' : 'error', releaseRequested: ok, writerReleaseConfirmed: false, ...(ok ? { message: '模拟：已请求交回桌面；未确认写锁释放或桌面接管' } : { code: 'HANDOFF_BLOCKED', message: s.reason }) }, executionState: executionState(m.threadId) });
          }
          case 'queue_message': case 'list_queue': case 'cancel_queued_message': {
            if (!thread) throw fail('INVALID_REQUEST', 'Unknown fixture thread');
            if (m.type === 'queue_message') {
              const id = m.requestId || m.clientUserMessageId;
              if (!id) throw fail('INVALID_REQUEST', 'Queue requestId required');
              const payload = { ...m, type: 'send_message', requestId: id };
              const old = state.queue.get(id) || [...state.queue.values()].find(q => m.clientUserMessageId && q.clientUserMessageId === m.clientUserMessageId);
              if (old && canonical(old.payload) !== canonical(payload)) throw fail('IDEMPOTENCY_CONFLICT', 'Queue ID payload mismatch');
              if (!old) state.queue.set(id, { queueId: id, threadId: m.threadId, status: 'queued', text: m.text || '', images: m.images, requestId: id, clientUserMessageId: m.clientUserMessageId, payload });
            } else if (m.type === 'cancel_queued_message') {
              const q = state.queue.get(m.queueId);
              if (!q || q.threadId !== m.threadId) throw fail('NOT_FOUND', 'Queued message not found');
              if (!['queued', 'cancelled'].includes(q.status)) throw fail('QUEUE_NOT_CANCELLABLE', 'Message already dispatched');
              q.status = 'cancelled';
            }
            return send({ type: 'queue_list', queue: { items: [...state.queue.values()].filter(q => q.threadId === m.threadId).map(({ payload, ...q }) => q) } });
          }
          case 'get_draft': case 'save_draft': {
            if (!thread) throw fail('INVALID_REQUEST', 'Unknown fixture thread');
            let draft = state.drafts.get(m.threadId) || { version: 0, text: '', attachments: [], updatedAt: 0 };
            if (m.type === 'save_draft') {
              if (!Number.isSafeInteger(m.expectedVersion) || m.expectedVersion < 0 || typeof m.text !== 'string' || m.text.length > 200000 || !Array.isArray(m.attachments) || m.attachments.length > 32 || m.attachments.some(a => !a || typeof a !== 'object' || Array.isArray(a))) throw fail('INVALID_REQUEST', 'Invalid draft');
              if (m.expectedVersion !== draft.version) return send({ type: 'draft_data', code: 'CAS_CONFLICT', error: 'Draft changed on another device', draft });
              draft = { version: draft.version + 1, text: m.text, attachments: m.attachments, updatedAt: Date.now() }; state.drafts.set(m.threadId, draft);
            }
            return send({ type: 'draft_data', draft });
          }
          case 'get_git_status': case 'get_git_diff': return send({ type: workbenchReplies[m.type], git: { branch: 'fixture/alpha', statusText: ' M src/main.ts', diff: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+fixture\n', truncated: false } });
          case 'ping': return send({ type: 'pong' });
          case 'get_threads': return send({ type: 'thread_list', data: list(), config: state.config, hostName: 'UX FIXTURE · 非真实 Hub', quota: { primaryUsedPercent: 12, planType: 'Fixture', totalTokens: 1234, maxContext: 128000 } });
          case 'get_config': return send({ type: 'config_data', data: state.config, hostName: 'UX FIXTURE · 非真实 Hub' });
          case 'update_config': state.config[m.key === 'permission' ? 'accessMode' : m.key] = m.value; return send({ type: 'config_data', data: state.config });
          case 'get_models': return send({ type: 'models_list', models: [{ id: 'fixture-model', displayName: 'Fixture Model (模拟)', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }] });
          case 'get_thread_history': return send({ type: 'thread_history', data: history(m.all) });
          case 'get_workspace_tree': {
            const dir = m.path ? resolveFile(m.path) : cwd; const nodes = new Map();
            for (const file of state.files.keys()) if (file.startsWith(dir + '/') && file.startsWith(cwd + '/')) { const rel = file.slice(dir.length + 1); const name = rel.split('/')[0]; const directory = rel.includes('/'); nodes.set(name, { name, path: `${dir}/${name}`, type: directory ? 'directory' : 'file', hasChildren: directory, ext: directory ? '' : path.posix.extname(name) }); }
            return send({ type: 'workspace_tree', cwd, path: m.path || cwd, rootName: path.posix.basename(cwd), tree: [...nodes.values()] });
          }
          case 'get_file': return send({ type: 'file_data', path: p || m.path, requestPath: m.path, fileName: path.posix.basename(p), ext: path.posix.extname(p), encoding: p.endsWith('.png') ? 'base64' : 'utf8', content: bytes ? (p.endsWith('.png') ? bytes.toString('base64') : bytes.subarray(0, 65536).toString()) : '', truncated: !!bytes && bytes.length > 65536, error: bytes ? null : '虚拟文件不存在或不属于当前会话' });
          case 'list_artifacts': { const artifacts = [...state.files.keys()].filter(p => p.startsWith(`${cwd}/outputs/`)).map(p => metadata(p, 'assistant_message', m.threadId)); const recentDocuments = [...state.files.keys()].filter(p => p.startsWith(`${cwd}/docs/`)).map(p => metadata(p, 'recent_document')); return send({ type: 'artifacts_list', artifacts, files: artifacts, recentDocuments }); }
          case 'search_workspace': return send({ type: 'workspace_search', q: m.q, hits: [...state.files.keys()].filter(p => p.startsWith(cwd + '/') && p.toLowerCase().includes(String(m.q || '').toLowerCase())).map(p => ({ name: path.posix.basename(p), path: p, dir: path.posix.dirname(p) })) });
          case 'search_thread': return send({ type: 'search_results', q: m.q, results: (state.histories.get(m.threadId) || []).flatMap((item, index) => String(item.content || '').toLowerCase().includes(String(m.q || '').toLowerCase()) ? [{ index, type: item.role || item.type, snippet: String(item.content) }] : []) });
          case 'download_file': {
            if (!bytes) return send({ type: 'download_error', error: '虚拟文件不存在' });
            const totalChunks = Math.ceil(bytes.length / CHUNK); const common = { path: p, totalBytes: bytes.length, totalChunks };
            send({ type: 'download_start', ...common, fileName: path.posix.basename(p), chunkSize: CHUNK });
            for (let seq = 0; seq < totalChunks; seq++) { await delay(Number(control.downloadChunkDelayMs) || 0); if (cancelled.has(m.requestId) || ws.readyState !== 1) return; if (control.downloadMode === 'truncate' && seq === totalChunks - 1) return; send({ type: 'download_chunk', ...common, seq: control.downloadMode === 'out-of-order' ? seq + 1 : seq, encoding: 'base64', content: bytes.subarray(seq * CHUNK, (seq + 1) * CHUNK).toString('base64') }); }
            return send({ type: 'download_complete', ...common, sha256: control.downloadMode === 'bad-hash' ? '0'.repeat(64) : hash(bytes) });
          }
          case 'upload_file': { const name = path.posix.basename(String(m.name || 'upload.bin').replaceAll('\\', '/')); const target = `${cwd}/uploads/${name}`; state.files.set(target, Buffer.from(String(m.content || ''), 'base64')); return send({ type: 'upload_result', taskId: m.taskId, path: target, name }); }
          case 'send_message': case 'send_steer': {
            const command = await execute(m);
            send({ type: 'action_feedback', action: m.type === 'send_steer' ? 'steer' : 'send', status: command.status === 'succeeded' ? 'success' : 'error', clientUserMessageId: command.clientUserMessageId, commandStatus: command.status, code: command.error?.code, message: command.result?.message || command.error?.message });
            return send({ type: 'thread_update', data: history(true) });
          }
          case 'rename_thread': if (thread) thread.title = String(m.title); return send({ type: 'thread_list', data: list() });
          case 'pin_item': { const t = state.threads.find(t => t.id === m.id); if (t) t.isPinned = !!m.pinned; return send({ type: 'thread_list', data: list() }); }
          case 'archive_item': { const t = state.threads.find(t => t.id === m.id); if (t) t.archived = !!m.archived; return send({ type: 'thread_list', data: list() }); }
          case 'create_thread': { const id = `ux-new-${state.threads.length}`; state.threads.push({ id, title: m.title || '新聊天', cwd: [CWD, BETA].includes(m.targetCwd) ? m.targetCwd : CWD, status: 'idle' }); state.histories.set(id, []); state.executions.set(id, { threadId: id, location: 'hub', status: 'idle' }); send({ type: 'thread_created', threadId: id }); return send({ type: 'thread_list', data: list() }); }
          case 'get_skills': return send({ type: 'skills_list', skills: [{ name: 'fixture-review', description: '仅展示的模拟技能', enabled: true }] });
          case 'get_mcp': case 'reload_mcp': return send({ type: 'mcp_list', servers: [] });
          case 'get_plugins': return send({ type: 'plugins_list', plugins: [] });
          case 'get_goal': case 'set_goal': if (m.objective && thread) thread.goal = m.objective; return send({ type: 'goal_data', goal: { objective: thread?.goal || '验证隔离工作区 GUI' } });
          case 'git_status': return send({ type: 'git_status', cwd, status: ' M src/main.ts', diff: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n-old\n+fixture\n', log: '0000000 fixture commit', files: [{ path: 'src/main.ts', status: 'M', add: 1, del: 1 }] });
          case 'send_stop': return send({ type: 'action_feedback', status: 'success', message: '模拟停止', action: 'stop' });
          case 'register_push': return;
          default: return send({ type: 'action_feedback', status: 'error', action: m.type?.startsWith('pty_') ? 'pty' : m.type, message: `Fixture 未实现 ${m.type}；不会调用真实后端` });
        }
      } catch (error) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: workbenchReplies[m?.type] || 'action_feedback', requestId: m?.requestId, threadId: m?.threadId, hubId: 'ux-fixture-hub', status: 'error', code: error.code || 'ERROR', error: String(error.message), message: String(error.message) })); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  authority = `${HOST}:${actualPort}`; origin = `http://${authority}`;
  return { origin, port: actualPort, code: CODE, controlToken, manifest, close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--port');
  const distIndex = process.argv.indexOf('--dist');
  const distDir = distIndex >= 0 ? process.argv[distIndex + 1] : DIST;
  if (!distDir) throw new Error('--dist requires an export directory');
  const fixture = await startFixture({ port: index >= 0 ? Number(process.argv[index + 1]) : 19992, distDir });
  console.log(JSON.stringify({ fixture: 'mobile-ux', pid: process.pid, origin: fixture.origin, bind: '127.0.0.1', code: fixture.code, controlToken: fixture.controlToken, setupBase: `http://127.0.0.1:${fixture.port}/__fixture`, dist: path.resolve(distDir), note: 'GUI home-code login only; no source patches/injections; numeric loopback redirects; CSP blocks all other connections' }, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void fixture.close().then(() => process.exit(0)); });
}
