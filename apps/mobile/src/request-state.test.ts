import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRequest, legacyHistoryRequest, requestKey, REQUEST_REPLIES, safeConnectionDiagnostic, type RequestState } from './request-state';

const request: RequestState = { type: 'get_file', key: requestKey('get_file', 'thread-a', '/same'), requestId: 'new', identity: 'identity-a', threadId: 'thread-a', status: 'loading', startedAt: 10 };
test('responses require request, thread, identity and pending state', () => {
  assert.equal(matchesRequest(request, { requestId: 'new', threadId: 'thread-a' }, 'identity-a'), true);
  for (const msg of [{ requestId: 'old', threadId: 'thread-a' }, { requestId: 'new', threadId: 'thread-b' }, { requestId: 'new' }, {}]) assert.equal(matchesRequest(request, msg, 'identity-a'), false);
  assert.equal(matchesRequest(request, { requestId: 'new', threadId: 'thread-a' }, 'identity-b'), false);
  assert.equal(matchesRequest({ ...request, status: 'timeout' }, { requestId: 'new', threadId: 'thread-a' }, 'identity-a'), true);
  assert.equal(matchesRequest({ ...request, status: 'timeout' }, { requestId: 'old', threadId: 'thread-a' }, 'identity-a'), false);
  for (const status of ['success', 'error'] as const) assert.equal(matchesRequest({ ...request, status }, { requestId: 'new', threadId: 'thread-a' }, 'identity-a'), false);
});
test('legacy history accepts only one first pending request with matching identity/thread/window', () => {
  const pending = { ...request, type: 'get_thread_history', legacyHistory: true, all: false };
  const msg = { type: 'thread_history', threadId: 'thread-a', data: { full: false } };
  assert.equal(legacyHistoryRequest([pending], msg, 'identity-a'), pending);
  for (const bad of [{ ...msg, threadId: 'thread-b' }, { ...msg, requestId: 'old' }, { ...msg, type: 'file_data' }, { ...msg, data: { full: true } }]) assert.equal(legacyHistoryRequest([pending], bad, 'identity-a'), undefined);
  assert.equal(legacyHistoryRequest([pending], msg, 'identity-b'), undefined);
  assert.equal(legacyHistoryRequest([pending, pending], msg, 'identity-a'), undefined);
  for (const state of [{ ...pending, legacyHistory: false }, ...(['success', 'error', 'timeout'] as const).map(status => ({ ...pending, status }))]) assert.equal(legacyHistoryRequest([state], msg, 'identity-a'), undefined);
});

test('request keys isolate threads and file paths; latest search shares one slot', () => {
  assert.notEqual(requestKey('get_file', 'a', '/same'), requestKey('get_file', 'b', '/same'));
  assert.notEqual(requestKey('get_file', 'a', '/first'), requestKey('get_file', 'a', '/second'));
  assert.equal(requestKey('search_thread', 'a'), 'search_thread|a|');
});
test('reply names match Hub request handlers, not broadcast history updates', () => {
  assert.equal(REQUEST_REPLIES.get_thread_history, 'thread_history');
  assert.equal(REQUEST_REPLIES.search_workspace, 'workspace_search');
  assert.equal(REQUEST_REPLIES.search_thread, 'search_results');
  assert.equal(Object.values(REQUEST_REPLIES).includes('thread_update'), false);
});
test('diagnostics cannot include credentials, path, query or hash', () => {
  const result = safeConnectionDiagnostic('lan', 'connected', 'https://user:secret@example.com:8787/private?token=hidden#hk=key', 2);
  assert.deepEqual(result, { mode: 'lan', status: 'connected', endpoint: 'https://example.com:8787', pendingRequests: 2 });
  assert.equal(safeConnectionDiagnostic('', 'idle', 'not a url?password=secret', 0).endpoint, '未配置');
});
