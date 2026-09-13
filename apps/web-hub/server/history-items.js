// Rollout compatibility adapter. Keep output records separate so append-only deltas
// can enrich an earlier invocation without changing its position.
const types = { Reasoning: 'reasoning', CommandExecution: 'command_execution', AgentMessage: 'agent_message', McpToolCall: 'mcp_tool_call', UserMessage: 'message', FileChange: 'file_change', ContextCompaction: 'context_compaction', ImageView: 'image_view' };
export function normalizeHistoryItem(payload, timestamp) {
  if (!payload || typeof payload !== 'object') return null;
  const completed = payload.type === 'item_completed';
  const raw = completed ? payload.item : payload;
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type === 'Extension' ? ({ 'web.search': 'web_search', 'image_gen.generation': 'generated_image' }[raw.kind] || 'extension') : (types[raw.type] || raw.type);
  return { ...raw, type, ...(raw.type === 'UserMessage' ? { role: 'user' } : {}), call_id: raw.call_id || raw.callId, timestamp: raw.timestamp || timestamp, turn_id: raw.turn_id || raw.turnId || payload.turn_id || payload.turnId, ...(completed ? { completed: true } : {}) };
}
export function summarizeHistory(items) {
  const files = new Set(), images = new Set();
  const unique = deduplicateHistory(items);
  const patchCalls = new Set(unique.filter(item => ['apply_patch', 'functions.apply_patch'].includes(item.name)).map(item => item.call_id || item.callId));
  for (const [index, item] of unique.entries()) {
    if (item.error || item.isError || item.success === false || /fail|error|denied/.test(item.status || '')) continue;
    if (/_output$/.test(item.type || '') && patchCalls.has(item.call_id || item.callId) && typeof item.output === 'string' && item.output.startsWith('Success. Updated the following files:\n')) {
      const lines = item.output.trim().split('\n').slice(1);
      if (lines.every(line => /^[AMD]:?\s+.+$/.test(line))) for (const line of lines) files.add(line.replace(/^[AMD]:?\s+/, ''));
    }
    if (item.type === 'file_change' || item.type === 'fileChange') {
      for (const change of Array.isArray(item.changes) ? item.changes : [item]) if (change.path) files.add(change.path);
    }
    if (item.type === 'generated_image' || item.type === 'image_generation_call') images.add(item.path || item.output_path || item.id || item.call_id || `record-${index}`);
  }
  return { fileChanges: files.size, generatedImages: images.size };
}

export function historyIdentity(item) {
  const id = item.call_id || item.callId || item.id;
  if (!id) return '';
  const output = /_output$/.test(item.type || '');
  return `${output ? 'output' : 'item'}:${id}`;
}
export function deduplicateHistory(items) {
  const out = [], positions = new Map();
  for (const item of items) {
    const prefix = /_output$/.test(item.type || '') ? 'output' : 'item';
    const keys = [item.id, item.call_id, item.callId].filter(Boolean).map(id => `${prefix}:${id}`);
    const existing = keys.map(key => positions.get(key)).find(i => i !== undefined);
    const i = existing ?? out.length;
    if (existing !== undefined) {
      const previous = out[i];
      out[i] = previous.completed && !item.completed ? { ...item, ...previous } : { ...previous, ...item };
    } else out.push(item);
    for (const key of keys) positions.set(key, i);
  }
  return out;
}
