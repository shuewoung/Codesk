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

const LIVE_HISTORY_WINDOW = 250;

const LOCK_HOLDERS = new Set(['desktop', 'desktop-stale', 'hub']);

export function isLockHolder(value: unknown): value is NonNullable<ThreadHistory['lockHolder']> {
  return typeof value === 'string' && LOCK_HOLDERS.has(value);
}

// Banner switch for the thread header: which lock notice (if any) should render.
// Unknown/absent holders render no banner; 'desktop-stale' is treated as its own case
// because the desktop cannot be trusted to take over directly. 'hub' also renders no
// banner — Hub ownership is the web-side steady state, not something to keep nagging about.
export type LockBannerKind = 'desktop' | 'desktop-stale' | null;

export function lockBannerKind(holder: unknown): LockBannerKind {
  if (!isLockHolder(holder)) return null;
  return holder === 'hub' ? null : holder;
}

export function mergeHistory(prev: ThreadHistory | undefined, data: unknown, options: { authoritative?: boolean } = {}): ThreadHistory {
  const incoming = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const delta = incoming.delta && typeof incoming.delta === 'object'
    ? (incoming.delta as { newItems?: HistoryItem[]; baseRev?: number })
    : null;
  const nextItems = Array.isArray(incoming.items) ? (incoming.items as HistoryItem[]) : [];
  const incomingFull = incoming.full === true;
  const prevFull = Boolean(prev?.full);
  const deltaApplies = Boolean(
    delta?.newItems && prev?.items && prev.rev !== undefined && prev.rev === delta.baseRev,
  );

  // Never advance a revision while retaining content from another revision.
  const authoritative = options.authoritative === true && incomingFull && Array.isArray(incoming.items);
  if (!authoritative && prev?.rev !== undefined && typeof incoming.rev === 'number' && incoming.rev < prev.rev) return prev;
  let mergedItems: HistoryItem[];
  let full = prevFull;
  let needsReconcile = false;
  if (authoritative) {
    mergedItems = nextItems;
    full = true;
  } else if (deltaApplies) {
    const combined = prev!.items.concat(delta!.newItems!);
    full = prevFull || incomingFull;
    mergedItems = full ? combined : combined.slice(-LIVE_HISTORY_WINDOW);
  } else if (prev?.items?.length && nextItems.length && nextItems.length < prev.items.length) {
    // A bounded snapshot is a suffix, not a replacement for already loaded pages.
    // Find a verified overlap; item IDs also allow the live tail to change in place.
    const same = (a: HistoryItem, b: HistoryItem) => a.id && b.id
      ? a.id === b.id : JSON.stringify(a) === JSON.stringify(b);
    const offset = prev.items.findIndex(item => same(item, nextItems[0]));
    const overlap = offset < 0 ? 0 : Math.min(prev.items.length - offset, nextItems.length);
    const valid = overlap > 0 && nextItems.slice(0, overlap).every((item, i) => same(prev.items[offset + i], item));
    if (valid) mergedItems = prev.items.slice(0, offset).concat(nextItems);
    else { mergedItems = prev.items; needsReconcile = true; }
    full = prevFull;
  } else if (!nextItems.length && prev?.items?.length && (delta || !incomingFull)) {
    mergedItems = prev.items;
    full = prevFull;
    needsReconcile = typeof incoming.rev === 'number' && incoming.rev !== prev.rev;
  } else if (incomingFull) {
    mergedItems = nextItems;
    full = true;
  } else {
    mergedItems = nextItems;
    full = incomingFull;
  }

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
    lockHolder: isLockHolder(incoming.lockHolder)
      ? incoming.lockHolder
      : incoming.lockHolder === null
        ? null
        : prev?.lockHolder ?? null,
    subagents: Array.isArray(incoming.subagents)
      ? incoming.subagents as ThreadHistory['subagents']
      : prev?.subagents,
    tokenUsage:
      incoming.tokenUsage && typeof incoming.tokenUsage === 'object'
        ? (incoming.tokenUsage as ThreadHistory['tokenUsage'])
        : prev?.tokenUsage,
    needsReconcile,
    branch: typeof incoming.branch === 'string' ? incoming.branch : prev?.branch,
    executionLocation: typeof incoming.executionLocation === 'string' ? incoming.executionLocation : prev?.executionLocation,
    rev: needsReconcile ? prev?.rev : typeof incoming.rev === 'number' ? incoming.rev : prev?.rev,
    totalItems: typeof incoming.totalItems === 'number' ? incoming.totalItems : prev?.totalItems,
    hasMore: prevFull && !incomingFull ? prev?.hasMore : typeof incoming.hasMore === 'boolean' ? incoming.hasMore : prev?.hasMore,
    full,
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

function itemImages(item: HistoryItem): TimelineNode['images'] {
  const parts = Array.isArray(item.content) ? item.content : [];
  const images: NonNullable<TimelineNode['images']> = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const rec = part as { type?: string; image_url?: string; url?: string; path?: string; name?: string };
    if (rec.type !== 'input_image' && rec.type !== 'image' && rec.type !== 'localImage') continue;
    images.push({
      uri: rec.image_url || rec.url,
      path: rec.path,
      name: rec.name,
    });
  }
  return images.length ? images : undefined;
}

