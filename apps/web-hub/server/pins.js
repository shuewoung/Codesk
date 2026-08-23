import fs from 'fs';
import path from 'path';

export function pinKey(kind, id) {
  return `${kind === 'project' ? 'project' : 'thread'}:${id}`;
}

export function normalizePinKind(kind) {
  return kind === 'project' ? 'project' : 'thread';
}

export function normalizePinRecord(item) {
  if (!item || item.id == null || String(item.id).trim() === '') return null;
  const kind = normalizePinKind(item.kind);
  const upd = item.updated_at || (typeof item.at === 'number' ? new Date(item.at).toISOString() : (item.at || ''));
  return {
    id: String(item.id),
    kind,
    pinned: !!item.pinned,
    upd: String(upd || ''),
    source: item.source === 'desktop' ? 'desktop' : (item.source || 'remote'),
  };
}

export function pinRecordToLine(rec) {
  return JSON.stringify({
    id: rec.id,
    kind: rec.kind,
    pinned: !!rec.pinned,
    source: rec.source || 'remote',
    updated_at: rec.upd,
  });
}

export function parsePinsJsonl(content) {
  const map = new Map();
  for (const line of String(content || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = normalizePinRecord(JSON.parse(t));
      if (!rec) continue;
      const key = pinKey(rec.kind, rec.id);
      const prev = map.get(key);
      if (!prev || rec.upd >= (prev.upd || '')) map.set(key, rec);
    } catch {
      /* skip bad line */
    }
  }
  return map;
}

export function loadPinMapFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Map();
    return parsePinsJsonl(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return new Map();
  }
}

export function newerPin(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return (a.upd || '') >= (b.upd || '') ? a : b;
}

export function resolveIsPinned(kind, id, { overrideMap, pinMap, fallback = false } = {}) {
  const key = pinKey(kind, id);
  const ov = overrideMap && overrideMap.get(key);
  if (ov) return !!ov.pinned;
  const side = pinMap && pinMap.get(key);
  if (side) return !!side.pinned;
  return !!fallback;
}

export function resolveProjectIsPinned(project, { overrideMap, pinMap, catalogPinnedIds } = {}) {
  const ids = [];
  if (project && project.id) ids.push(project.id);
  if (project && project.name && project.name !== project.id) ids.push(project.name);
  let best = null;
  for (const id of ids) {
    const key = pinKey('project', id);
    const ov = overrideMap && overrideMap.get(key);
    const side = pinMap && pinMap.get(key);
    best = newerPin(best, newerPin(ov, side));
  }
  if (best) return !!best.pinned;
  return !!(project && project.id && catalogPinnedIds && catalogPinnedIds.has(project.id));
}

function absorbIds(target, map, kind) {
  if (!map) return;
  for (const [key, rec] of map) {
    const recKind = rec.kind || (key.startsWith('project:') ? 'project' : 'thread');
    if (recKind !== kind) continue;
    const id = rec.id || key.slice(key.indexOf(':') + 1);
    if (id) target.add(id);
  }
}

function catalogHas(list, id) {
  if (!list) return false;
  if (typeof list.has === 'function') return list.has(id);
  return Array.isArray(list) && list.includes(id);
}

export function collectDesiredPinIds({ catalogThreadIds = [], catalogProjectIds = [], overrideMap, pinMap } = {}) {
  const threadIds = new Set(catalogThreadIds || []);
  const projectIds = new Set(catalogProjectIds || []);
  absorbIds(threadIds, pinMap, 'thread');
  absorbIds(threadIds, overrideMap, 'thread');
  absorbIds(projectIds, pinMap, 'project');
  absorbIds(projectIds, overrideMap, 'project');
  const threads = [];
  const projects = [];
  for (const id of threadIds) {
    if (resolveIsPinned('thread', id, {
      overrideMap,
      pinMap,
      fallback: catalogHas(catalogThreadIds, id),
    })) threads.push(id);
  }
  for (const id of projectIds) {
    if (resolveIsPinned('project', id, {
      overrideMap,
      pinMap,
      fallback: catalogHas(catalogProjectIds, id),
    })) projects.push(id);
  }
  return { threadIds: threads, projectIds: projects };
}

export function parsePinnedOrderKey(raw) {
  const s = String(raw || '');
  let m = s.match(/^codex:thread:(?:local:)?(.+)$/);
  if (m) return { type: 'thread', id: m[1] };
  m = s.match(/^codex:project:(.+)$/);
  if (m) return { type: 'project', id: m[1] };
  return null;
}

export function pinnedOrderKey(kind, id) {
  return kind === 'project' ? `codex:project:${id}` : `codex:thread:local:${id}`;
}

