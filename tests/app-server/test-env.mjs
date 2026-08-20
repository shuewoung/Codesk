import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
export const testRoot = path.resolve(repoRoot, "tests");
export const artifactDir = path.resolve(testRoot, "artifacts");

export function getCodexHome() {
  return path.resolve(
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
  );
}

export function getCodexCliPath() {
  return (
    process.env.CODEX_CLI_PATH?.trim() ||
    path.resolve(repoRoot, "codex-bin", "codex.exe")
  );
}

export function ensureArtifactDir() {
  fs.mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

export function resolveBetterSqlite3() {
  const requireFromUpstream = createRequire(
    path.resolve(repoRoot, "codex-web-upstream", "package.json"),
  );
  return requireFromUpstream("better-sqlite3");
}

export function normalizeWindowsPath(value) {
  return path
    .normalize(String(value || ""))
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

export function isSameOrDescendant(candidate, root) {
  const normalizedCandidate = normalizeWindowsPath(candidate);
  const normalizedRoot = normalizeWindowsPath(root);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

export function readProject(projectName) {
  const statePath = path.join(getCodexHome(), ".codex-global-state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const entry = Object.values(state["local-projects"] || {}).find(
    (project) => project?.name === projectName,
  );
  if (!entry) {
    throw new Error(`Project not found in global state: ${projectName}`);
  }
  return { state, project: entry };
}

export function countCatalogForRoots(projectRoots) {
  const Database = resolveBetterSqlite3();
  const dbPath = path.join(getCodexHome(), "sqlite", "codex-dev.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT thread_id, display_title, cwd, source_kind, source_created_at,
                source_updated_at, source_recency_at, missing_candidate
           FROM local_thread_catalog
          WHERE host_id = ?
          ORDER BY source_updated_at DESC`,
      )
      .all("local");
    return rows.filter(
      (row) =>
        row.missing_candidate === 0 &&
        projectRoots.some((root) => isSameOrDescendant(row.cwd, root)),
    );
  } finally {
    db.close();
  }
}

export function createAppServerEnv() {
  return {
    ...process.env,
    CODEX_HOME: getCodexHome(),
  };
}
