import fs from 'node:fs';
import path from 'node:path';

export const PREVIEW_DIR = '.web-preview';

export const RAW_VIEW_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export const OFFICE_EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

export function requestWantsHtml(req) {
  return /text\/html/i.test(String(req?.headers?.accept || ''));
}

export function buildGateHtml({ title, message, actionHref = '/', actionLabel = '打开 Codesk 登录' } = {}) {
  const safeTitle = escapeHtml(title || '无法打开文件');
  const safeMessage = escapeHtml(message || '');
  const safeHref = escapeHtml(actionHref);
  const safeLabel = escapeHtml(actionLabel);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 48px auto; max-width: 560px; color: #0f172a; background: #f8fafc; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { color: #475569; line-height: 1.6; }
  a { display: inline-block; margin-top: 16px; color: #fff; background: #0f172a; text-decoration: none; padding: 10px 14px; border-radius: 10px; font-weight: 700; }
</style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>${safeMessage}</p>
  <a href="${safeHref}">${safeLabel}</a>
</body>
</html>`;
}

export function decodeRequestedPath(rawPath) {
  let filePath = String(rawPath || '').replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
  try { filePath = decodeURIComponent(filePath); } catch { /* already decoded */ }
  return filePath.trim();
}

function tryStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function resolveRequestedPath(rawPath, cwd = '') {
  const filePath = decodeRequestedPath(rawPath);
  if (!filePath) return null;

  const hit = (p) => {
    const st = tryStat(p);
    if (!st) return null;
    if (st.isFile() || st.isDirectory()) return { path: p, isDir: st.isDirectory() };
    return null;
  };

  let found = hit(filePath);
  if (found) return found;
  if (!cwd) return null;
  if (!path.isAbsolute(filePath)) {
    found = hit(path.join(cwd, filePath));
    if (found) return found;
  }
  return null;
}

export function findWebPreview(filePath) {
  const dir = path.join(path.dirname(filePath), PREVIEW_DIR);
  const base = path.parse(filePath).name;
  for (const ext of ['.pdf', '.html', '.htm']) {
    const candidate = path.join(dir, `${base}${ext}`);
    const st = tryStat(candidate);
    if (st && st.isFile()) return candidate;
  }
  return null;
}

export function hubRawFileHref(absPath) {
  return `/api/file?path=${encodeURIComponent(absPath)}&raw=1`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function pickRawServePath(filePath, isDir) {
  if (isDir) return { kind: 'dir', path: filePath, mime: 'text/html; charset=utf-8' };
  const ext = path.extname(filePath).toLowerCase();
  const mime = RAW_VIEW_MIME[ext];
  if (mime) return { kind: 'file', path: filePath, mime };
  if (OFFICE_EXTS.has(ext)) {
    const preview = findWebPreview(filePath);
    if (preview) {
      return {
        kind: 'preview',
        path: preview,
        mime: RAW_VIEW_MIME[path.extname(preview).toLowerCase()] || 'application/pdf',
        original: filePath,
      };
    }
    return { kind: 'download', path: filePath, mime: 'application/octet-stream' };
  }
  return { kind: 'download', path: filePath, mime: 'application/octet-stream' };
}

export function buildDirectoryHtml(dirPath, { allows = () => true } = {}) {
  const title = path.basename(dirPath) || dirPath;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    return `<!doctype html><meta charset="utf-8"><p>无法读取目录：${escapeHtml(err.message)}</p>`;
  }

  const rows = [];
  for (const ent of entries) {
    if (ent.name === PREVIEW_DIR || ent.name.startsWith('.')) continue;
    const full = path.join(dirPath, ent.name);
    if (!allows(full)) continue;
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    const href = hubRawFileHref(full);
    if (ent.isDirectory() || (st && st.isDirectory())) {
      rows.push(`<li class="dir"><a href="${escapeHtml(href)}">${escapeHtml(ent.name)}/</a></li>`);
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    const candidate = OFFICE_EXTS.has(ext) ? findWebPreview(full) : null;
    const preview = candidate && allows(candidate) ? candidate : null;
    const size = st ? formatSize(st.size) : '';
    const viewHref = preview ? hubRawFileHref(preview) : href;
    const viewLabel = preview ? '在浏览器中查看' : (RAW_VIEW_MIME[ext] ? '打开' : '下载');
    rows.push(
      `<li class="file"><a href="${escapeHtml(viewHref)}">${escapeHtml(ent.name)}</a>`
      + `<span class="meta">${escapeHtml(size)}</span>`
      + `<a class="view" href="${escapeHtml(viewHref)}">${viewLabel}</a></li>`,
    );
  }

  rows.sort((a, b) => a.localeCompare(b, 'zh'));
  const list = rows.length ? `<ul>${rows.join('')}</ul>` : '<p>这个目录是空的。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #0f172a; background: #f8fafc; }
  h1 { font-size: 18px; font-weight: 700; margin: 0 0 16px; word-break: break-all; }
  ul { list-style: none; padding: 0; margin: 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; }
  li { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; }
  li:last-child { border-bottom: 0; }
  a { color: #0f172a; font-weight: 650; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .meta { color: #64748b; font-size: 12px; margin-left: auto; }
  .view { color: #2563eb; font-size: 13px; white-space: nowrap; }
  .path { color: #64748b; font-size: 12px; margin-bottom: 16px; word-break: break-all; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="path">${escapeHtml(dirPath)}</div>
  ${list}
</body>
</html>`;
}

// Active documents must not inherit the authenticated Hub origin.
export function rawPreviewHeaders(mime) {
  return /^(text\/html|image\/svg\+xml|application\/xml)(;|$)/i.test(mime)
    ? { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" }
    : {};
}
