import type { ThreadHistory } from '../types';

/** Host paths are not client-platform paths. Preserve POSIX, drive and UNC roots. */
export function parentPath(path: string): string {
  const root = path.match(/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|[\\/])/)?.[0] || '';
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed.length <= root.length) return root || '.';
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (separator < root.length) return root || '.';
  return trimmed.slice(0, separator);
}

/** Only user-turn boundaries and busy/settled transitions invalidate artifacts, not tokens/rev. */
export function artifactCycle(history?: ThreadHistory, fallbackStatus = ''): { key: string; active: boolean } {
  const users = history?.items.filter(item => item.role === 'user' || item.type === 'user_message') || [];
  const last = users[users.length - 1];
  const status = history?.status || fallbackStatus;
  const active = /^(working|running|in_progress|waiting_approval|waiting_for_approval)$/.test(status);
  const boundary = last ? JSON.stringify([users.length, last.turnId || last.id || last.timestamp || '', last.content]) : 'no-user';
  return { key: `${boundary}|${active ? 'active' : 'settled'}`, active };
}

export function shouldRefreshArtifacts(previousKey: string | undefined, key: string, active: boolean): boolean {
  return !active && previousKey !== key;
}

export function canShowArtifacts(requestedKey: string | undefined, key: string, active: boolean, request?: { status: string; requestId: string }, staleRequestId?: string): boolean {
  return !active && requestedKey === key && request?.status === 'success' && request.requestId !== staleRequestId;
}
