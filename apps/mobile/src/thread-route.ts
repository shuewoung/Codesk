const THREAD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HASH_THREAD_RE = /#thread-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const PATH_THREAD_RE = /(?:^|\/)thread\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function parseThreadIdFromHref(href: string): string {
  const text = String(href || '').trim();
  if (!text) return '';
  const fromHash = text.match(HASH_THREAD_RE);
  if (fromHash) return fromHash[1];
  try {
    const url = new URL(text, 'http://local.invalid');
    const query = url.searchParams.get('threadId') || url.searchParams.get('thread') || '';
    const fromQuery = query.match(THREAD_ID_RE);
    if (fromQuery) return fromQuery[0];
    const fromPath = `${url.host}${url.pathname}`.match(PATH_THREAD_RE);
    if (fromPath) return fromPath[1];
  } catch {
    /* ignore */
  }
  return '';
}

export function hrefWithThreadId(href: string, threadId: string): string {
  const url = new URL(String(href || ''), 'http://local.invalid');
  url.searchParams.delete('threadId');
  url.searchParams.delete('thread');
  url.hash = threadId ? `thread-${threadId}` : '';
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readBrowserThreadId(): string {
  if (typeof window === 'undefined' || !window.location) return '';
  return parseThreadIdFromHref(window.location.href);
}

export function syncBrowserThreadId(threadId: string): void {
  if (typeof window === 'undefined' || !window.location || !window.history) return;
  const next = hrefWithThreadId(window.location.href, threadId);
  const curr = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === curr) return;
  window.history.replaceState(null, '', next);
}
