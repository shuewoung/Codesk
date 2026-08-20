import net from 'node:net';
import crypto from 'node:crypto';

const PIPE = '\\\\.\\pipe\\codex-ipc';
const INITIAL_CLIENT_ID = 'initializing-client';
const VERSIONS = {
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-start-turn': 1,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-stream-following-changed': 1,
  'thread-stream-following-status-requested': 1,
};

export function approvalMethodFromKind(kind) {
  const raw = String(kind || '').toLowerCase();
  if (raw.includes('file') || raw.includes('patch') || raw.includes('filechange')) {
    return 'thread-follower-file-approval-decision';
  }
  if (raw.includes('permission')) {
    return 'thread-follower-permissions-request-approval-response';
  }
  return 'thread-follower-command-approval-decision';
}

export function buildApprovalParams({ conversationId, requestId, decision, kind }) {
  const method = approvalMethodFromKind(kind);
  if (method === 'thread-follower-permissions-request-approval-response') {
    const accept = String(decision || '').toLowerCase();
    const allowed = accept === 'accept' || accept === 'allow' || accept === 'approved' || accept === 'acceptforsession' || accept === 'session';
    return {
      method,
      params: {
        conversationId,
        requestId,
        response: allowed
          ? { permissions: {}, scope: accept === 'acceptforsession' || accept === 'session' ? 'session' : 'turn' }
          : { decision: 'decline' },
      },
    };
  }
  return {
    method,
    params: { conversationId, requestId, decision },
  };
}

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function createDecoder(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len === 0 || len > 45 * 1024 * 1024) {
        onMsg(new Error(`invalid frame length ${len}`));
        return;
      }
      if (buf.length < 4 + len) return;
      const json = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      try {
        onMsg(null, JSON.parse(json));
      } catch (error) {
        onMsg(error);
      }
    }
  };
}

export class CodexIpcClient {
  constructor() {
    this.socket = null;
    this.clientId = INITIAL_CLIENT_ID;
    this.pending = new Map();
    this.owners = new Map();
    this.pendingByThread = new Map();
    this.followWaiters = new Map();
    this.followed = new Set();
    this.onApproval = null;
    this.onApprovalCleared = null;
    this.connectPromise = null;
  }

