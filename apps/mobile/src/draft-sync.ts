import type { DraftSyncState, RemoteDraft } from './types';

export function receiveDraft(previous: DraftSyncState | undefined, remote: RemoteDraft, conflict = false): DraftSyncState {
  if (previous?.remote && remote.version < previous.remote.version) return previous;
  const local = previous?.local;
  // v0/empty is an uncreated remote draft, not another device's conflicting edit.
  const uncreated = remote.version === 0 && remote.text === '' && remote.attachments.length === 0;
  const equal = uncreated || !local || local.text === remote.text && JSON.stringify(local.attachments) === JSON.stringify(remote.attachments);
  return { remote, local, status: conflict || !equal ? 'conflict' : 'synced', error: conflict ? '远端草稿已更改；本地内容已保留，请选择版本。' : undefined };
}

export function validRemoteDraft(value: unknown): value is RemoteDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as RemoteDraft;
  return Number.isSafeInteger(draft.version) && draft.version >= 0 && typeof draft.text === 'string' && Array.isArray(draft.attachments);
}
