import fs from 'node:fs';
import path from 'node:path';

export const TREE_IGNORE = new Set([
  '.git', 'node_modules', '.codex', 'tmp', '.venv', '__pycache__',
  'dist', 'build', '.idea', '.vscode', 'vendor', 'coverage',
]);

export const ARTIFACT_EXTS = new Set([
  '.docx', '.xlsx', '.pptx', '.pdf', '.csv', '.tsv', '.md', '.html', '.htm',
]);

export function searchWorkspaceFiles(root, query, { maxHits = 40, maxVisits = 2500 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!root || q.length < 2 || !fs.existsSync(root)) return [];
  const hits = [];
  const stack = [root];
  let visits = 0;
  while (stack.length && hits.length < maxHits && visits < maxVisits) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      visits += 1;
      if (TREE_IGNORE.has(ent.name) || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.toLowerCase().includes(q)) {
        hits.push({
          name: ent.name,
          path: full,
          dir: path.relative(root, dir) || '.',
        });
      }
    }
  }
  return hits;
}

export function listArtifactFiles(root, { maxHits = 20, maxVisits = 2000 } = {}) {
  if (!root || !fs.existsSync(root)) return [];
  const hits = [];
  const stack = [root];
  let visits = 0;
  while (stack.length && visits < maxVisits) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      visits += 1;
      if (TREE_IGNORE.has(ent.name) || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!ARTIFACT_EXTS.has(ext)) continue;
      try {
        const st = fs.statSync(full);
        hits.push({
          name: ent.name,
          path: full,
          ext,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch { /* skip */ }
    }
  }
  hits.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return hits.slice(0, maxHits);
}

export function filesMatchingPlanStep(stepText, files) {
  const text = String(stepText || '').toLowerCase();
  if (!text) return [];
  const tokens = text.split(/[^a-z0-9_.\\/-]+/i).filter((tok) => tok.length > 2);
  return (files || []).filter((file) => {
    const p = String(file.path || file.text || '').toLowerCase();
    const base = p.split(/[\\/]/).pop() || '';
    if (base && text.includes(base)) return true;
    return tokens.some((tok) => p.includes(tok));
  });
}
