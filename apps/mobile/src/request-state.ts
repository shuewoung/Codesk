export type RequestState = { type: string; requestId: string; key: string; identity: string; threadId: string; status: 'loading' | 'success' | 'error' | 'timeout'; error?: string; startedAt: number; legacyHistory?: boolean; all?: boolean; reconciliation?: boolean; historyRev?: number };
export const REQUEST_REPLIES: Record<string, string> = { send_user_input: 'user_input_result', query_command: 'command_status', get_execution_state: 'execution_state', handoff_thread: 'handoff_result', queue_message: 'queue_list', list_queue: 'queue_list', cancel_queued_message: 'queue_list', get_draft: 'draft_data', save_draft: 'draft_data', get_git_status: 'git_status', get_git_diff: 'git_diff', get_threads: 'thread_list', get_thread_history: 'thread_history', search_thread: 'search_results', search_workspace: 'workspace_search', get_file: 'file_data', get_workspace_tree: 'workspace_tree', list_artifacts: 'artifacts_list' };
export function requestKey(type: string, threadId = '', path = '') { return `${type}|${threadId}|${path}`; }
export function matchesRequest(state: RequestState, msg: { requestId?: unknown; threadId?: unknown }, identity: string) {
  return (state.status === 'loading' || state.status === 'timeout') && state.identity === identity && msg.requestId === state.requestId && (!state.threadId || msg.threadId === state.threadId);
}
// Only the first history request in a slot can safely accept an old Hub reply.
// After a retry/supersession an ID-less reply cannot be distinguished from stale data.
export function legacyHistoryRequest(states: RequestState[], msg: { type: string; requestId?: unknown; threadId?: unknown; data?: unknown }, identity: string) {
  if (msg.type !== 'thread_history' || msg.requestId || !msg.threadId) return undefined;
  const full = Boolean((msg.data as { full?: boolean } | undefined)?.full);
  const candidates = states.filter(state => state.type === 'get_thread_history' && state.legacyHistory && state.status === 'loading' && state.identity === identity && state.threadId === msg.threadId && Boolean(state.all) === full);
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function safeConnectionDiagnostic(mode: string, conn: string, url: string, pending: number) {
  let endpoint = '';
  try { const parsed = new URL(url); endpoint = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`; } catch { endpoint = '未配置'; }
  return { mode, status: conn, endpoint, pendingRequests: pending };
}