  async ensureConnected() {
    if (this.socket?.writable && this.clientId !== INITIAL_CLIENT_ID) return this;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async _connect() {
    const socket = net.createConnection({ path: PIPE });
    this.socket = socket;
    this.clientId = INITIAL_CLIENT_ID;
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      setTimeout(() => reject(new Error('codex-ipc connect timeout')), 3000);
    });
    socket.on('data', createDecoder((err, msg) => {
      if (err) return;
      if (msg?.type === 'client-discovery-request') {
        socket.write(frame({
          type: 'client-discovery-response',
          requestId: msg.requestId,
          response: { canHandle: false },
        }));
        return;
      }
      if (msg?.type === 'broadcast') {
        const conversationId = msg.params?.conversationId;
        if (msg.method === 'thread-stream-following-changed' && conversationId && msg.params?.following) {
          this.owners.set(conversationId, msg.sourceClientId);
        }
        if (msg.method === 'thread-stream-state-changed' && conversationId) {
          this.ingestSnapshot(conversationId, msg.params?.change);
        }
        return;
      }
      const waiter = this.pending.get(msg?.requestId);
      if (waiter) {
        this.pending.delete(msg.requestId);
        waiter.resolve(msg);
      }
    }));
    socket.on('close', () => {
      this.clientId = INITIAL_CLIENT_ID;
      this.socket = null;
      for (const [id, waiter] of this.pending) {
        this.pending.delete(id);
        waiter.reject(new Error('codex-ipc closed'));
      }
    });
    const init = await this.request('initialize', { clientType: 'vscode' });
    const assigned = init?.result?.clientId || init?.handledByClientId;
    if (init?.resultType !== 'success' || !assigned) {
      throw new Error(`codex-ipc initialize failed: ${JSON.stringify(init)}`);
    }
    this.clientId = assigned;
    console.log(`[ipc] connected as ${assigned}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return this;
  }

  request(method, params, { targetClientId, timeoutMs = 8000 } = {}) {
    const requestId = crypto.randomUUID();
    const version = method === 'thread-follower-interrupt-turn' && !params?.expectedTurnId
      ? 3
      : (VERSIONS[method] ?? 0);
    const payload = {
      type: 'request',
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params,
      targetClientId,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`codex-ipc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject,
      });
      this.socket.write(frame(payload));
    });
  }

  async findOwner(conversationId, hostId = 'local') {
    await this.ensureConnected();
    const cached = this.owners.get(conversationId);
    if (cached) return cached;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const discovery = await this.request(
        'thread-owner-discovery',
        { hostId, conversationId },
        { timeoutMs: 5000 },
      );
      if (discovery?.resultType !== 'error' && discovery?.handledByClientId) {
        this.owners.set(conversationId, discovery.handledByClientId);
        return discovery.handledByClientId;
      }
      console.log(`[ipc] discovery ${conversationId}: ${discovery?.error || 'no owner'}`);
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return this.owners.get(conversationId) || null;
  }

  async startTurn(conversationId, input, ownerId) {
    await this.ensureConnected();
    const response = await this.request(
      'thread-follower-start-turn',
      {
        conversationId,
        turnStartParams: {
          threadId: conversationId,
          clientUserMessageId: crypto.randomUUID(),
          input,
          additionalContext: null,
        },
        localTurnMetadata: null,
        mcpAppModelContextAttachments: [],
      },
      { targetClientId: ownerId },
    );
    if (response?.resultType === 'error') {
      throw new Error(response.error || 'thread-follower-start-turn failed');
    }
    return response.result;
  }

  async steerTurn(conversationId, input, ownerId, expectedTurnId = null) {
    await this.ensureConnected();
    const response = await this.request(
      'thread-follower-steer-turn',
      {
        conversationId,
        input,
        expectedTurnId,
      },
      { targetClientId: ownerId },
    );
    if (response?.resultType === 'error') {
      throw new Error(response.error || 'thread-follower-steer-turn failed');
    }
    return response.result;
  }

  async interruptTurn(conversationId, ownerId) {
    await this.ensureConnected();
    const response = await this.request(
      'thread-follower-interrupt-turn',
      { conversationId },
      { targetClientId: ownerId },
    );
    if (response?.resultType === 'error') {
      throw new Error(response.error || 'thread-follower-interrupt-turn failed');
    }
    return response.result;
  }

  ingestSnapshot(conversationId, change) {
    const state = change?.conversationState || change?.state || null;
    const requests = Array.isArray(state?.requests) ? state.requests : [];
    const pending = requests
      .filter((row) => row && (row.method || '').includes('requestApproval'))
      .map((row) => ({
        id: row.id,
        method: row.method,
        command: row.params?.command || '',
        itemId: row.params?.itemId || '',
      }));
    const hadSnapshot = this.pendingByThread.has(conversationId);
    const prev = hadSnapshot ? (this.pendingByThread.get(conversationId) || []) : [];
    this.pendingByThread.set(conversationId, pending);
    const waiter = this.followWaiters.get(conversationId);
    if (waiter) {
      this.followWaiters.delete(conversationId);
      waiter(pending);
    }
    const first = pending[0];
    if (first && typeof this.onApproval === 'function') {
      this.onApproval({
        threadId: conversationId,
        requestId: first.id,
        ids: pending.flatMap((row) => [row.id, row.itemId]).filter((v) => v != null && v !== ''),
        kind: first.method,
        command: first.command,
      });
      return;
    }
    if (pending.length === 0 && prev.length > 0 && typeof this.onApprovalCleared === 'function') {
      this.onApprovalCleared({
        threadId: conversationId,
        ids: prev.flatMap((row) => [row.id, row.itemId]).filter((v) => v != null && v !== ''),
      });
    }
  }

  broadcast(method, params) {
    if (!this.socket?.writable) return false;
    this.socket.write(frame({
      type: 'broadcast',
      method,
      sourceClientId: this.clientId,
      version: VERSIONS[method] ?? 1,
      params,
    }));
    return true;
  }

  async follow(conversationId) {
    await this.ensureConnected();
    if (!conversationId) return [];
    if (this.followed.has(conversationId) && this.pendingByThread.has(conversationId)) {
      return this.pendingByThread.get(conversationId) || [];
    }
    this.followed.add(conversationId);
    const pending = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.followWaiters.get(conversationId) === resolve) this.followWaiters.delete(conversationId);
        resolve(this.pendingByThread.get(conversationId) || []);
      }, 1500);
      this.followWaiters.set(conversationId, (rows) => {
        clearTimeout(timer);
        resolve(rows);
      });
    });
    this.broadcast('thread-stream-following-changed', {
      conversationId,
      hostId: 'local',
      following: true,
    });
    return pending;
  }

  pendingRequestIds(conversationId) {
    return (this.pendingByThread.get(conversationId) || [])
      .flatMap((row) => [row.id, row.itemId])
      .filter((v) => v != null && v !== '')
      .map((v) => String(v));
  }

  async sendApprovalDecision({ conversationId, requestId, decision, kind, ownerId }) {
    await this.ensureConnected();
    const live = await this.follow(conversationId);
    const liveIds = live.map((row) => row.id).filter((v) => v != null && v !== '');
    const candidates = [...liveIds, requestId].map((v) => String(v)).filter(Boolean);
    let lastErr = null;
    for (const id of [...new Set(candidates)]) {
      const { method, params } = buildApprovalParams({ conversationId, requestId: id, decision, kind });
      try {
        const response = await this.request(method, params, { targetClientId: ownerId });
        if (response?.resultType === 'error') {
          lastErr = new Error(response.error || `${method} failed`);
          continue;
        }
        return response.result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('follower approval failed');
  }
}

let singleton = null;

export function getIpcClient() {
  if (!singleton) singleton = new CodexIpcClient();
  return singleton;
}
