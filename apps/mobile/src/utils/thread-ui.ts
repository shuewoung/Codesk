import { groupCommandNodes, type FeedNode } from '../history';
import type { TimelineNode, QueuedMessage, UserInputRequest, UserInputAnswers } from '../types';
import type { RequestState } from '../request-state';

/** Keep existing grouping, but never fold tools from distinct known turns together. */
export function turnAwareFeed(nodes: TimelineNode[]): FeedNode[] {
  const result: FeedNode[] = [];
  let batch: TimelineNode[] = [];
  let turn: string | undefined;
  for (const node of nodes) {
    if (batch.length && ((node.turnId && turn && node.turnId !== turn) || node.kind === 'user')) {
      result.push(...groupCommandNodes(batch));
      batch = [];
      turn = undefined;
    }
    if (node.turnId) turn = node.turnId;
    batch.push(node);
  }
  return [...result, ...groupCommandNodes(batch)];
}

export function stepStatus(status?: string): string {
  switch (status?.toLowerCase()) {
    case 'idle': return '空闲';
    case 'unknown': return '状态未知';
    case 'sent': case 'dispatched': return '已发送';
    case 'waiting_input': return '等待输入';
    case 'completed': case 'success': case 'succeeded': return '已完成';
    case 'running': case 'in_progress': case 'working': return '执行中';
    case 'failed': case 'error': return '失败';
    case 'cancelled': case 'canceled': case 'interrupted': case 'aborted': return '已中断';
    case 'waiting_approval': case 'pending_approval': return '等待审批';
    case 'pending': case 'queued': return '等待执行';
    default: return status || '状态未提供';
  }
}

export function inputSubmissionOutcome(state: Pick<RequestState, 'requestId' | 'status'> | undefined, submittedRequestId?: string): 'waiting' | 'failed' | 'uncertain' {
  if (!submittedRequestId || state?.requestId !== submittedRequestId) return 'waiting';
  if (state.status === 'error') return 'failed';
  if (state.status === 'timeout') return 'uncertain';
  // Success acknowledges receipt; only user_input_resolved removes the card.
  return 'waiting';
}

export function userInputAnswers(request: UserInputRequest, values: Readonly<Record<string, string>>): UserInputAnswers | null {
  const questions = request.payload.questions || [];
  if (!questions.length || questions.some(question => !question.id || !values[question.id]?.trim())) return null;
  if (new Set(questions.map(question => question.id)).size !== questions.length) return null;
  return { answers: Object.fromEntries(questions.map(question => [question.id, { answers: [values[question.id].trim()] }])) };
}

export function queueStatus(status: string): string {
  return status === 'cancelled' || status === 'canceled' ? '已取消' : stepStatus(status);
}

/** Only an acknowledged cancellation of this exact request unlocks the retained input. */
export function isQueueSubmissionCancelled(queue: readonly QueuedMessage[], requestId?: string): boolean {
  if (!requestId) return false;
  const matching = queue.filter(item => item.requestId === requestId);
  return matching.length > 0 && matching.every(item => item.status === 'cancelled' || item.status === 'canceled');
}

export function questionEntries(feed: readonly FeedNode[]) {
  return feed.flatMap((node, index) => node.kind === 'user'
    ? [{ id: node.id, index, title: node.text.trim().replace(/\s+/g, ' ').slice(0, 100) || '附件问题' }]
    : []);
}

export function reviewFilePath(cwd: string, path: string): string {
  if (/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path)) return path;
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`;
}
