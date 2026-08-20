import type { Approval, HistoryItem, Project, Thread, ThreadHistory, TimelineNode } from './types';

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export function collectApprovalIds(pending: { id?: string; ids?: string[]; requestId?: string } | null | undefined): string[] {
  if (!pending) return [];
  return [...new Set(
    [pending.requestId, pending.id, ...(pending.ids || [])]
      .map((v) => (v == null ? '' : String(v)))
      .filter(Boolean),
  )];
}

export function isApprovalExpired(pending: { at?: number } | null | undefined, now = Date.now()): boolean {
  const at = Number(pending?.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at > APPROVAL_TTL_MS;
}

export function decodeApprovalCommand(text: string): string {
  const raw = String(text || '');
  if (!raw) return '';
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (chunk) => {
    try {
      return decodeURIComponent(chunk);
    } catch {
      return chunk;
    }
  });
}

export function emptyHistory(): ThreadHistory {
  return {
    items: [],
    status: 'idle',
    pendingApproval: null,
    activeActionText: '',
    cwd: '',
  };
}

export function mergeHistory(prev: ThreadHistory | undefined, data: unknown): ThreadHistory {
  const incoming = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const delta = incoming.delta && typeof incoming.delta === 'object'
    ? (incoming.delta as { newItems?: HistoryItem[]; baseRev?: number })
    : null;
  const nextItems = Array.isArray(incoming.items) ? (incoming.items as HistoryItem[]) : [];
  const mergedItems =
    delta?.newItems && prev?.items && prev.rev !== undefined && prev.rev === delta.baseRev
      ? prev.items.concat(delta.newItems).slice(-250)
      : nextItems;

  return {
    items: mergedItems,
    status: typeof incoming.status === 'string' ? incoming.status : prev?.status || 'idle',
    pendingApproval:
      incoming.pendingApproval && typeof incoming.pendingApproval === 'object'
        ? (incoming.pendingApproval as ThreadHistory['pendingApproval'])
        : incoming.pendingApproval === null
          ? null
          : prev?.pendingApproval ?? null,
    activeActionText:
      typeof incoming.activeActionText === 'string'
        ? incoming.activeActionText
        : prev?.activeActionText || '',
    cwd: typeof incoming.cwd === 'string' ? incoming.cwd : prev?.cwd || '',
    tokenUsage:
      incoming.tokenUsage && typeof incoming.tokenUsage === 'object'
        ? (incoming.tokenUsage as ThreadHistory['tokenUsage'])
        : prev?.tokenUsage,
    rev: typeof incoming.rev === 'number' ? incoming.rev : prev?.rev,
    totalItems: typeof incoming.totalItems === 'number' ? incoming.totalItems : prev?.totalItems,
    hasMore: typeof incoming.hasMore === 'boolean' ? incoming.hasMore : prev?.hasMore,
  };
}

function itemText(item: HistoryItem): string {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const rec = part as { type?: string; text?: string; output_text?: string };
        if (rec.type === 'input_image' || rec.type === 'image' || rec.type === 'localImage') return '';
        return rec.text || rec.output_text || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof item.text === 'string') return item.text;
  return '';
}

const SKIP_BLOCKS =
  /<(app-context|recommended_plugins|multi_agent_mode|user_instructions|environment_context|system-reminder|system_reminder|oai-mem-citation)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;

function cleanVisibleText(raw: string): string {
  let text = String(raw || '').replace(/\r\n/g, '\n');
  text = text.replace(SKIP_BLOCKS, '');
  text = text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, '');
  text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return '';
  if ((text.startsWith('{') || text.startsWith('[')) && text.length > 80) {
    try {
      JSON.parse(text);
      return '';
    } catch {
      /* keep */
    }
  }
  return text;
}

function parseArgs(item: HistoryItem): Record<string, unknown> | null {
  let args = item.arguments ?? item.input;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
}

function patchStats(text: string): { add: number; del: number; path: string } {
  let add = 0;
  let del = 0;
  let path = '';
  for (const line of String(text || '').split('\n')) {
    const named = line.match(/^\*\*\*\s+(Add|Update|Delete|Rename)\s+File:\s+(.+)/i);
    if (named) path = named[2].trim();
    if (line.startsWith('+') && !line.startsWith('+++')) add += 1;
    if (line.startsWith('-') && !line.startsWith('---')) del += 1;
  }
  return { add, del, path };
}

