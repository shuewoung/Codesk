import { flattenItems, normalizeTimelineItems } from './history';
import type { CommandStatus, FailedSend, HistoryItem, ThreadHistory } from './types';

export type LocalMessage = {
  id: string;
  threadId: string;
  item: HistoryItem;
  status: CommandStatus;
  // Absolute rollout position, never a count of matching text.
  baseline?: number;
  matched?: string;
};

function offset(history?: ThreadHistory) {
  return history ? Math.max(0, (history.totalItems ?? history.items.length) - history.items.length) : 0;
}
function key(item: HistoryItem, position: number) {
  const normalized = normalizeTimelineItems([item])[0] || item;
  return normalized.id ? `id:${String(normalized.id)}` : `position:${position}`;
}
function signature(item: HistoryItem) {
  const node = flattenItems([item]).find(n => n.kind === 'user');
  // Match source text, not the display cleaner (which strips context blocks).
  const text = typeof item.content === 'string' ? item.content : Array.isArray(item.content)
    ? item.content.map(part => typeof part === 'string' ? part : part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n')
    : String(item.text || '');
  return node ? JSON.stringify([text.replace(/\r\n/g, '\n').trim(), (node.images || []).map(i => i.path || i.uri || ''), (node.attachments || []).map(a => a.path)]) : '';
}
export function createLocalMessage(send: Omit<FailedSend, 'error'>, history?: ThreadHistory): LocalMessage {
  const inputHasText = send.input?.some(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string');
  const content = send.input?.length ? [...(!inputHasText && send.text ? [{ type: 'text', text: send.text }] : []), ...send.input] : send.text;
  return {
    id: send.id, threadId: send.threadId, status: 'pending',
    baseline: history && !history.needsReconcile ? (history.totalItems ?? (history.full ? history.items.length : undefined)) : undefined,
    item: { type: 'message', role: 'user', id: `local:${send.id}`, clientUserMessageId: send.clientUserMessageId || send.id,
      content },
  };
}

// Bind once, one-to-one. Retaining bindings prevents window shifts, ACK races and
// later identical sends from consuming the same canonical user message.
export function reconcileLocalMessages(rows: LocalMessage[], threadId: string, history: ThreadHistory): LocalMessage[] {
  if (history.needsReconcile) return rows;
  const items = history.items.map(item => normalizeTimelineItems([item])[0] || item);
  const start = offset(history);
  const claimed = new Set(rows.filter(r => r.threadId === threadId && r.matched).map(r => r.matched));
  let changed = false;
  const next = rows.map(row => {
    if (row.threadId !== threadId || row.matched) return row;
    const candidates = items.map((item, i) => ({ item, position: start + i, key: key(item, start + i) }))
      .filter(c => c.item.type === 'message' && c.item.role === 'user' && !claimed.has(c.key));
    const clientId = row.item.clientUserMessageId;
    let match = candidates.find(c => c.item.clientUserMessageId === clientId || c.item.id === clientId);
    // Failed sends cannot be inferred from content. An explicit identity can still
    // resolve a history-before-error race. Never match a different explicit ID.
    if (!match && row.status !== 'failed' && row.baseline !== undefined) {
      const expected = signature(row.item);
      match = candidates.find(c => c.position >= row.baseline! && !c.item.clientUserMessageId
        && !rows.some(other => other.threadId === threadId && other.item.clientUserMessageId === c.item.id)
        && expected && signature(c.item) === expected);
    }
    if (!match) return row;
    changed = true; claimed.add(match.key);
    return { ...row, matched: match.key };
  });
  return changed ? next : rows;
}

export function localMessageItems(history: ThreadHistory | undefined, rows: LocalMessage[], threadId: string): HistoryItem[] {
  const items = history?.items || [];
  const start = offset(history);
  // Also reconcile during projection so a new snapshot never paints two bubbles
  // while the Provider's binding effect is waiting to run.
  const local = (history ? reconcileLocalMessages(rows, threadId, history) : rows).filter(r => r.threadId === threadId);
  const result: HistoryItem[] = [];
  const pending = local.filter(r => !r.matched);
  const append = (row: LocalMessage) => result.push({ ...row.item, deliveryStatus: row.status });
  for (let i = 0; i < items.length; i++) {
    // Put an optimistic user message before newly arriving working/tool output.
    for (const row of pending.filter(r => r.baseline !== undefined && r.baseline <= start + i)) append(row);
    for (let j = pending.length - 1; j >= 0; j--) if (pending[j].baseline !== undefined && pending[j].baseline! <= start + i) pending.splice(j, 1);
    const bound = local.find(r => r.matched === key(items[i], start + i));
    result.push(bound ? { ...(normalizeTimelineItems([items[i]])[0] || items[i]), deliveryStatus: bound.status } : items[i]);
  }
  pending.forEach(append);
  return result;
}