function reasoningItemText(item: HistoryItem): string {
  const s = item.summary ?? item.content ?? item.text;
  if (typeof s === 'string') return cleanVisibleText(s);
  if (Array.isArray(s)) {
    return cleanVisibleText(
      s.map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const rec = part as { text?: string; content?: string };
        return rec.text || rec.content || '';
      }).filter(Boolean).join('\n'),
    );
  }
  if (s && typeof s === 'object') {
    const rec = s as { text?: string; content?: string };
    return cleanVisibleText(rec.text || rec.content || '');
  }
  return '';
}

const SKIP_BLOCKS =
  /<(app-context|recommended_plugins|multi_agent_mode|user_instructions|environment_context|system-reminder|system_reminder|oai-mem-citation)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;

// 流式更新每次都会重跑 flattenItems，同一段文本会被反复清洗；
// 按原文缓存清洗结果，超出上限整体清空（简单且足够）。
const cleanTextCache = new Map<string, string>();
const CLEAN_TEXT_CACHE_MAX = 500;

function cleanVisibleText(raw: string): string {
  const key = String(raw || '');
  if (!key) return '';
  const cached = cleanTextCache.get(key);
  if (cached !== undefined) return cached;
  let text = key.replace(/\r\n/g, '\n');
  text = text.replace(SKIP_BLOCKS, '');
  text = text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (cleanTextCache.size >= CLEAN_TEXT_CACHE_MAX) cleanTextCache.clear();
  cleanTextCache.set(key, text);
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

export function extractActualCommand(raw: unknown): string {
  if (!raw) return '';
  const str = String(raw).trim();
  const m = str.match(/tools\.(?:exec_command|exec)\(\s*\{[\s\S]*?cmd\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/i);
  if (m) {
    let inner = m[1] || m[2] || '';
    try {
      inner = JSON.parse(`"${inner}"`);
    } catch {
      inner = inner.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    return inner.trim();
  }
  if (str.startsWith('{') && str.endsWith('}')) {
    try {
      const parsed = JSON.parse(str) as { cmd?: string; command?: string };
      if (parsed && (parsed.cmd || parsed.command)) return String(parsed.cmd || parsed.command).trim();
    } catch {
      /* ignore */
    }
  }
  return str;
}

function cleanAgentName(name: string): string {
  let clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean === '子智能体' || clean === 'agent' || clean.toLowerCase() === 'main writer' || /^[a-f0-9-]{24,}$/i.test(clean)) {
    return '子智能体';
  }
  clean = clean.split(/[\\/]/).pop() || clean;
  return clean.replace(/_/g, ' ').trim();
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function getItemStableId(item: HistoryItem, fallbackType: string, index: number): string {
  if (item && typeof item.id === 'string' && item.id.trim()) return item.id.trim();
  if (item && typeof item.call_id === 'string' && item.call_id.trim()) return item.call_id.trim();
  const ts = item?.timestamp || item?.created_at || (item as Record<string, unknown>)?.turn || '';
  const textSample = itemText(item).slice(0, 40);
  const h = Math.abs(hashString(`${fallbackType}_${ts}_${textSample}`));
  return `${fallbackType}-${h}-${index}`;
}

// A last reply is evidence, not proof that the user's task succeeded.
export function resultSummary(history?: ThreadHistory): { status: string; reply: string } {
  if (!history) return { status: '尚无结果', reply: '' };
  const lastUser = history.items.reduce((last, item, i) => item.role === 'user' ? i : last, -1);
  const replies = history.items.slice(lastUser + 1).filter(item =>
    (item.type === 'message' && item.role === 'assistant' && item.channel !== 'analysis' && item.channel !== 'commentary') ||
    (item.type === 'agent_message' && !item.author && !item.recipient));
  const reply = replies.length ? cleanVisibleText(itemText(replies[replies.length - 1])).slice(0, 500) : '';
  const status = history.status === 'working' ? '仍在运行' : history.status === 'waiting_approval' ? '等待审批' : /error|fail/.test(history.status) ? '执行异常' : reply ? '最新答复（请核对结果）' : '尚无本轮末答复';
  return { status, reply };
}

export function normalizeTimelineItems(items: HistoryItem[]): HistoryItem[] {
  const types: Record<string, string> = { Reasoning: 'reasoning', CommandExecution: 'command_execution', AgentMessage: 'agent_message', McpToolCall: 'mcp_tool_call', UserMessage: 'message', FileChange: 'file_change', ContextCompaction: 'context_compaction', ImageView: 'image_view' };
  const out: HistoryItem[] = [], positions = new Map<string, number>();
  for (const entry of items) {
    const wrapped = entry.type === 'item_completed';
    const raw = (wrapped ? entry.item : entry) as HistoryItem;
    if (!raw || typeof raw !== 'object') continue;
    const item: HistoryItem = { ...raw, type: types[raw.type || ''] || raw.type, ...(raw.type === 'UserMessage' ? { role: 'user' } : {}), ...(wrapped ? { completed: true } : {}) };
    if (raw.type === 'Extension') item.type = raw.kind === 'web.search' ? 'web_search' : raw.kind === 'image_gen.generation' ? 'generated_image' : 'extension';
    const keys = [item.id, item.call_id, item.callId].filter(Boolean).map(id => `${/_output$/.test(item.type || '') ? 'output' : 'item'}:${id}`);
    const pos = keys.map(key => positions.get(key)).find(i => i !== undefined);
    const index = pos ?? out.length;
    if (pos !== undefined) out[pos] = out[pos].completed && !item.completed ? { ...item, ...out[pos] } : { ...out[pos], ...item };
    else out.push(item);
    for (const key of keys) positions.set(key, index);
  }
  const outputs = new Map(out.filter(i => /_output$/.test(i.type || '')).map(i => [String(i.call_id || i.callId || i.id || ''), i]));
  return out.map(i => {
    const result = !/_output$/.test(i.type || '') && outputs.get(String(i.call_id || i.callId || i.id || ''));
    if (!result) return i;
    let payload = result.output ?? result.content;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* keep text */ } }
    const structured = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const failed = result.isError || result.success === false || structured.isError || structured.success === false || structured.error || (typeof structured.exit_code === 'number' && structured.exit_code !== 0) || (typeof structured.exitCode === 'number' && structured.exitCode !== 0);
    return { ...i, output: result.output ?? result.content, status: result.status ?? (failed ? 'failed' : i.status), error: result.error ?? structured.error ?? (failed ? true : i.error) };
  });
}

function boundedOutput(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 16000 ? `${text.slice(0, 16000)}\n[输出已截断]` : text;
}

export function flattenItems(items: HistoryItem[]): TimelineNode[] {
  items = normalizeTimelineItems(items || []);
  const out: TimelineNode[] = [];
  const skipTypes = new Set([
    'token_count',
    'function_call_output',
    'custom_tool_call_output',
    'tool_call_output',
  ]);
  let idx = 0;
  for (const item of items || []) {
    idx++;
    const type = item.type || '';
    if (skipTypes.has(type)) {
      if (/_output$/.test(type) && (item.error || /fail|error|denied/.test(String(item.status || '')))) {
        const callId = item.call_id || item.callId;
        if (!callId || !items.some(other => !/_output$/.test(other.type || '') && (other.call_id || other.callId) === callId)) out.push({ id: getItemStableId(item, 'error', idx), kind: 'command', important: true, text: '工具执行异常', output: boundedOutput(item.error || item.output) });
      }
      continue;
    }
    const status = String(item.status || '');
    const important = Boolean(item.error || item.isError || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0) || (typeof item.exit_code === 'number' && item.exit_code !== 0)) || /error|fail|approval|denied/i.test(status) || /error|approval/.test(type);
    const common = { id: getItemStableId(item, type, idx), status, important, turnId: String(item.turn_id || item.turnId || ''), output: boundedOutput(item.output ?? item.aggregated_output ?? item.aggregatedOutput ?? item.result ?? item.error) };
    if (type === 'generated_image' || type === 'image_view' || type === 'image_generation_call') {
      const result = typeof item.result === 'string' ? item.result : '';
      const path = String(item.path || item.image_path || item.imagePath || item.output_path || item.outputPath || (/^(?:\/|[a-z]:[\\/])/i.test(result) ? result : ''));
      const uri = String(item.url || (/^data:image\//.test(result) ? result : result.length > 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(result) ? `data:image/png;base64,${result}` : ''));
      const images = [...(path || uri ? [{ path: path || undefined, uri: uri || undefined }] : []), ...(Array.isArray(item.outputPaths) ? item.outputPaths.filter(p => typeof p === 'string').map(p => ({ path: String(p) })) : [])];
      if (images.length || important) out.push({ ...common, kind: type === 'image_view' ? 'image-view' : 'generated-image', text: type === 'image_view' ? '查看图片' : '生成图片', path, images: images.length ? images : undefined });
      continue;
    }
    if (type === 'web_search' || type === 'web_search_call') {
      out.push({ ...common, kind: 'search', searchResults: Array.isArray(item.results) ? (item.results as Record<string, unknown>[]).filter(r => typeof r?.url === 'string' && /^https?:\/\//i.test(r.url)).slice(0, 20).map(r => ({ title: String(r.title || r.url), url: String(r.url) })) : undefined, text: String(item.query || (item.action as Record<string, unknown>)?.query || '网页搜索'), output: boundedOutput(item.results || item.action || item.output || item.result) });
      continue;
    }
    if (type === 'context_compaction') { out.push({ ...common, kind: 'compaction', text: itemText(item) || '上下文已压缩' }); continue; }
    if (type === 'command_execution' || type === 'mcp_tool_call' || important) {
      out.push({ ...common, kind: 'command', text: String(item.command || item.tool || item.name || itemText(item) || type), command: String(item.command || '') });
      continue;
    }
    if ((type === 'file_change' || type === 'fileChange') && Array.isArray(item.changes)) {
      for (const [n, change] of (item.changes as Record<string, unknown>[]).entries()) {
        const patch = String(change.diff || change.patch || '');
        const path = String(change.path || '');
        if (!path && !patch) continue;
        out.push({ ...common, id: `${common.id}-${n}`, kind: 'diff', text: `${typeof change.kind === 'object' && change.kind ? (change.kind as Record<string, unknown>).type || '修改' : change.kind || change.type || '修改'} ${path}`, patch, ...patchStats(patch), ...(path ? { path } : {}) });
      }
      continue;
    }
    if (type === 'reasoning' || type === 'agent_reasoning') {
      const text = reasoningItemText(item);
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.kind === 'reasoning') last.text = `${last.text}\n\n${text}`;
      else out.push({ id: getItemStableId(item, 'reasoning', idx), kind: 'reasoning', text });
      continue;
    }
    if (type === 'message') {
      const role = item.role || 'assistant';
      if (role === 'developer') continue;
      const text = cleanVisibleText(itemText(item));
      const images = role === 'user' ? itemImages(item) : undefined;
      const attachments = role === 'user' && Array.isArray(item.content)
        ? item.content.filter(part => part && typeof part === 'object' && ['mention', 'skill'].includes(part.type) && typeof part.path === 'string')
          .map(part => ({ name: String(part.name || part.path), path: String(part.path) })) : undefined;
      if (!text && !images?.length && !attachments?.length) continue;
      if (role === 'user') {
        const trimmed = text.trim();
        let callback: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
          // Generic status/completed fields are normal user JSON, not callback evidence.
          if (parsed && !Array.isArray(parsed) && typeof parsed.agent_path === 'string'
            && parsed.agent_path && ('status' in parsed || 'completed' in parsed || 'output' in parsed)) callback = parsed;
        } catch { /* ordinary text */ }
        if (callback) {
          const statusObj = callback.status && typeof callback.status === 'object' ? callback.status as Record<string, unknown> : null;
          const completedText = statusObj?.completed || callback.completed || callback.output;
          if (typeof completedText === 'string' && completedText) {
            const last = out[out.length - 1];
            if (last && last.kind === 'assistant') last.text = `${last.text}\n\n${completedText}`;
            else out.push({ id: getItemStableId(item, 'assistant', idx), kind: 'assistant', text: completedText });
          }
          continue;
        }
        out.push({
          id: getItemStableId(item, 'user', idx),
          kind: 'user',
          deliveryStatus: item.deliveryStatus as TimelineNode['deliveryStatus'],
          attachments: attachments?.length ? attachments : undefined,
          text: text || (images?.length ? '[图片]' : ''),
          images,
        });
      } else {
        const last = out[out.length - 1];
        if (last && last.kind === 'assistant') last.text = `${last.text}\n\n${text}`;
        else out.push({ id: getItemStableId(item, 'assistant', idx), kind: 'assistant', text });
      }
      continue;
    }
    if (type === 'agent_message') {
      const metadata = item.inter_agent_communication_metadata as Record<string, unknown> | undefined;
      if (metadata) {
        const threadId = String(metadata.sender_thread_id || metadata.agent_thread_id || metadata.thread_id || '');
        out.push({ ...common, kind: 'agent', threadId: threadId || undefined, text: String(metadata.title || metadata.agent_name || itemText(item) || '子智能体'), status: String(metadata.status || 'unknown'), model: typeof metadata.model === 'string' ? metadata.model : undefined });
        continue;
      }
      const author = item.author ? String(item.author).trim() : '';
      const recipient = item.recipient ? String(item.recipient).trim() : '';
      // 仅当明确存在子智能体身份时才作为子智能体动态节点
      if (!author && !recipient) {
        const text = cleanVisibleText(itemText(item));
        if (text) {
          const last = out[out.length - 1];
          if (last && last.kind === 'assistant') last.text = `${last.text}\n\n${text}`;
          else out.push({ id: getItemStableId(item, 'assistant', idx), kind: 'assistant', text });
        }
        continue;
      }
      const rawName = author || recipient;
      const name = cleanAgentName(rawName);
      const text = name === '子智能体' ? '子智能体已更新' : `子智能体「${name}」已更新`;
      out.push({
        id: getItemStableId(item, 'agent', idx),
        kind: 'agent',
        text,
      });
      continue;
    }
    if (type === 'context_compression' || type === 'auto_compressed') {
      out.push({ id: getItemStableId(item, 'zip', idx), kind: 'system', text: '上下文已自动压缩' });
      continue;
    }
    const args = parseArgs(item);
    const toolName = String(item.name || item.tool || '').replace(/^functions\./, '');
    const rawCmd = typeof args?.cmd === 'string'
      ? args.cmd
      : typeof args?.command === 'string'
        ? args.command
        : typeof item.input === 'string'
          ? item.input
          : '';

    // Multi-agent spawn / close / wait detection
    if (toolName.includes('spawn_agent') || rawCmd.includes('spawn_agent')) {
      out.push({ id: getItemStableId(item, 'agent-spawn', idx), kind: 'system', text: '已创建 1 个智能体' });
      continue;
    }
    if (toolName.includes('close_agent') || rawCmd.includes('close_agent')) {
      out.push({ id: getItemStableId(item, 'agent-close', idx), kind: 'system', text: '已关闭 1 个智能体' });
      continue;
    }
    if (toolName.includes('wait_agent') || rawCmd.includes('wait_agent') || toolName === 'wait') {
      continue; // suppress wait noise
    }
    if (toolName.includes('skill') || rawCmd.includes('SKILL.md') || rawCmd.includes('short-drama-factory') || (typeof args?.path === 'string' && args.path.includes('skill'))) {
      let skillName = '';
      const m = rawCmd.match(/([a-zA-Z0-9_-]+)[\\/]SKILL\.md/i) || rawCmd.match(/skill[s]?[\\/]([a-zA-Z0-9_-]+)/i) || rawCmd.match(/short-drama-factory/i);
      if (m) {
        const captured = m[0].includes('short-drama-factory') ? 'Short Drama Factory' : m[1];
        if (captured && captured.toLowerCase() !== 'skill') skillName = captured;
      }
      out.push({ id: getItemStableId(item, 'skill', idx), kind: 'system', text: skillName ? `已读取 ${skillName} 技能` : '已读取技能' });
      continue;
    }

    const isDiff =
      type === 'fileChange' ||
      type === 'file_change' ||
      type === 'apply_patch' ||
      ['apply_patch', 'apply_delta', 'write_file', 'edit'].includes(toolName);
    if (isDiff) {
      const patch = String(item.patch || args?.patch || args?.diff || args?.delta || (toolName === 'apply_patch' && typeof item.input === 'string' ? item.input : '') || '');
      const blocks = patch.split(/(?=^\*\*\* (?:Add|Update|Delete|Rename) File:)/m).filter(block => /^\*\*\* (?:Add|Update|Delete|Rename) File:/.test(block));
      if (blocks.length > 1) {
        for (const [n, block] of blocks.entries()) {
          const stats = patchStats(block);
          out.push({ ...common, id: `${common.id}-${n}`, kind: 'diff', text: stats.path, patch: block, ...stats });
        }
        continue;
      }
      const stats = patchStats(patch);
      const path = String(item.path || args?.path || args?.file || stats.path || '');
      const fileName = path.split(/[\\/]/).filter(Boolean).pop() || '文件';
      out.push({
        id: getItemStableId(item, 'diff', idx),
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
      const actual = extractActualCommand(rawCmd);
      let firstLine = actual.split(/[\r\n]+/)[0].trim().replace(/^\$\s*/, '');
      if (firstLine.startsWith('const r = await tools.')) {
        firstLine = firstLine.replace(/^const r = await tools\.[a-zA-Z0-9_]+\(\{?/, '').trim();
      }
      if (firstLine.length > 70) firstLine = firstLine.slice(0, 67) + '...';
      const label = firstLine ? `exec ${firstLine}` : '运行了命令';
      out.push({
        id: getItemStableId(item, 'cmd', idx),
        kind: 'command',
        text: label,
        command: actual || rawCmd,
        output: common.output,
        status,
        important,
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

export type CommandGroup = {
  kind: 'cmd-group';
  id: string;
  commands: TimelineNode[];
};

export type AgentGroup = {
  kind: 'agent-group';
  id: string;
  agents: TimelineNode[];
};

export type FeedNode = TimelineNode | CommandGroup | AgentGroup;

export function groupCommandNodes(nodes: TimelineNode[]): FeedNode[] {
  const out: FeedNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'command' && !n.important) {
      const last = out[out.length - 1];
      if (last && last.kind === 'cmd-group') {
        last.commands.push(n);
      } else {
        out.push({ kind: 'cmd-group', id: `g-${n.id}`, commands: [n] });
      }
      continue;
    }
    if (n.kind === 'agent') {
      const last = out[out.length - 1];
      if (last && last.kind === 'agent-group') {
        last.agents.push(n);
      } else {
        out.push({ kind: 'agent-group', id: `ag-${n.id}`, agents: [n] });
      }
      continue;
    }
    out.push(n);
  }
  return out;
}

export function commandGroupCounts(commands: TimelineNode[]): { label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const c of commands) {
    const label = String(c.text || 'exec').split('\n')[0].trim() || 'exec';
    map.set(label, (map.get(label) || 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count }));
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
