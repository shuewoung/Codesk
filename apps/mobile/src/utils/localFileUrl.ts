export function stripFileUrl(p: string): string {
  let s = String(p || '').trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // already decoded, or contains stray %
  }
  return s.replace(/^file:\/\/\/(?=[A-Za-z]:[\\/])/i, '').replace(/^file:\/\//i, '');
}

export function isAbsFilePath(p: string): boolean {
  const s = stripFileUrl(p);
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');
}

export function isLocalDiskRef(ref: string): boolean {
  const raw = String(ref || '').trim();
  if (!raw || /^(https?:|data:|blob:|#|javascript:)/i.test(raw)) return false;
  if (raw.startsWith('/api/file')) return false;
  return raw.startsWith('file:') || isAbsFilePath(raw);
}

export function hubRawFileUrl(fullPath: string): string {
  const qs = new URLSearchParams({ path: stripFileUrl(fullPath), raw: '1' });
  return `/api/file?${qs.toString()}`;
}

export function normalizeFsPath(p: string): string {
  return stripFileUrl(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function lookupCachedFile<T extends { path?: string; requestPath?: string }>(
  files: Record<string, T>,
  requested: string,
): T | undefined {
  const raw = String(requested || '').trim();
  if (!raw) return undefined;
  if (files[raw]) return files[raw];
  const want = normalizeFsPath(raw);
  if (!want) return undefined;
  let fallback: T | undefined;
  for (const [key, file] of Object.entries(files)) {
    const keys = [key, file.path || '', file.requestPath || '']
      .map(normalizeFsPath)
      .filter(Boolean);
    if (keys.includes(want)) return file;
    if (keys.some((k) => k.endsWith(`/${want}`) || want.endsWith(`/${k}`))) {
      fallback = fallback || file;
    }
  }
  return fallback;
}

export function resolveTimelineImage(source: string, cwd: string): string {
  if (/^(https?:|data:)/i.test(source)) return source;
  const path = pathFromHref(source);
  if (/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path)) return path;
  return cwd ? `${cwd.replace(/[\\/]$/, '')}/${path}` : path;
}

export function pathFromHref(href: string): string {
  const raw = String(href || '').trim();
  if (raw.startsWith('/api/file')) {
    try {
      return stripFileUrl(new URL(raw, 'http://local.invalid').searchParams.get('path') || raw);
    } catch {
      return stripFileUrl(raw);
    }
  }
  return stripFileUrl(raw);
}