export function detectJsonIndent(raw) {
  const m = String(raw || '').match(/\n([ \t]+)"/);
  return m ? m[1] : 2;
}

export function applyPinsToGlobalState(data, { threadIds = [], projectIds = [] } = {}) {
  const next = data && typeof data === 'object' ? { ...data } : {};
  const threads = Array.from(new Set(threadIds.filter(Boolean)));
  const projects = Array.from(new Set(projectIds.filter(Boolean)));
  next['pinned-thread-ids'] = threads;
  next['pinned-project-ids'] = projects;
  const atom = { ...(next['electron-persisted-atom-state'] || {}) };
  const prevOrder = Array.isArray(atom['unified-sidebar-pinned-order-v1'])
    ? atom['unified-sidebar-pinned-order-v1']
    : [];
  const wanted = new Set([
    ...threads.map((id) => pinnedOrderKey('thread', id)),
    ...projects.map((id) => pinnedOrderKey('project', id)),
  ]);
  const seen = new Set();
  const kept = [];
  for (const key of prevOrder) {
    const parsed = parsePinnedOrderKey(key);
    if (!parsed) continue;
    const canon = pinnedOrderKey(parsed.type, parsed.id);
    if (!wanted.has(canon) || seen.has(canon)) continue;
    seen.add(canon);
    kept.push(canon);
  }
  for (const id of threads) {
    const canon = pinnedOrderKey('thread', id);
    if (seen.has(canon)) continue;
    seen.add(canon);
    kept.push(canon);
  }
  for (const id of projects) {
    const canon = pinnedOrderKey('project', id);
    if (seen.has(canon)) continue;
    seen.add(canon);
    kept.push(canon);
  }
  atom['unified-sidebar-pinned-order-v1'] = kept;
  next['electron-persisted-atom-state'] = atom;
  return next;
}

export function pinSetsEqual(a, b) {
  const norm = (list) => Array.from(new Set(list || [])).map(String).sort();
  const at = norm(a && a.threadIds);
  const bt = norm(b && b.threadIds);
  const ap = norm(a && a.projectIds);
  const bp = norm(b && b.projectIds);
  return at.join('\0') === bt.join('\0') && ap.join('\0') === bp.join('\0');
}

export function reconcileDesktopPinChange({
  prevThreadIds = null,
  prevProjectIds = null,
  catalogThreadIds = [],
  catalogProjectIds = [],
} = {}) {
  if (prevThreadIds == null || prevProjectIds == null) return [];
  const updates = [];
  const walk = (kind, prevIds, catalogIds) => {
    const prev = new Set(prevIds || []);
    const curr = new Set(catalogIds || []);
    const ids = new Set([...prev, ...curr]);
    for (const id of ids) {
      const was = prev.has(id);
      const now = curr.has(id);
      if (was === now) continue;
      updates.push({ kind, id, pinned: now, source: 'desktop' });
    }
  };
  walk('thread', prevThreadIds, catalogThreadIds);
  walk('project', prevProjectIds, catalogProjectIds);
  return updates;
}

export function atomicWriteFile(filePath, contents) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, contents);
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.copyFileSync(tmp, filePath);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function normalizeArchiveRecord(item) {
  if (!item || item.id == null || String(item.id).trim() === '') return null;
  const upd = item.updated_at || (typeof item.at === 'number' ? new Date(item.at).toISOString() : (item.at || ''));
  return {
    id: String(item.id),
    archived: !!item.archived,
    upd: String(upd || ''),
    source: item.source === 'desktop' ? 'desktop' : (item.source || 'remote'),
  };
}

export function archiveRecordToLine(rec) {
  return JSON.stringify({
    id: rec.id,
    archived: !!rec.archived,
    source: rec.source || 'remote',
    updated_at: rec.upd,
  });
}

export function parseArchivesJsonl(content) {
  const map = new Map();
  for (const line of String(content || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = normalizeArchiveRecord(JSON.parse(t));
      if (!rec) continue;
      const prev = map.get(rec.id);
      if (!prev || rec.upd >= (prev.upd || '')) map.set(rec.id, rec);
    } catch {
      /* skip bad line */
    }
  }
  return map;
}

export function loadArchiveMapFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Map();
    return parseArchivesJsonl(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return new Map();
  }
}

export function resolveIsArchived(id, { overrideMap, archiveMap, fallback = false } = {}) {
  const ov = overrideMap && overrideMap.get(id);
  if (ov) return !!ov.archived;
  const side = archiveMap && archiveMap.get(id);
  if (side) return !!side.archived;
  return !!fallback;
}

export function collectDesiredArchivedIds({ catalogArchivedIds = [], overrideMap, archiveMap } = {}) {
  const ids = new Set(catalogArchivedIds || []);
  if (archiveMap) for (const id of archiveMap.keys()) ids.add(id);
  if (overrideMap) for (const id of overrideMap.keys()) ids.add(id);
  const out = [];
  for (const id of ids) {
    if (resolveIsArchived(id, {
      overrideMap,
      archiveMap,
      fallback: catalogHas(catalogArchivedIds, id),
    })) out.push(id);
  }
  return out;
}

export function reconcileDesktopArchiveChange({
  prevArchivedIds = null,
  catalogArchivedIds = [],
} = {}) {
  if (prevArchivedIds == null) return [];
  const prev = new Set(prevArchivedIds || []);
  const curr = new Set(catalogArchivedIds || []);
  const ids = new Set([...prev, ...curr]);
  const updates = [];
  for (const id of ids) {
    const was = prev.has(id);
    const now = curr.has(id);
    if (was === now) continue;
    updates.push({ id, archived: now, source: 'desktop' });
  }
  return updates;
}
