import fs from 'node:fs';

export const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const ACTIVE_FRESH_MS = 120 * 1000;

export function threadLooksLive(tail, stats, now = Date.now()) {
  if (!tail || !tail.open) return false;
  const mtime = stats && Number(stats.mtimeMs);
  return Number.isFinite(mtime) && now - mtime < ACTIVE_FRESH_MS;
}

export function hasOpenDelegatedAgent(openCalls) {
  if (!openCalls || typeof openCalls.values !== 'function') return false;
  for (const call of openCalls.values()) {
    if (call && call.name === 'add_delegated_agent') return true;
  }
  return false;
}

export function resolveLiveStatus(parsedStatus, {
  hasLiveChildren = false,
  tail = null,
  stats = null,
  now = Date.now(),
} = {}) {
  if (parsedStatus === 'waiting_approval') return 'waiting_approval';
  if (hasLiveChildren || threadLooksLive(tail, stats, now)) return 'working';
  if (parsedStatus === 'working') return 'idle';
  return parsedStatus || 'idle';
}

export function parseThreadSpawn(source) {
  const src = String(source || '').trim();
  if (!src) return null;
  if (src.startsWith('{')) {
    try {
      const obj = JSON.parse(src);
      const sub = obj && obj.subagent;
      if (!sub) return null;
      const spawn = sub.thread_spawn || {};
      return {
        kind: 'subagent',
        parentThreadId: String(spawn.parent_thread_id || ''),
        depth: Number(spawn.depth) || 0,
      };
    } catch {
      /* fall through */
    }
  }
  if (/subagent|thread_spawn|guardian/i.test(src)) return { kind: 'subagent', parentThreadId: '', depth: 0 };
  return null;
}

export function isNonUserThreadRecord(threadSource, source) {
  const ts = String(threadSource || '').trim().toLowerCase();
  if (ts && ts !== 'user') return true;
  const src = String(source || '').trim();
  if (!src || src === 'vscode') return false;
  if (src === 'exec') return true;
  return Boolean(parseThreadSpawn(src)) || src !== 'vscode';
}

export function isApprovalExpired(pending, now = Date.now()) {
  if (!pending) return false;
  const at = Number(pending.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at > APPROVAL_TTL_MS;
}

export function eventKind(entry) {
  if (!entry || typeof entry !== 'object') return 'other';
  const top = entry.type;
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const payloadType = payload.type || top;
  if (
    payloadType === 'task_complete'
    || payloadType === 'turn_completed'
    || top === 'turn_completed'
  ) {
    return 'complete';
  }
  if (payloadType === 'task_started' || payloadType === 'turn_started') return 'start';
  if (
    top === 'item/commandExecution/requestApproval'
    || top === 'item/fileChange/requestApproval'
    || top === 'item/permissions/requestApproval'
  ) {
    return 'approval';
  }
  if (
    payloadType === 'custom_tool_call'
    || payloadType === 'tool_call'
    || payloadType === 'function_call'
    || payloadType === 'reasoning'
    || payloadType === 'agent_reasoning'
  ) {
    return 'working';
  }
  return 'other';
}

export function commandFromFunctionCall(payload) {
  let args = payload && payload.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  const cmd = args && typeof args.cmd === 'string' ? args.cmd : '';
  return String(cmd || payload?.name || '').replace(/[\r\n]+/g, ' ').trim();
}

export function inspectPendingCommand(lines) {
  const open = new Map();
  const list = Array.isArray(lines) ? lines : [];
  for (const raw of list) {
    const text = String(raw || '').trim();
    if (!text) continue;
    let entry;
    try { entry = JSON.parse(text); } catch { continue; }
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
    const type = payload.type || entry.type;
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_call') {
      const callId = String(payload.call_id || payload.callId || payload.id || '');
      if (!callId) continue;
      open.set(callId, {
        id: String(payload.id || callId),
        callId,
        name: payload.name || type,
        command: commandFromFunctionCall(payload),
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_call_output') {
      const callId = String(payload.call_id || payload.callId || payload.id || '');
      if (callId) open.delete(callId);
    }
  }
  const last = [...open.values()].pop() || null;
  return { pending: last, openCount: open.size };
}

export function inspectTailLines(lines) {
  let lastStart = -1;
  let lastComplete = -1;
  let lastApproval = -1;
  let lastWorking = -1;
  const list = Array.isArray(lines) ? lines : [];
  for (let i = 0; i < list.length; i += 1) {
    const text = String(list[i] || '').trim();
    if (!text) continue;
    try {
      const kind = eventKind(JSON.parse(text));
      if (kind === 'start') lastStart = i;
      else if (kind === 'complete') lastComplete = i;
      else if (kind === 'approval') lastApproval = i;
      else if (kind === 'working') lastWorking = i;
    } catch {
      /* ignore truncated jsonl */
    }
  }
  return {
    open: lastStart > lastComplete || lastWorking > lastComplete || lastApproval > lastComplete,
    complete: lastComplete > lastStart && lastComplete >= lastWorking && lastComplete >= lastApproval,
    waitingApproval: lastApproval > lastComplete,
  };
}

export function readRolloutTailLines(filePath, stats, maxBytes = 16384) {
  if (!filePath) return [];
  const size = stats && Number.isFinite(stats.size) ? stats.size : 0;
  const chunkSize = Math.min(maxBytes, size || 0);
  const readPos = Math.max(0, size - chunkSize);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(chunkSize || 1);
    if (chunkSize > 0) fs.readSync(fd, buf, 0, chunkSize, readPos);
    const lines = buf.toString('utf8').split('\n').filter((line) => line.trim());
    if (readPos > 0 && lines.length > 0) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectRolloutTail(filePath, stats) {
  try {
    return inspectTailLines(readRolloutTailLines(filePath, stats));
  } catch {
    return { open: false, complete: false, waitingApproval: false };
  }
}

export function snapshotParseState(state) {
  return {
    ...state,
    tokenUsage: { ...(state.tokenUsage || {}) },
    pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null,
    openCalls: state.openCalls ? new Map(state.openCalls) : new Map(),
  };
}
