import type { FailedSend } from './types';
import type { AppMessage } from './protocol';

// A transport retry is the SAME command, never a new user intent.
export function retryPayload(item: Omit<FailedSend, 'error'>): AppMessage {
  return item.kind === 'command'
    ? { type: 'run_command', requestId: item.id, threadId: item.threadId, command: item.text }
    : { type: item.working ? 'send_steer' : 'send_message', requestId: item.id,
      clientUserMessageId: item.clientUserMessageId || item.id, threadId: item.threadId,
      text: item.text, input: item.input, mode: item.mode };
}

// 按 id 移除一条 failedSends 记录：重试、放回输入框、手动删除共用同一数据流，
// 均不重发、不恢复草稿；failedSends 本身不落盘（storage 无持久化），删除后刷新不会复活。
export function removeFailedSend(list: FailedSend[], id: string): FailedSend[] {
  if (!id) return list;
  return list.filter((row) => row.id !== id);
}
