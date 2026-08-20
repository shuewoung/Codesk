#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createAppServerEnv,
  ensureArtifactDir,
  getCodexCliPath,
  readProject,
  countCatalogForRoots,
  artifactDir,
  isSameOrDescendant,
} from "./test-env.mjs";

const projectName = process.argv[2];
if (!projectName) {
  console.error("usage: node tests/app-server/session-count.mjs <projectName>");
  process.exit(2);
}
const { project } = readProject(projectName);
const primaryRoot = project.rootPaths?.[0];
if (!primaryRoot) throw new Error(`Project has no root path: ${projectName}`);
const catalogRows = countCatalogForRoots([primaryRoot]);
const cliPath = getCodexCliPath();
const child = spawn(cliPath, ["app-server"], {
  env: createAppServerEnv(),
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderr = "";
const messages = [];
const waiters = new Map();

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  for (;;) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      messages.push(message);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    } catch {
      // app-server diagnostics are not part of the JSON-RPC stream.
    }
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

function request(id, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    waiters.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        } else {
          resolve(message.result);
        }
      },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

async function listAllThreads() {
  const rows = [];
  let cursor;
  do {
    const result = await request(`thread-list-${rows.length}`, "thread/list", {
      limit: 200,
      cursor,
      useStateDbOnly: true,
      sourceKinds: [],
      sortKey: "updated_at",
      archived: false,
    });
    rows.push(...(result?.data || []));
    cursor = result?.nextCursor || undefined;
  } while (cursor);
  return rows;
}

const startedAt = new Date().toISOString();
let report;
try {
  await request("initialize", "initialize", {
    clientInfo: { name: "codex-web-tests", title: "CodexWeb tests", version: "1.0.0" },
  });
  const appServerRows = await listAllThreads();
  const appServerProjectRows = appServerRows.filter((thread) =>
    isSameOrDescendant(thread.cwd || thread.path || "", primaryRoot),
  );
  const appServerIds = new Set(appServerRows.map((thread) => thread.id));
  const catalogIds = catalogRows.filter((row) => appServerIds.has(row.thread_id));
  report = {
    startedAt,
    project: { name: project.name, id: project.id, primaryRoot, rootPaths: project.rootPaths },
    appServer: { total: appServerRows.length, projectCount: appServerProjectRows.length },
    catalog: { projectCount: catalogRows.length, presentInAppServer: catalogIds.length },
    discrepancy: {
      appServerVsCatalog: appServerProjectRows.length - catalogRows.length,
      catalogRowsMissingFromAppServer: catalogRows.length - catalogIds.length,
    },
    projectThreads: catalogRows.map((row) => ({
      id: row.thread_id,
      title: row.display_title,
      cwd: row.cwd,
      sourceKind: row.source_kind,
    })),
    warnings: stderr
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-20),
  };
  const outputPath = path.join(ensureArtifactDir(), "session-count.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ...report, projectThreads: undefined, outputPath }, null, 2));
} finally {
  child.kill();
}