export function flattenItems(items: HistoryItem[]): TimelineNode[] {
  const out: TimelineNode[] = [];
  let n = 0;
  const skipTypes = new Set([
    'reasoning',
    'agent_reasoning',
    'token_count',
    'function_call_output',
    'custom_tool_call_output',
    'tool_call_output',
  ]);
  for (const item of items || []) {
    const type = item.type || '';
    if (skipTypes.has(type)) continue;
    if (type === 'message') {
      const role = item.role || 'assistant';
      if (role === 'developer') continue;
      const text = cleanVisibleText(itemText(item));
      if (!text) continue;
      if (role === 'user') {
        out.push({ id: `user-${n++}`, kind: 'user', text });
      } else {
        const last = out[out.length - 1];
        if (last && last.kind === 'assistant') last.text = `${last.text}\n\n${text}`;
        else out.push({ id: `assistant-${n++}`, kind: 'assistant', text });
      }
      continue;
    }
    if (type === 'agent_message') {
      const name = String(item.author || item.recipient || '子智能体').replace(/\s+/g, ' ').trim();
      out.push({
        id: `agent-${n++}`,
        kind: 'system',
        text: name ? `${name} 已更新` : '子智能体已更新',
      });
      continue;
    }
    if (type === 'context_compression' || type === 'auto_compressed') {
      out.push({ id: `zip-${n++}`, kind: 'system', text: '上下文已自动压缩' });
      continue;
    }
    const args = parseArgs(item);
    const toolName = String(item.name || item.tool || '');
    const isDiff =
      type === 'fileChange' ||
      type === 'file_change' ||
      type === 'apply_patch' ||
      ['apply_patch', 'apply_delta', 'write_file', 'edit'].includes(toolName);
    if (isDiff) {
      const patch = String(item.patch || args?.patch || args?.diff || args?.delta || '');
      const stats = patchStats(patch);
      const path = String(item.path || args?.path || args?.file || stats.path || '');
      const fileName = path.split(/[\\/]/).filter(Boolean).pop() || '文件';
      out.push({
        id: `diff-${n++}`,
        kind: 'diff',
        text: fileName,
        path,
        add: stats.add,
        del: stats.del,
        patch: patch || undefined,
      });
      continue;
    }
    if (type === 'custom_tool_call' || type === 'tool_call' || type === 'function_call') {
      const cmd = typeof args?.cmd === 'string'
        ? args.cmd
        : typeof args?.command === 'string'
          ? args.command
          : '';
      const label = toolName === 'exec_command' || cmd
        ? (cmd || '命令').replace(/[\r\n]+/g, ' ').slice(0, 80)
        : toolName.replace(/_/g, ' ') || '命令';
      out.push({
        id: `cmd-${n++}`,
        kind: 'command',
        text: label,
      });
    }
  }
  return out;
}

export function parseThreadList(data: unknown): { threads: Thread[]; projects: Project[] } {
  const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const rawThreads = Array.isArray(obj.threads) ? (obj.threads as Thread[]) : [];
  const seen = new Set<string>();
  const threads = rawThreads.filter((t) => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  if (Array.isArray(obj.projects) && obj.projects.length) {
    const projects = (obj.projects as Project[]).map((p) => ({
      ...p,
      name: p.name || '其他项目',
      threads: Array.isArray(p.threads) ? p.threads : [],
    }));
    return { threads, projects };
  }
  const map = new Map<string, Project>();
  for (const t of threads) {
    const name = t.projectName || '其他项目';
    if (!map.has(name)) map.set(name, { name, cwd: t.cwd, threads: [] });
    map.get(name)!.threads.push(t);
  }
  return { threads, projects: Array.from(map.values()) };
}

export function approvalFromHistory(threadId: string, history?: ThreadHistory): Approval | null {
  const pending = history?.pendingApproval;
  if (!pending?.id) return null;
  return {
    requestId: String(pending.id),
    ids: Array.isArray(pending.ids) ? pending.ids.map((v) => String(v)) : [],
    threadId,
    kind: pending.type,
    command: pending.command,
    reason: pending.reason,
    at: typeof pending.at === 'number' ? pending.at : undefined,
    source: 'history',
  };
}

export function approvalFromMessage(msg: Record<string, unknown>): Approval | null {
  const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
  const requestId = msg.requestId == null ? '' : String(msg.requestId);
  if (!threadId || !requestId) return null;
  const at = typeof msg.at === 'number' ? msg.at : Date.now();
  const ids = Array.isArray(msg.ids) ? msg.ids.map((v) => String(v)) : [];
  return {
    requestId,
    ids,
    threadId,
    kind: typeof msg.kind === 'string' ? msg.kind : undefined,
    command: typeof msg.command === 'string' ? msg.command : undefined,
    reason: typeof msg.reason === 'string' ? msg.reason : undefined,
    at,
    source: 'live',
  };
}
