// Never infer destructive recovery eligibility from an error message or a missing thread ID.
export function writerLockErrorCode(threadId: string | undefined, feedback: { threadId?: unknown; code?: unknown }) {
  if (!threadId || feedback.threadId !== threadId) return undefined;
  return feedback.code === 'writer_lock_conflict' || feedback.code === 'writer_owner_unknown'
    ? feedback.code : undefined;
}

export type ComposerPending = {
  name: string;
  path: string;
  image: boolean;
  skill?: boolean;
  source?: 'device' | 'host' | 'skill';
  taskId?: string;
};

export type ComposerDraft = {
  text: string;
  pending: ComposerPending[];
  updatedAt: number;
  sending?: boolean;
};

export function canSubmitComposer(state: { connected: boolean; composing?: boolean; sending?: boolean; uploading?: boolean; approval?: boolean; quotaExhausted?: boolean }) {
  return state.connected && !state.composing && !state.sending && !state.uploading && !state.approval && !state.quotaExhausted;
}

export function draftNamespace(connection: { mode?: string; hubId?: string; lanUrl?: string; relayUrl?: string }): string {
  const mode = connection.mode || '';
  if (!mode) return '';
  if (connection.hubId) return JSON.stringify(['hub', connection.hubId]);
  return legacyDraftNamespace(connection);
}

export function legacyDraftNamespace(connection: { mode?: string; hubId?: string; lanUrl?: string; relayUrl?: string }): string {
  const mode = connection.mode || '';
  let origin = '';
  try { origin = new URL(mode === 'lan' ? connection.lanUrl || '' : connection.relayUrl || '').origin; } catch { /* no valid host */ }
  if (mode === 'relay' && connection.hubId) return JSON.stringify(['relay', origin, connection.hubId]);
  return origin ? JSON.stringify([mode, origin]) : '';
}
export function scopedDraftKey(threadId: string, namespace: string): string {
  return namespace && threadId ? JSON.stringify(['draft-v2', namespace, threadId]) : '';
}

export const MAX_DRAFT_THREADS = 40;
export const MAX_DRAFT_CHARS = 100_000;

export function pendingFromComposerInput(input?: unknown[]): ComposerPending[] {
  if (!Array.isArray(input)) return [];
  const out: ComposerPending[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { type?: string; name?: string; path?: string };
    const type = String(item.type || '');
    const path = String(item.path || '').trim();
    if (!path) continue;
    if (type === 'localImage') {
      out.push({ name: String(item.name || 'image'), path, image: true });
    } else if (type === 'skill') {
      out.push({ name: String(item.name || 'skill'), path, image: false, skill: true });
    } else if (type === 'mention') {
      out.push({ name: String(item.name || 'file'), path, image: false });
    }
  }
  return out;
}

export function normalizePending(raw: unknown): ComposerPending[] {
  if (!Array.isArray(raw)) return [];
  const out: ComposerPending[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as ComposerPending;
    const path = String(row.path || '').trim();
    if (!path) continue;
    out.push({
      name: String(row.name || 'file'),
      path,
      image: Boolean(row.image),
      skill: row.skill ? true : undefined,
      source: row.source === 'device' || row.source === 'host' || row.source === 'skill' ? row.source : undefined,
      taskId: typeof row.taskId === 'string' ? row.taskId : undefined,
    });
  }
  return out;
}

export function normalizeDraft(raw: unknown): ComposerDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<ComposerDraft>;
  const text = typeof row.text === 'string' ? row.text : '';
  const pending = normalizePending(row.pending);
  if (!text && !pending.length && !row.sending) return null;
  const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
  return {
    text: text.slice(0, MAX_DRAFT_CHARS),
    pending,
    updatedAt,
    sending: row.sending ? true : undefined,
  };
}

export function isDraftEmpty(draft: ComposerDraft | null | undefined): boolean {
  if (!draft) return true;
  return !draft.text.trim() && !draft.pending.length && !draft.sending;
}

export function upsertDraft(
  map: Record<string, ComposerDraft>,
  threadId: string,
  draft: ComposerDraft | null,
): Record<string, ComposerDraft> {
  const id = String(threadId || '').trim();
  if (!id) return map;
  const next: Record<string, ComposerDraft> = { ...map };
  if (isDraftEmpty(draft)) delete next[id];
  else if (draft) next[id] = { ...draft, text: draft.text.slice(0, MAX_DRAFT_CHARS) };
  const ids = Object.keys(next).sort((a, b) => (next[b].updatedAt || 0) - (next[a].updatedAt || 0));
  for (const extra of ids.slice(MAX_DRAFT_THREADS)) delete next[extra];
  return next;
}

