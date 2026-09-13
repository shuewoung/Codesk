import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as history from './history';
import * as localMessages from './local-messages';
import * as requests from './request-state';
import * as failed from './failed-sends';
import * as drafts from './composer-draft';
import * as draftSync from './draft-sync';
import * as transport from './session-transport';
import * as protocol from './protocol';
import * as handshake from './handshake';
import * as quota from './quota';
import * as types from './types';
import { createPendingCommandStorage } from './pending-commands';

// Execute the actual SessionProvider with deterministic hooks/timers and an in-memory
// socket. No Expo runtime, HTTP request, real Hub or model invocation is involved.
async function sessionHarness(options: { pending?: ReturnType<typeof createPendingCommandStorage>; hubId?: string; mode?: 'lan' | 'relay'; authRequired?: boolean } = {}) {
  let pendingRaw: string | null = null;
  const pendingStore = options.pending || createPendingCommandStorage(async () => pendingRaw, async raw => { pendingRaw = raw; });
  const slots: any[] = [];
  let index = 0, dirty = true, tree: any, effects: (() => void)[] = [];
  const equal = (a: unknown[] | undefined, b: unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks: any = {
    createContext: () => ({ Provider: 'provider' }),
    createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useRef: (value: unknown) => { const i = index++; return slots[i] ??= { current: value }; },
    useState: (initial: any) => {
      const i = index++;
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (update: any) => {
        const value = typeof update === 'function' ? update(slots[i].value) : update;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = index++;
      if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useEffect: (fn: () => any, deps: unknown[]) => {
      const i = index++;
      if (!slots[i] || !equal(slots[i].deps, deps)) {
        const previous = slots[i]; slots[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  hooks.useCallback = (fn: unknown, deps: unknown[]) => hooks.useMemo(() => fn, deps);
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1; static CLOSED = 3; static CLOSING = 2;
    readyState = 0; sent: any[] = [];
    onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor() { sockets.push(this); }
    send(raw: string) { const message = JSON.parse(raw); this.sent.push(message.type === 'fwd' ? message.enc : message); }
    close() { this.readyState = 3; }
    fail(code: number) { this.readyState = 3; this.onclose?.({ code }); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  let clock = 0, timerId = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const localDrafts = new Map<string, any>();
  const cleared: string[] = [];
  const sessionWrites: any[] = [];
  const savedSession = { mode: options.mode || 'lan', lanUrl: 'http://localhost:18990', lanPassword: 'fake-lan-token', hubId: options.hubId || 'H', relayUrl: 'https://relay.invalid', deviceToken: options.mode === 'relay' ? 'fake-relay-token' : '', contentKey: options.mode === 'relay' ? 'fake-content-key' : '', keyId: '', hubE2ePub: '', authRequired: options.authRequired || false };
  let appState: (state: string) => void = () => {};
  const modules: Record<string, any> = {
    react: { __esModule: true, default: hooks, ...hooks },
    'react-native': { Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: (_: string, fn: any) => { appState = fn; return { remove() {} }; } } },
    './api': { loginLan: async (_url: string, password: string) => { if (password === 'bad') throw new Error('unauthorized'); return { token: 'renewed-lan-token', hubId: options.hubId || 'H' }; }, pairWithCode: async () => ({ deviceToken: 'renewed-relay-token', hubId: options.hubId || 'H' }) }, './request-state': requests, './failed-sends': failed, './composer-draft': drafts,
    './local-messages': localMessages,
    './draft-sync': draftSync, './history': history, './protocol': protocol, './handshake': handshake, './quota': quota, './types': types,
    './session-transport': { ...transport, createSocketMaintenance: () => ({ start() {}, stop() {} }) },
    './discover': { normalizeHubUrl: (url: string) => url, canLanProbe: () => false }, './e2e': { secretSeal: (msg: unknown) => msg }, './push': { getJpushRegistrationId: async () => '' },
    './storage': {
      loadPendingCommands: pendingStore.load, savePendingCommand: pendingStore.put, removePendingCommand: pendingStore.remove,
      loadSession: async () => ({ ...savedSession }),
      saveSession: async (patch: any) => { sessionWrites.push(patch); Object.assign(savedSession, patch); }, loadDeviceKeys: async () => ({ publicKey: 'fake', secretKey: 'fake' }),
      loadIdSet: async () => [], saveIdSet: async () => {}, migrateComposerDraftNamespace: async () => {},
      loadComposerDraft: async (key: string) => localDrafts.get(key) || null,
      saveComposerDraft: async (key: string, value: unknown) => { localDrafts.set(key, value); },
      clearComposerDraftIfSending: async (key: string) => { cleared.push(key); },
    },
  };
  const module = { exports: {} as any };
  const compiled = ts.transpileModule(readFileSync(new URL('./session.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: (id: string) => { if (!modules[id]) throw new Error(`Unmocked import ${id}`); return modules[id]; },
    WebSocket: FakeSocket, console, URL, Date, Math,
    setTimeout: (fn: () => void, ms: number) => { timers.set(++timerId, { due: clock + ms, fn }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  }, { filename: 'session-under-test.cjs' });
  function flush() {
    let loops = 0;
    while (dirty) {
      if (++loops > 100) throw new Error('render loop');
      dirty = false; index = 0; effects = [];
      tree = module.exports.SessionProvider({ children: null });
      for (const effect of effects) effect();
    }
  }
  async function settle() { for (let i = 0; i < 15; i++) { await Promise.resolve(); flush(); } }
  await settle();
  const api = () => tree.props.value;
  const histories = () => tree.props.children[0].props.value;
  const receive = async (message: unknown) => { sockets.at(-1)!.receive(message); await settle(); };
  const caps = Object.fromEntries(['query_command', 'get_execution_state', 'handoff_thread', 'list_queue', 'queue_message', 'cancel_queued_message', 'get_draft', 'save_draft', 'get_git_status', 'get_git_diff', 'send_user_input'].map(key => [key, true]));
  async function ready() {
    const socket = sockets.at(-1)!;
    socket.open(); await settle();
    const request = socket.sent.findLast(row => row.type === 'get_threads');
    await receive({ type: 'thread_list', requestId: request.requestId, data: { threads: [] }, capabilities: caps });
  }
  async function advance(ms: number) {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.fn(); }
    await settle();
  }
  return { api, histories, savedSession, sessionWrites, tools: () => tree.props.children[0].props.children[0].props.value, sockets, ready, receive, settle, advance, cleared, localDrafts,
    unmount: () => { for (const slot of slots) slot?.cleanup?.(); },
    foreground: async () => { appState('background'); await settle(); appState('active'); await settle(); } };
}

function visible(h: Awaited<ReturnType<typeof sessionHarness>>, threadId = 't') {
  return history.flattenItems(localMessages.localMessageItems(h.histories().histories[threadId], h.api().localMessages, threadId)).filter(n => n.kind === 'user');
}

test('local matching reserves exact IDs, retains bindings across windows, and refuses unknown baselines', () => {
  const base = { ...history.emptyHistory(), full: true, totalItems: 0 };
  const send = (id: string) => localMessages.createLocalMessage({ id, clientUserMessageId: id, threadId: 't', text: 'same', working: false, kind: 'message' }, base);
  const first = send('one'), second = send('two');
  let snapshot = { ...base, totalItems: 1, items: [{ type: 'UserMessage', id: 'two', content: 'same' }] };
  let rows = localMessages.reconcileLocalMessages([first, second], 't', snapshot);
  assert.equal(rows[0].matched, undefined);
  assert.equal(rows[1].matched, 'id:two');
  snapshot = { ...base, totalItems: 2, items: [{ type: 'UserMessage', id: 'one', content: 'same' }, ...snapshot.items] };
  rows = localMessages.reconcileLocalMessages(rows, 't', snapshot);
  assert.equal(rows[0].matched, 'id:one');
  const third = send('three');
  const window = { ...base, full: false, totalItems: 3, items: [{ type: 'UserMessage', id: 'third-canonical', content: 'same' }] };
  rows = localMessages.reconcileLocalMessages([...rows, third], 't', window);
  assert.equal(rows[2].matched, 'id:third-canonical');
  assert.equal(history.flattenItems(localMessages.localMessageItems(window, rows, 't')).length, 1);
  const unknown = { ...first, baseline: undefined };
  assert.equal(localMessages.reconcileLocalMessages([unknown], 't', window)[0].matched, undefined);
  assert.equal(localMessages.reconcileLocalMessages([first], 'other', snapshot)[0].matched, undefined);
  assert.equal(localMessages.reconcileLocalMessages([{ ...first, status: 'failed' }], 't', window)[0].matched, undefined);
});

test('optimistic projection precedes new working output and matches attachment payloads without ID', () => {
  const base = { ...history.emptyHistory(), full: true, totalItems: 0 };
  const local = localMessages.createLocalMessage({ id: 'image', threadId: 't', text: 'look', input: [{ type: 'localImage', path: '/a.png' }], working: false, kind: 'message' }, base);
  const working = { ...base, totalItems: 1, items: [{ type: 'command_execution', command: 'pwd' }] };
  const projected = history.flattenItems(localMessages.localMessageItems(working, [local], 't'));
  assert.equal(projected[0].kind, 'user'); assert.equal(projected[0].text, 'look');
  assert.equal(projected[1].kind, 'command');
  const otherImage = { ...base, totalItems: 1, items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'input_image', path: '/b.png' }] }] };
  assert.equal(localMessages.reconcileLocalMessages([local], 't', otherImage)[0].matched, undefined);
  const sameImage = { ...base, totalItems: 1, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', path: '/a.png' }] }] };
  assert.equal(localMessages.reconcileLocalMessages([local], 't', sameImage)[0].matched, 'position:0');
  const file = localMessages.createLocalMessage({ id: 'file', threadId: 't', text: '', input: [{ type: 'mention', name: 'report.pdf', path: '/report.pdf' }, { type: 'skill', name: 'review', path: '/skills/review' }], working: false, kind: 'message' }, base);
  const fileNode = history.flattenItems(localMessages.localMessageItems(base, [file], 't'))[0];
  assert.equal(fileNode.kind, 'user');
  assert.equal(fileNode.attachments?.length, 2);
  assert.equal(fileNode.attachments?.[0].path, '/report.pdf');
  assert.equal(fileNode.deliveryStatus, 'pending');
});

test('optimistic message is immediate, includes attachments, survives ACK, and does not mutate history', async () => {
  const h = await sessionHarness(); await h.ready();
  await h.receive({ type: 'thread_created', threadId: 't' });
  const input = [{ type: 'text', text: 'body\n附件: /tmp/report.pdf' }, { type: 'localImage', path: '/tmp/pic.png' }];
  assert.equal(h.api().sendComposer('t', 'body', false, input), true);
  await h.settle();
  assert.equal(visible(h)[0].text, 'body\n附件: /tmp/report.pdf');
  assert.equal(visible(h)[0].images?.[0].path, '/tmp/pic.png');
  assert.equal(visible(h)[0].deliveryStatus, 'pending');
  assert.equal(h.histories().histories.t.items.length, 0);
  assert.equal(visible(h, 'other').length, 0);
  const id = h.api().outgoing.id;
  await h.receive({ type: 'action_feedback', requestId: id, threadId: 't', action: 'send', status: 'success' });
  assert.equal(visible(h).length, 1);
  assert.equal(visible(h)[0].deliveryStatus, 'succeeded');
  assert.equal(h.api().outgoing, null);
  await h.receive({ type: 'thread_update', threadId: 't', data: { full: true, totalItems: 1, rev: 1, items: [{ type: 'message', role: 'user', id: 'canonical', clientUserMessageId: id, content: input }] } });
  assert.equal(visible(h).length, 1);
  assert.equal(visible(h)[0].deliveryStatus, 'succeeded');
});

test('history before ACK deduplicates but keeps pending; consecutive identical sends consume separate positions', async () => {
  const h = await sessionHarness(); await h.ready();
  const user = (id: string) => ({ type: 'message', role: 'user', id, content: 'same' });
  await h.receive({ type: 'thread_update', threadId: 't', data: { full: true, totalItems: 1, rev: 1, items: [user('old')] } });
  h.api().sendComposer('t', 'same', false); await h.settle();
  const first = h.api().outgoing.id;
  assert.equal(visible(h).length, 2);
  await h.receive({ type: 'thread_update', threadId: 't', data: { full: true, totalItems: 2, rev: 2, items: [user('old'), user('first')] } });
  assert.equal(visible(h).length, 2);
  assert.equal(visible(h)[1].deliveryStatus, 'pending');
  h.api().queryCommand(first); await h.settle();
  await h.receive({ type: 'command_status', requestId: first, command: { requestId: first, threadId: 't', status: 'succeeded' } });
  h.api().sendComposer('t', 'same', false); await h.settle();
  const second = h.api().outgoing.id;
  assert.notEqual(first, second);
  assert.equal(visible(h).length, 3);
  await h.receive({ type: 'action_feedback', requestId: second, threadId: 't', action: 'send', status: 'success' });
  assert.equal(visible(h).length, 3);
  await h.receive({ type: 'thread_update', threadId: 't', data: { full: true, totalItems: 3, rev: 3, items: [user('old'), user('first'), user('second')] } });
  assert.equal(visible(h).length, 3);
  assert.equal(h.api().localMessages[0].matched, 'id:first');
  assert.equal(h.api().localMessages[1].matched, 'id:second');
});

test('failure retains bubble and recoverable payload; retry reuses bubble; restore removes it', async () => {
  const h = await sessionHarness(); await h.ready();
  h.api().sendComposer('t', 'recover me', false); await h.settle();
  const id = h.api().outgoing.id;
  await h.receive({ type: 'action_feedback', requestId: id, threadId: 't', action: 'send', status: 'error', message: 'Send failed' });
  assert.equal(visible(h)[0].deliveryStatus, 'failed');
  assert.equal(h.api().failedSends[0].text, 'recover me');
  assert.equal(h.cleared.length, 0);
  assert.equal(h.api().retryFailedSend(id), true); await h.settle();
  assert.equal(visible(h).length, 1);
  assert.equal(visible(h)[0].deliveryStatus, 'pending');
  h.api().queryCommand(id); await h.settle();
  await h.receive({ type: 'command_status', requestId: id, command: { requestId: id, threadId: 't', status: 'failed', error: 'failed again' } });
  assert.equal(visible(h)[0].deliveryStatus, 'failed');
  h.api().dismissFailedSend(id); await h.settle();
  assert.equal(visible(h).length, 0);
});

test('25-second send deadline marks unknown, queries original request ID, never resends; late ACK clears it', async () => {
  const h = await sessionHarness();
  h.sockets[0].open(); await h.settle();
  assert.equal(h.api().conn, 'connecting');
  assert.equal(h.api().sendComposer('t', 'not ready', false), false);
  await h.ready();
  assert.equal(h.api().sendComposer('t', 'message', false, undefined, 'plan'), true);
  await h.settle();
  const wire = h.sockets.at(-1)!.sent.find(row => row.type === 'send_message');
  assert.equal(wire.clientUserMessageId, wire.requestId);
  await h.advance(25000);
  assert.equal(h.api().failedSends[0].deliveryStatus, 'uncertain');
  assert.equal(visible(h)[0].deliveryStatus, 'uncertain');
  assert.equal(h.api().outgoing, null);
  assert.equal(h.api().retryFailedSend(wire.requestId), false);
  await h.settle();
  assert.equal(h.sockets.at(-1)!.sent.filter(row => row.type === 'send_message').length, 1);
  assert.ok(h.sockets.at(-1)!.sent.some(row => row.type === 'query_command' && row.requestId === wire.requestId));
  await h.receive({ type: 'command_status', requestId: wire.requestId, command: { requestId: wire.requestId, threadId: 't', status: 'succeeded' } });
  assert.equal(h.api().failedSends.length, 0);
  assert.equal(h.cleared.length, 1);
  assert.equal(visible(h)[0].text, 'message');
  assert.equal(visible(h)[0].deliveryStatus, 'succeeded');
});

test('foreground history reconciliation accepts a correlated restart snapshot and refreshes execution/draft/queue', async () => {
  const h = await sessionHarness(); await h.ready();
  h.histories().openThread('t'); await h.settle();
  const socket = h.sockets.at(-1)!;
  const request = socket.sent.findLast(row => row.type === 'get_thread_history');
  await h.receive({ type: 'thread_history', requestId: request.requestId, threadId: 't', data: { full: true, rev: 900, items: [{ id: 'old', content: 'old' }, { id: 'tail', content: 'tail' }], totalItems: 2 } });
  await h.foreground();
  const reconcile = socket.sent.findLast(row => row.type === 'get_thread_history');
  assert.equal(reconcile.all, true);
  assert.ok(reconcile.limit >= 252);
  for (const type of ['get_execution_state', 'list_queue', 'get_draft']) assert.ok(socket.sent.some(row => row.type === type && row.threadId === 't'));
  await h.receive({ type: 'thread_history', requestId: reconcile.requestId, threadId: 't', data: { full: true, rev: 2, items: [{ id: 'new', content: 'new' }], totalItems: 1 } });
  assert.equal(h.histories().histories.t.rev, 2);
  assert.equal(h.histories().histories.t.items[0].id, 'new');
  await h.receive({ type: 'thread_history', requestId: request.requestId, threadId: 't', data: { full: true, rev: 900, items: [{ id: 'stale' }] } });
  assert.equal(h.histories().histories.t.items[0].id, 'new');
});

test('intervening live revision prevents correlated but older reconciliation from regressing content', async () => {
  const h = await sessionHarness(); await h.ready(); h.histories().openThread('t'); await h.settle();
  const socket = h.sockets.at(-1)!;
  let request = socket.sent.findLast(row => row.type === 'get_thread_history');
  await h.receive({ type: 'thread_history', requestId: request.requestId, threadId: 't', data: { full: true, rev: 5, items: [{ id: 'a' }] } });
  await h.foreground(); request = socket.sent.findLast(row => row.type === 'get_thread_history');
  await h.receive({ type: 'thread_update', threadId: 't', data: { rev: 6, delta: { baseRev: 5, newItems: [{ id: 'b' }] } } });
  await h.receive({ type: 'thread_history', requestId: request.requestId, threadId: 't', data: { full: true, rev: 5, items: [{ id: 'a' }] } });
  assert.equal(h.histories().histories.t.rev, 6);
  assert.equal(h.histories().histories.t.items.length, 2);
});

test('broadcast queue and cross-end input/approval resolutions do not claim success on submission', async () => {
  const h = await sessionHarness(); await h.ready();
  await h.receive({ type: 'queue_list', threadId: 't', queue: { items: [{ queueId: 'q', threadId: 't', text: 'queued', status: 'queued' }] } });
  assert.equal(h.api().queues.t[0].status, 'queued');
  await h.receive({ type: 'user_input_request', threadId: 't', requestId: 'input-1', method: 'tool/requestUserInput', payload: { questions: [{ id: 'q', question: 'Choose' }] } });
  assert.equal(h.api().respondUserInput('input-1', { answers: { q: { answers: ['A'] } } }), true);
  await h.settle();
  assert.ok(h.api().userInputs['input-1']);
  await h.receive({ type: 'user_input_resolved', threadId: 't', requestId: 'input-1' });
  assert.equal(h.api().userInputs['input-1'], undefined);
  await h.receive({ type: 'approval_request', threadId: 't', requestId: 'approval-1' });
  h.histories().sendApproval('t', 'accept'); await h.settle();
  assert.ok(h.histories().approvals.t);
  await h.receive({ type: 'approval_resolved', threadId: 't', requestId: 'approval-1' });
  assert.equal(h.histories().approvals.t, undefined);
});

test('reconnect queries the pending original send and reconciles current history without replay', async () => {
  const h = await sessionHarness(); await h.ready();
  h.histories().openThread('t'); await h.settle();
  h.api().sendComposer('t', 'one intent', false); await h.settle();
  const sent = h.sockets[0].sent.find(row => row.type === 'send_message');
  h.api().reconnect(); await h.settle(); await h.ready();
  const socket = h.sockets.at(-1)!;
  assert.equal(h.sockets.length, 2);
  assert.equal(visible(h).length, 1);
  assert.equal(visible(h)[0].text, 'one intent');
  assert.equal(socket.sent.filter(row => row.type === 'send_message').length, 0);
  assert.ok(socket.sent.some(row => row.type === 'query_command' && row.requestId === sent.requestId));
  assert.ok(socket.sent.some(row => row.type === 'get_thread_history' && row.threadId === 't' && row.all));
});

test('Session draft CAS preserves conflict, explicitly keeps local, then adopts remote only when chosen', async () => {
  const h = await sessionHarness(); await h.ready();
  const socket = h.sockets.at(-1)!;
  const key = drafts.scopedDraftKey('t', h.api().draftNamespace);
  h.localDrafts.set(key, { text: 'local', pending: [], updatedAt: 1 });
  h.api().getDraft('t'); await h.settle();
  let request = socket.sent.findLast(row => row.type === 'get_draft');
  await h.receive({ type: 'draft_data', requestId: request.requestId, threadId: 't', draft: { version: 3, text: 'remote', attachments: [] } });
  assert.equal(h.api().draftSync.t.status, 'conflict');
  assert.equal(h.localDrafts.get(key).text, 'local');
  assert.equal(await h.api().resolveDraftConflict('t', 'local'), true); await h.settle();
  request = socket.sent.findLast(row => row.type === 'save_draft');
  assert.equal(request.expectedVersion, 3); assert.equal(request.text, 'local');
  await h.receive({ type: 'draft_data', requestId: request.requestId, threadId: 't', code: 'CAS_CONFLICT', error: 'changed', draft: { version: 4, text: 'remote newer', attachments: [] } });
  assert.equal(h.api().draftSync.t.status, 'conflict');
  assert.equal(h.api().draftSync.t.local.text, 'local');
  assert.equal(h.localDrafts.get(key).text, 'local');
  assert.equal(await h.api().resolveDraftConflict('t', 'remote'), true); await h.settle();
  assert.equal(h.localDrafts.get(key).text, 'remote newer');
  assert.equal(h.api().draftSync.t.status, 'synced');
});

test('execution reconciliation clears only its thread stale inputs, and Git APIs remain read-only', async () => {
  const h = await sessionHarness(); await h.ready();
  const socket = h.sockets.at(-1)!;
  for (const threadId of ['t', 'other']) await h.receive({ type: 'user_input_request', threadId, requestId: `input-${threadId}`, method: 'tool/requestUserInput', payload: { questions: [] } });
  h.api().getExecutionState('t'); await h.settle();
  let request = socket.sent.findLast(row => row.type === 'get_execution_state');
  await h.receive({ type: 'execution_state', requestId: request.requestId, threadId: 't', executionState: { threadId: 't', location: 'desktop', status: 'idle', canHandoff: false, pendingUserInputs: [] } });
  assert.equal(h.api().userInputs['input-t'], undefined);
  assert.ok(h.api().userInputs['input-other']);
  h.tools().gitStatus('t'); h.tools().gitDiff('t'); await h.settle();
  request = socket.sent.findLast(row => row.type === 'get_git_status');
  await h.receive({ type: 'git_status', requestId: request.requestId, threadId: 't', git: { branch: 'work', statusText: ' M file' } });
  request = socket.sent.findLast(row => row.type === 'get_git_diff');
  await h.receive({ type: 'git_diff', requestId: request.requestId, threadId: 't', git: { diff: '+line', truncated: false } });
  assert.equal(h.tools().git.branch, 'work'); assert.equal(h.tools().git.diff, '+line');
  assert.equal(socket.sent.some(row => row.type === 'git_status' || row.type === 'run_command'), false);
});

test('unsupported capabilities fail honestly without emitting workbench commands', async () => {
  const h = await sessionHarness(); await h.ready();
  await h.receive({ type: 'config_data', data: {}, capabilities: {} });
  const socket = h.sockets.at(-1)!; const before = socket.sent.length;
  assert.equal(h.api().handoffThread('t'), false);
  assert.equal(h.api().queueMessage('t', 'no'), false);
  h.tools().gitDiff('t'); await h.settle();
  assert.equal(socket.sent.length, before);
  assert.match(h.api().error, /不支持/);
});

test('persist-before-dispatch survives Provider teardown, restores only IDs, queries once and removes confirmed ACK', async () => {
  let raw: string | null = null;
  const pending = createPendingCommandStorage(async () => raw, async value => { raw = value; });
  const first = await sessionHarness({ pending }); await first.ready();
  assert.equal(first.api().sendComposer('t', 'PRIVATE TEXT NEVER STORED', false, [{ type: 'localImage', path: '/private/file.png' }]), true);
  assert.equal(first.sockets[0].sent.some(row => row.type === 'send_message'), false);
  await first.settle();
  const wire = first.sockets[0].sent.find(row => row.type === 'send_message');
  assert.ok(raw?.includes(wire.requestId));
  assert.equal(raw?.includes('PRIVATE'), false); assert.equal(raw?.includes('/private'), false);
  first.unmount();
  const second = await sessionHarness({ pending }); await second.ready();
  const socket = second.sockets[0];
  assert.equal(socket.sent.some(row => row.type === 'send_message' || row.type === 'send_steer'), false);
  assert.ok(socket.sent.some(row => row.type === 'query_command' && row.requestId === wire.requestId));
  assert.equal(second.api().failedSends[0].restored, true);
  assert.equal(second.api().failedSends[0].text, '');
  await second.receive({ type: 'command_status', requestId: wire.requestId, command: { requestId: wire.requestId, threadId: 't', status: 'succeeded' } });
  assert.equal((await pending.load(second.api().draftNamespace)).length, 0);
  assert.equal(second.cleared.length, 0, 'ID-only recovery must not clear an unrelated edited draft');
  second.unmount();
  const third = await sessionHarness({ pending }); await third.ready();
  assert.equal(third.api().failedSends.length, 0);
  assert.equal(third.sockets[0].sent.some(row => row.type === 'query_command'), false);
});

test('persistent requests are Hub-isolated and definite recovered failure clears metadata without re-sending', async () => {
  let raw: string | null = null;
  const pending = createPendingCommandStorage(async () => raw, async value => { raw = value; });
  const namespace = drafts.draftNamespace({ mode: 'lan', hubId: 'H' });
  await pending.put({ namespace, requestId: 'old-id', clientUserMessageId: 'old-user', threadId: 't', createdAt: 1 });
  const other = await sessionHarness({ pending, hubId: 'OTHER' }); await other.ready();
  assert.equal(other.api().failedSends.length, 0);
  assert.equal(other.sockets[0].sent.some(row => row.type === 'query_command'), false);
  const h = await sessionHarness({ pending }); await h.ready();
  await h.receive({ type: 'command_status', requestId: 'old-id', command: { requestId: 'old-id', threadId: 't', status: 'failed', error: { code: 'FAILED', message: 'confirmed failure' } } });
  assert.equal((await pending.load(namespace)).length, 0);
  assert.equal(h.api().failedSends[0].deliveryStatus, 'failed');
  assert.equal(h.api().retryFailedSend('old-id'), false, 'restored metadata has no prompt to resend');
  assert.equal(h.sockets[0].sent.some(row => row.type === 'send_message'), false);
});

test('storage failure cannot dispatch, and a write completing after unmount also cannot dispatch', async () => {
  const failing = createPendingCommandStorage(async () => null, async () => { throw new Error('disk full'); });
  const h = await sessionHarness({ pending: failing }); await h.ready();
  h.api().sendComposer('t', 'not sent', false); await h.settle();
  assert.equal(h.sockets[0].sent.some(row => row.type === 'send_message'), false);
  assert.match(h.api().error, /未发送/);
  assert.equal(h.api().failedSends[0].deliveryStatus, 'failed');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let raw: string | null = null;
  const pending = createPendingCommandStorage(async () => raw, async value => { await gate; raw = value; });
  const slow = await sessionHarness({ pending }); await slow.ready();
  slow.api().sendComposer('t', 'unmount while saving', false); await slow.settle();
  slow.unmount(); release(); await Promise.resolve(); await Promise.resolve();
  const next = await sessionHarness({ pending }); await next.ready();
  assert.equal(slow.sockets[0].sent.some(row => row.type === 'send_message'), false);
  assert.equal(next.sockets[0].sent.some(row => row.type === 'send_message'), false);
  assert.equal(next.api().failedSends[0].restored, true);
});

test('list queue and broadcasts are silent while mutation ACK feedback is explicit', async () => {
  const h = await sessionHarness(); await h.ready();
  const socket = h.sockets[0];
  h.api().listQueue('t'); await h.settle();
  let request = socket.sent.findLast(row => row.type === 'list_queue');
  await h.receive({ type: 'queue_list', requestId: request.requestId, threadId: 't', queue: { items: [] } });
  assert.equal(h.api().feedback, '');
  await h.receive({ type: 'queue_list', threadId: 't', queue: { items: [] } });
  assert.equal(h.api().feedback, '');
  h.api().queueMessage('t', 'queued'); await h.settle();
  request = socket.sent.findLast(row => row.type === 'queue_message');
  await h.receive({ type: 'queue_list', requestId: request.requestId, threadId: 't', queue: { items: [] } });
  assert.match(h.api().feedback, /不代表任务完成/);
});

test('Git diff-first/status-later responses merge and previous-thread responses never overwrite the new view', async () => {
  const h = await sessionHarness(); await h.ready();
  const socket = h.sockets[0];
  h.tools().gitDiff('t'); await h.settle();
  let request = socket.sent.findLast(row => row.type === 'get_git_diff');
  await h.receive({ type: 'git_diff', requestId: request.requestId, threadId: 't', git: { diff: '+kept', truncated: false } });
  h.tools().gitStatus('t'); await h.settle();
  assert.equal(h.tools().git.diff, '+kept');
  request = socket.sent.findLast(row => row.type === 'get_git_status');
  await h.receive({ type: 'git_status', requestId: request.requestId, threadId: 't', git: { branch: 'main', statusText: ' M file' } });
  assert.equal(h.tools().git.diff, '+kept'); assert.equal(h.tools().git.branch, 'main');
  h.tools().gitDiff('t'); await h.settle();
  const stale = socket.sent.findLast(row => row.type === 'get_git_diff');
  h.tools().gitStatus('other'); await h.settle();
  request = socket.sent.findLast(row => row.type === 'get_git_status');
  await h.receive({ type: 'git_status', requestId: request.requestId, threadId: 'other', git: { branch: 'other-branch' } });
  await h.receive({ type: 'git_diff', requestId: stale.requestId, threadId: 't', git: { diff: '+stale' } });
  assert.equal(h.tools().git.threadId, 'other'); assert.equal(h.tools().git.diff, undefined);
});

test('uncreated v0 remote draft preserves local text without conflict and permits a CAS save', async () => {
  const h = await sessionHarness(); await h.ready();
  const key = drafts.scopedDraftKey('t', h.api().draftNamespace);
  h.localDrafts.set(key, { text: 'my unsynced local draft', pending: [], updatedAt: 1 });
  h.api().getDraft('t'); await h.settle();
  const socket = h.sockets[0]; const request = socket.sent.findLast(row => row.type === 'get_draft');
  await h.receive({ type: 'draft_data', requestId: request.requestId, threadId: 't', draft: { version: 0, text: '', attachments: [] } });
  assert.equal(h.api().draftSync.t.status, 'synced');
  assert.equal(h.api().draftSync.t.local.text, 'my unsynced local draft');
  assert.equal(h.localDrafts.get(key).text, 'my unsynced local draft');
  assert.equal(h.api().saveDraft('t', 'my unsynced local draft', []), true);
  await h.settle();
  assert.equal(socket.sent.findLast(row => row.type === 'save_draft').expectedVersion, 0);
});

test('input reply tracking correlates exact client request and thread; timeout stays unknown until explicit failure', async () => {
  const h = await sessionHarness(); await h.ready();
  await h.receive({ type: 'user_input_request', requestId: 'rpc-input', threadId: 't', method: 'tool/requestUserInput', payload: { questions: [{ id: 'q', question: 'answer?' }] } });
  assert.equal(h.api().respondUserInput('rpc-input', { answers: { q: { answers: ['reply'] } } }), true);
  await h.settle();
  const socket = h.sockets[0]; const wire = socket.sent.findLast(row => row.type === 'send_user_input');
  assert.equal(h.api().requestState('send_user_input', 't').requestId, wire.requestId);
  assert.equal(h.api().requestState('send_user_input', 't').status, 'loading');
  await h.receive({ type: 'user_input_result', requestId: 'stale', threadId: 't', result: { ok: false, code: 'STALE' } });
  await h.receive({ type: 'user_input_result', requestId: wire.requestId, threadId: 'other', result: { ok: false, code: 'WRONG_THREAD' } });
  assert.equal(h.api().requestState('send_user_input', 't').status, 'loading');
  await h.advance(25000);
  assert.equal(h.api().requestState('send_user_input', 't').status, 'timeout');
  assert.equal(socket.sent.filter(row => row.type === 'send_user_input').length, 1);
  assert.ok(h.api().userInputs['rpc-input']);
  await h.receive({ type: 'user_input_result', requestId: wire.requestId, threadId: 't', result: { ok: false, code: 'INPUT_UNSUPPORTED' } });
  assert.equal(h.api().requestState('send_user_input', 't').status, 'error');
  assert.equal(h.api().requestState('send_user_input', 't').error, 'INPUT_UNSUPPORTED');
  assert.ok(h.api().userInputs['rpc-input']);
});

for (const mode of ['lan', 'relay'] as const) {
  for (const failure of ['unauthorized', 4401, 4403] as const) {
    test(`${mode} explicit ${failure} clears only failed authentication and stops reconnect until successful authentication`, async () => {
      let raw: string | null = null;
      const pending = createPendingCommandStorage(async () => raw, async value => { raw = value; });
      const h = await sessionHarness({ mode, pending }); await h.ready();
      const namespace = h.api().draftNamespace;
      const draftKey = drafts.scopedDraftKey('t', namespace);
      h.localDrafts.set(draftKey, { text: 'keep draft', pending: [], updatedAt: 1 });
      h.api().sendComposer('t', 'pending original', false); await h.settle();
      assert.equal((await pending.load(namespace)).length, 1);
      if (failure === 'unauthorized') await h.receive(mode === 'relay'
        ? { v: 1, type: 'error', payload: { code: 'unauthorized', message: 'authentication failed' } }
        : { type: 'error', code: 'unauthorized', message: 'authentication failed' });
      else { h.sockets[0].fail(failure); await h.settle(); }
      assert.equal(h.api().conn, 'idle'); assert.equal(h.api().paired, false);
      assert.equal(h.savedSession.authRequired, true);
      assert.equal(h.api().hubId, 'H');
      if (mode === 'lan') assert.equal(h.savedSession.lanPassword, '');
      else {
        assert.equal(h.savedSession.deviceToken, ''); assert.equal(h.savedSession.contentKey, '');
        assert.equal(h.savedSession.lanPassword, 'fake-lan-token', 'other transport credentials are retained');
      }
      assert.equal(h.localDrafts.get(draftKey).text, 'keep draft');
      assert.equal((await pending.load(namespace)).length, 1);
      h.api().reconnect(); await h.foreground(); await h.advance(60000);
      assert.equal(h.sockets.length, 1, 'no timer, foreground or reconnect button may reuse failed auth');
      assert.equal(h.api().error.includes('fake-lan-token'), false);
      assert.equal(h.api().error.includes('fake-relay-token'), false);
      if (mode === 'lan') {
        await assert.rejects(h.api().loginLan('http://localhost:18990', 'bad'));
        await h.settle(); assert.equal(h.sockets.length, 1);
        await h.api().loginLan('http://localhost:18990', 'good');
      } else await h.api().pair('ABC123', 'https://relay.invalid');
      await h.settle();
      assert.equal(h.savedSession.authRequired, false);
      assert.equal(h.sockets.length, 2, 'successful reauthentication explicitly resumes connection');
    });
  }
  test(`${mode} abnormal 1006 keeps credentials and uses 2s then 4s backoff`, async () => {
    const h = await sessionHarness({ mode });
    h.sockets[0].fail(1006); await h.settle();
    assert.equal(h.api().conn, 'reconnecting');
    assert.equal(h.savedSession.authRequired, false);
    assert.equal(h.savedSession.lanPassword, 'fake-lan-token');
    if (mode === 'relay') assert.equal(h.savedSession.deviceToken, 'fake-relay-token');
    await h.advance(1999); assert.equal(h.sockets.length, 1);
    await h.advance(1); assert.equal(h.sockets.length, 2);
    h.sockets[1].fail(1006); await h.settle();
    await h.advance(3999); assert.equal(h.sockets.length, 2);
    await h.advance(1); assert.equal(h.sockets.length, 3);
    assert.equal(h.sessionWrites.some(patch => patch.authRequired === true), false);
  });
}

test('persisted authentication-required marker blocks startup despite retained identity until new login', async () => {
  const h = await sessionHarness({ authRequired: true });
  assert.equal(h.sockets.length, 0); assert.equal(h.api().paired, false);
  h.api().reconnect(); await h.foreground(); await h.advance(60000);
  assert.equal(h.sockets.length, 0);
  await h.api().loginLan('http://localhost:18990', 'good'); await h.settle();
  assert.equal(h.savedSession.authRequired, false); assert.equal(h.sockets.length, 1);
});

test('history merge preserves long prefixes, rejects mismatched revision/content and replaces explicit full snapshots', () => {
  const prev = { ...history.emptyHistory(), rev: 9, full: true, items: Array.from({ length: 3000 }, (_, id) => ({ id: String(id), content: String(id) })) };
  const suffix = history.mergeHistory(prev, { rev: 10, items: [{ id: '2999', content: 'changed' }, { id: '3000', content: 'new' }] });
  assert.equal(suffix.items.length, 3001);
  assert.equal(suffix.items[2999].content, 'changed');
  const mismatch = history.mergeHistory(prev, { rev: 10, delta: { baseRev: 4, newItems: [{ id: 'new' }] } });
  assert.equal(mismatch.rev, 9); assert.equal(mismatch.needsReconcile, true);
  assert.equal(mismatch.items, prev.items);
  const reset = history.mergeHistory(prev, { rev: 1, full: true, items: [] }, { authoritative: true });
  assert.equal(reset.rev, 1); assert.equal(reset.items.length, 0);
  assert.equal(history.mergeHistory(prev, { rev: 1, full: true, items: [] }), prev);
});

test('retry payload retains command identity, client message ID, mode and attachments', () => {
  const item = { id: 'original', clientUserMessageId: 'user-original', threadId: 't', text: 'same', kind: 'message' as const, working: false, mode: 'review' as const, input: [{ type: 'localImage', path: '/image' }] };
  const retry = failed.retryPayload(item);
  assert.equal(retry.requestId, item.id); assert.equal(retry.clientUserMessageId, item.clientUserMessageId);
  assert.equal(retry.mode, item.mode); assert.equal(retry.input, item.input);
});
