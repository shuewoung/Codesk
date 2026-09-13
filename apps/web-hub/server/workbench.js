import { execFile } from 'node:child_process';
import { CommandStore, validId, fail, canonical } from './command-store.js';

export function validateMessage(msg) {
  validId(msg.threadId, 'threadId');
  if (msg.text != null && (typeof msg.text !== 'string' || msg.text.length > 200000)) throw fail('INVALID_REQUEST', 'text limit exceeded');
  if (msg.input != null && (!Array.isArray(msg.input) || msg.input.length > 32)) throw fail('INVALID_REQUEST', 'input invalid');
  if (Buffer.byteLength(JSON.stringify(msg)) > 1024 * 1024) throw fail('INVALID_REQUEST', 'message too large');
  if (msg.mode != null && !['plan', 'review', 'default'].includes(msg.mode)) throw fail('INVALID_REQUEST', 'mode invalid');
}
async function disabledGitFilters(cwd) {
  // Reading config does not run filters. Disable every configured driver for
  // this invocation only: diff/status can otherwise invoke clean/process even
  // with --no-ext-diff and --no-textconv. Never modify the user's Git config.
  const names = await new Promise((resolve, reject) => execFile('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { cwd, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error && !(error.code === 1 && !stdout)) return reject(fail('GIT_FAILED', 'Cannot safely inspect Git filter configuration'));
    resolve(stdout || '');
  }));
  const drivers = new Set();
  for (const key of names.split('\0').filter(Boolean)) {
    if (!/^filter\.[^=\x00-\x1f\x7f]+\.(clean|smudge|process|required)$/i.test(key)) throw fail('GIT_FAILED', 'Unsafe Git filter configuration');
    drivers.add(key.slice(0, key.lastIndexOf('.')));
  }
  const args = [...drivers].flatMap(driver => ['-c', `${driver}.clean=`, '-c', `${driver}.smudge=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`]);
  if (args.join(' ').length > 8192) throw fail('GIT_FAILED', 'Too many Git filters to safely disable');
  return args;
}
export async function readGit(cwd, kind) {
  if (!cwd) throw fail('NO_WORKSPACE', 'Thread has no known workspace');
  const filterArgs = await disabledGitFilters(cwd);
  const args = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...filterArgs, kind === 'status' ? 'status' : 'diff', ...(kind === 'status' ? ['--porcelain=v1', '--branch'] : ['--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--'])];
  return new Promise((resolve, reject) => execFile('git', args, { cwd, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 512 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => {
    if (error && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(fail('GIT_FAILED', 'Git read failed (not a repository, timeout, or inaccessible workspace)'));
    resolve({ [kind === 'status' ? 'statusText' : 'diff']: stdout || '', ...(kind === 'status' ? { branch: (stdout || '').split('\n')[0].replace(/^## /, '').split('...')[0] } : {}), truncated: !!error });
  }));
}
export function createWorkbench({ dir, hubId, send, executionState, handoff, cwd, userInput, notify = () => {} }) {
  const store = new CommandStore(dir);
  let draining = false;
  const items = threadId => Object.values(store.data.queue).filter(q => q.threadId === threadId).map(q => structuredClone(q));
  const draft = threadId => structuredClone(Object.hasOwn(store.data.drafts, threadId) ? store.data.drafts[threadId] : { version: 0, text: '', attachments: [] });
  const sendCommand = async (msg, options) => {
    validateMessage(msg);
    return store.execute(msg, () => send(msg, { queued: options?.inLane === true }), options);
  };
  async function drain() {
    if (draining) return; draining = true;
    try {
      // At most one item per thread per poll, with state rechecked inside its write lane.
      const seen = new Set();
      for (const q of Object.values(store.data.queue)) {
        if (q.status !== 'queued' || seen.has(q.threadId)) continue;
        seen.add(q.threadId);
        await store.serial(q.threadId, async () => {
          if (q.status !== 'queued') return;
          const s = await executionState(q.threadId);
          if (s.status !== 'idle' || !['hub', 'desktop'].includes(s.location)) return;
          q.status = 'sending'; store.persist();
          // Keep the same write lane from authoritative idle check through ACK.
          // execute must not enqueue itself behind this lane (which would deadlock).
          try {
            const c = await sendCommand({ ...q.payload, type: 'send_message' }, { inLane: true });
            q.status = c.status === 'succeeded' ? 'sent' : c.status === 'failed' ? 'failed' : 'uncertain';
            q.command = c;
          } catch (e) { q.status = 'uncertain'; q.error = { code: e.code, message: e.message }; }
          store.persist(); notify({ type: 'queue_list', threadId: q.threadId, queue: { items: items(q.threadId) } });
        });
      }
    } finally { draining = false; }
  }
  async function handle(msg) {
    const { threadId, requestId } = msg;
    const type = msg.type === 'send_user_input' ? 'respond_user_input' : msg.type;
    const base = { requestId, threadId, hubId };
    const responseTypes = { query_command: 'command_status', get_execution_state: 'execution_state', handoff_thread: 'handoff_result', queue_message: 'queue_list', list_queue: 'queue_list', cancel_queued_message: 'queue_list', get_draft: 'draft_data', save_draft: 'draft_data', get_git_status: 'git_status', get_git_diff: 'git_diff', respond_user_input: 'user_input_result' };
    if (!responseTypes[type] && !['send_message', 'send_steer'].includes(type)) return null;
    try {
      store.assertHealthy();
      if (type === 'query_command') return { ...base, type: 'command_status', command: store.query(msg.commandRequestId || requestId) };
      validId(threadId, 'threadId');
      if (type === 'send_message' || type === 'send_steer') {
        const c = await sendCommand(msg);
        return { ...base, ...c.result, type: 'action_feedback', action: type === 'send_steer' ? 'steer' : 'send', requestId: requestId || c.requestId, clientUserMessageId: c.clientUserMessageId, commandStatus: c.status, status: c.status === 'succeeded' ? 'success' : 'error', code: c.error?.code || c.result?.code, message: c.error?.message || c.result?.message };
      }
      if (type === 'get_execution_state') return { ...base, type: 'execution_state', executionState: await executionState(threadId) };
      if (type === 'handoff_thread') {
        const c = await store.execute(msg, async () => { const r = await handoff(threadId); return { ...r, status: r.ok ? 'success' : 'error', uncertain: false }; });
        return { ...base, type: 'handoff_result', result: c.result || c.error, commandStatus: c.status, executionState: await executionState(threadId) };
      }
      if (type === 'respond_user_input') {
        if (!['string', 'number'].includes(typeof msg.inputRequestId) || String(msg.inputRequestId).length > 160 || !msg.answers || typeof msg.answers !== 'object' || Array.isArray(msg.answers) || Object.keys(msg.answers).length > 64 || Buffer.byteLength(JSON.stringify(msg.answers)) > 128 * 1024) throw fail('INVALID_REQUEST', 'Invalid user input answer');
        return { ...base, type: 'user_input_result', result: await store.serial(threadId, () => userInput(msg)) };
      }
      if (type === 'get_draft' || type === 'save_draft') {
        if (type === 'save_draft') {
          if (!Number.isSafeInteger(msg.expectedVersion) || msg.expectedVersion < 0 || typeof msg.text !== 'string' || msg.text.length > 200000 || !Array.isArray(msg.attachments) || msg.attachments.length > 32 || Buffer.byteLength(JSON.stringify(msg.attachments)) > 256 * 1024) throw fail('INVALID_REQUEST', 'Invalid draft/version or attachments limit');
          for (const a of msg.attachments) if (!a || typeof a !== 'object' || Array.isArray(a)) throw fail('INVALID_REQUEST', 'Invalid attachment');
          const current = draft(threadId);
          if (current.version !== msg.expectedVersion) return { ...base, type: 'draft_data', code: 'CAS_CONFLICT', error: 'Draft changed on another device', draft: current };
          if (Object.keys(store.data.drafts).length >= 2000 && !Object.hasOwn(store.data.drafts, threadId)) throw fail('STORE_FULL', 'Draft limit reached');
          Object.defineProperty(store.data.drafts, threadId, { value: { version: current.version + 1, text: msg.text, attachments: structuredClone(msg.attachments), updatedAt: Date.now() }, enumerable: true, writable: true, configurable: true }); store.persist();
        }
        return { ...base, type: 'draft_data', draft: draft(threadId) };
      }
      if (['queue_message', 'list_queue', 'cancel_queued_message'].includes(type)) {
        if (type === 'queue_message') {
          validateMessage(msg); const id = validId(requestId || msg.clientUserMessageId, 'requestId');
          if (msg.clientUserMessageId) validId(msg.clientUserMessageId);
          const payload = { ...msg, requestId: id, type: 'send_message' };
          const existing = Object.values(store.data.queue).find(q => q.queueId === id || (msg.clientUserMessageId && q.clientUserMessageId === msg.clientUserMessageId));
          if (existing && canonical(existing.payload) !== canonical(payload)) throw fail('IDEMPOTENCY_CONFLICT', 'Queue ID payload mismatch');
          if (!existing) {
            if (Object.keys(store.data.queue).length >= 2000) throw fail('STORE_FULL', 'Queue limit reached');
            Object.defineProperty(store.data.queue, id, { value: { queueId: id, threadId, requestId: id, clientUserMessageId: msg.clientUserMessageId, text: msg.text || '', input: msg.input, images: msg.images, status: 'queued', createdAt: Date.now(), payload }, enumerable: true }); store.persist();
          }
        } else if (type === 'cancel_queued_message') {
          validId(msg.queueId, 'queueId'); const q = Object.hasOwn(store.data.queue, msg.queueId) ? store.data.queue[msg.queueId] : null;
          if (!q || q.threadId !== threadId) throw fail('NOT_FOUND', 'Queued message not found');
          if (!['queued', 'cancelled'].includes(q.status)) throw fail('QUEUE_NOT_CANCELLABLE', 'Message already dispatched; inspect command status');
          q.status = 'cancelled'; store.persist();
        }
        return { ...base, type: 'queue_list', queue: { items: items(threadId) } };
      }
      return { ...base, type: responseTypes[type], git: await readGit(cwd(threadId), type === 'get_git_status' ? 'status' : 'diff') };
    } catch (e) { return { ...base, type: responseTypes[type] || 'action_feedback', status: 'error', code: e.code || 'ERROR', error: e.message, message: e.message }; }
  }
  return { handle, drain, store };
}