export function parseDraftMap(raw: string | null): Record<string, ComposerDraft> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, ComposerDraft> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const draft = normalizeDraft(value);
      if (draft) out[id] = draft;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadComposerDraftFromMap(map: Record<string, ComposerDraft>, threadId: string): ComposerDraft | null {
  const id = String(threadId || '').trim();
  if (!id) return null;
  return map[id] || null;
}

// Serialize the whole read/modify/write, including reads made during fast navigation.
// Recover the chain after a rejected write so later drafts are still persisted.
export function createDraftStorage(readRaw: () => Promise<string | null>, writeRaw: (raw: string) => Promise<void>) {
  let tail: Promise<unknown> = Promise.resolve();
  // Preserve completed uploads through a stale navigation cleanup snapshot until a
  // composer save explicitly observes the attachment. Never merge arbitrary old files.
  const unobserved = new Map<string, Map<string, ComposerPending>>();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  }
  return {
    readRaw: () => serial(readRaw),
    writeRaw: (raw: string) => serial(() => writeRaw(raw)),
    load: (id: string) => serial(async () => loadComposerDraftFromMap(parseDraftMap(await readRaw()), id)),
    migrateNamespace: (from: string, to: string) => serial(async () => {
      if (!from || !to || from === to) return;
      const map = parseDraftMap(await readRaw());
      for (const [key, draft] of Object.entries(map)) {
        let parts: unknown;
        try { parts = JSON.parse(key); } catch { continue; }
        if (!Array.isArray(parts) || parts[0] !== 'draft-v2' || parts[1] !== from || typeof parts[2] !== 'string') continue;
        const target = scopedDraftKey(parts[2], to);
        // Never overwrite a destination conflict or delete the source backup.
        if (!map[target]) map[target] = draft;
      }
      await writeRaw(JSON.stringify(map));
    }),
    claimLegacy: (legacyId: string, scopedId: string) => serial(async () => {
      if (!legacyId || !scopedId || legacyId === scopedId) return null;
      const map = parseDraftMap(await readRaw());
      if (map[scopedId]) return map[scopedId];
      const draft = map[legacyId]; if (!draft) return null;
      const next = upsertDraft(map, scopedId, draft); delete next[legacyId];
      await writeRaw(JSON.stringify(next));
      return draft;
    }),
    save: (id: string, draft: ComposerDraft | null) => serial(async () => {
      const waiting = unobserved.get(id);
      const pending = [...(draft?.pending || [])];
      const observed: string[] = [];
      if (waiting) for (const [key, attachment] of waiting) {
        if (pending.some(p => p.taskId === key)) observed.push(key);
        else pending.push(attachment);
      }
      const next = pending.length ? { ...(draft || { text: '', updatedAt: Date.now() }), pending } : draft;
      await writeRaw(JSON.stringify(upsertDraft(parseDraftMap(await readRaw()), id, next)));
      for (const key of observed) waiting?.delete(key);
    }),
    appendAttachment: (id: string, attachment: ComposerPending) => serial(async () => {
      const map = parseDraftMap(await readRaw());
      const draft = map[id] || { text: '', pending: [], updatedAt: Date.now() };
      if (!draft.pending.some(p => p.taskId === attachment.taskId && attachment.taskId || p.path === attachment.path)) draft.pending.push(attachment);
      await writeRaw(JSON.stringify(upsertDraft(map, id, { ...draft, updatedAt: Date.now() })));
      if (attachment.taskId) {
        const waiting = unobserved.get(id) || new Map<string, ComposerPending>();
        waiting.set(attachment.taskId, attachment); unobserved.set(id, waiting);
      }
    }),
    removeAttachment: (id: string, taskId: string) => serial(async () => {
      const map = parseDraftMap(await readRaw());
      const draft = map[id];
      unobserved.get(id)?.delete(taskId);
      if (draft) await writeRaw(JSON.stringify(upsertDraft(map, id, { ...draft, pending: draft.pending.filter(p => p.taskId !== taskId) })));
    }),
    clearSending: (id: string, text: string) => serial(async () => {
      await writeRaw(JSON.stringify(clearSendingDraft(parseDraftMap(await readRaw()), id, text)));
    }),
  };
}

export function clearSendingDraft(
  map: Record<string, ComposerDraft>,
  threadId: string,
  text: string,
): Record<string, ComposerDraft> {
  const id = String(threadId || '').trim();
  if (!id) return map;
  const cur = map[id];
  if (!cur?.sending) return map;
  const sent = String(text || '').trim();
  if (!sent || cur.text.trim() === sent) return upsertDraft(map, id, null);
  return upsertDraft(map, id, { ...cur, sending: false, updatedAt: Date.now() });
}
