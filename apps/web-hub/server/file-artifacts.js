import fs from 'node:fs';
import { normalizeHistoryItem, deduplicateHistory } from './history-items.js';
import { fileMetadata } from './file-access.js';

// Only tool results, never assistant prose or tool input. Generic successful reads
// are not creation evidence. Structured output paths or explicit write labels only.
export function artifactOutputPaths(item, { toolName = '' } = {}) {
  if (item?.error || item?.isError || item?.success === false || /fail|error|denied/.test(item?.status || '')) return [];
  if (item?.type === 'generated_image') return [item.path, item.output_path, item.outputPath, item.image_path, ...(Array.isArray(item.outputPaths) ? item.outputPaths : [])].filter(p => typeof p === 'string');
  if (item?.type === 'file_change' && (item.completed || item.status === 'completed') && Array.isArray(item.changes)) return item.changes.filter(c => !/delete/i.test(String(c.kind?.type || c.kind || c.type))).map(c => c.path).filter(p => typeof p === 'string');
  if (!['function_call_output', 'custom_tool_call_output', 'tool_call_output', 'tool_result'].includes(item?.type)) return [];
  if (item.error || item.isError || item.success === false) return [];
  let output = item.output ?? item.result;
  if (toolName === 'apply_patch' || toolName === 'functions.apply_patch') {
    if (typeof output !== 'string') return [];
    const lines = output.trim().split(/\r?\n/);
    if (lines.shift() !== 'Success. Updated the following files:') return [];
    const paths = [];
    for (const line of lines) {
      // Standard apply_patch uses "A path"; some adapters use "A: path".
      const match = line.match(/^([AMD]):?\s+(.+)$/);
      if (!match) return []; // reject mixed success/error or unexpected output
      if (match[1] !== 'D') paths.push(match[2].trim());
    }
    return paths;
  }
  if (typeof output === 'string') { try { output = JSON.parse(output); } catch {} }
  if (output && typeof output === 'object') {
    if (output.error || output.isError || output.success === false || (output.exitCode != null && output.exitCode !== 0)) return [];
    if (!(output.success === true || output.exitCode === 0 || output.status === 'success' || output.status === 'completed')) return [];
    return [output.outputPath, output.output_path, output.savedPath, ...(Array.isArray(output.outputPaths) ? output.outputPaths : [])].filter((p) => typeof p === 'string');
  }
  const text = String(output || '');
  if (!/(?:Process exited with code 0|exit[_ ]?code\s*[:=]\s*0|successfully (?:created|saved|written)|成功(?:保存|生成|写入))/i.test(text)) return [];
  if (/(?:Process exited with code [1-9]|exit[_ ]?code\s*[:=]\s*[1-9]|\b(?:failed|traceback)\b)/i.test(text)) return [];
  const paths = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:(?:successfully\s+)?(?:saved|created|written|output)(?:\s+(?:file|path|to))?|(?:成功)?(?:保存|生成|写入)(?:至|到)?|输出(?:文件|路径)?)\s*[:：]?\s+(.+?)\s*$/i);
    if (match) paths.push(match[1].replace(/^[`'"]|[`'"]$/g, ''));
  }
  return paths;
}

export function collectArtifacts(items, access, { threadId = '' } = {}) {
  const found = new Map();
  items = (items || []).map(item => normalizeHistoryItem(item)).filter(Boolean);
  const calls = new Map();
  for (const item of items) {
    const callId = item.call_id || item.callId;
    if (callId && ['function_call', 'custom_tool_call', 'tool_call'].includes(item.type)) {
      const name = typeof item.name === 'string' ? item.name : '';
      calls.set(callId, calls.has(callId) && calls.get(callId) !== name ? '' : name);
    }
  }
  for (const item of deduplicateHistory(items)) {
    const callId = item?.call_id || item?.callId;
    for (const candidate of artifactOutputPaths(item, { toolName: callId ? calls.get(callId) : '' })) {
      try {
        const full = access.authorize(candidate);
        found.set(full, { ...fileMetadata(full, 'tool_output'), threadId, turnId: item.turnId || null, timestamp: item.timestamp || null, callId: item.call_id || item.callId || item.id || '', evidence: { toolSuccess: true, outputPath: candidate, stat: true } });
      } catch { /* missing or outside workspace is not a deliverable */ }
    }
  }
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 100);
}

export function indexArtifactEntries(entries, coverage = {}) {
  let items = [], turnId = null, startedAt = null, completedAt = null, hasBoundary = false;
  for (const entry of entries) {
    const payload = entry.payload || {};
    const kind = payload.type || entry.type;
    if (kind === 'task_started' || entry.type === 'turn_context') {
      const nextId = payload.turn_id || payload.turnId || null;
      // turn_context may repeat within one known turn; do not drop prior evidence.
      if (!hasBoundary || kind === 'task_started' || (nextId && nextId !== turnId)) {
        items = []; completedAt = null;
        startedAt = entry.timestamp || payload.timestamp || null;
      }
      hasBoundary = true;
      turnId = kind === 'task_started' ? nextId : (nextId || turnId);
    }
    if (kind === 'task_complete' || kind === 'task_completed') completedAt = entry.timestamp || payload.timestamp || null;
    if (entry.type === 'response_item' || entry.type === 'event_msg') {
      const normalized = normalizeHistoryItem(payload, entry.timestamp);
      if (normalized) items.push({ ...normalized, turnId: normalized.turn_id || turnId, timestamp: entry.timestamp || payload.timestamp || null });
    }
  }
  return { items, scope: hasBoundary ? 'latest_turn' : 'session_confirmed', turnId, startedAt, completedAt, coverage };
}

// Bounded tail read, with explicit coverage; never imply a complete session index.
export function readArtifactItems(rolloutPath, maxBytes = 4 * 1024 * 1024) {
  if (!rolloutPath) return indexArtifactEntries([], { truncated: false, bytesRead: 0, totalBytes: 0, unavailable: true });
  let fd;
  try {
    fd = fs.openSync(rolloutPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    let malformed = 0;
    const entries = lines.flatMap((line) => { if (!line.trim()) return []; try { return [JSON.parse(line)]; } catch { malformed++; return []; } });
    return indexArtifactEntries(entries, { truncated: start > 0 || bytesRead < size - start || malformed > 0, bytesRead, totalBytes: size });
  } catch { return indexArtifactEntries([], { truncated: false, bytesRead: 0, totalBytes: 0, unavailable: true }); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
