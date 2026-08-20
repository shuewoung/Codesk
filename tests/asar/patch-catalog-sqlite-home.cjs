#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const bundle = path.join(
  repoRoot,
  "codex-web-upstream",
  "scratch",
  "asar",
  ".vite",
  "build",
  "src-Ct4P_yu5.js",
);
const backup = `${bundle}.sqlite-home.orig`;
const mode = process.argv[2] || "apply";

if (mode === "revert") {
  if (!fs.existsSync(backup)) {
    throw new Error(`Missing sqlite-home backup: ${backup}`);
  }
  fs.copyFileSync(backup, bundle);
  console.log(`restored ${bundle}`);
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(bundle, backup);
}

const source = fs.readFileSync(bundle, "utf8");
const from = "function bO(e){return(0,i.join)(cE(),`sqlite`,e?.databaseFileName??yO())}";
const to = "function bO(e){return(0,i.join)(process.env.CODEX_WEB_SQLITE_HOME??cE(),`sqlite`,e?.databaseFileName??yO())}";
const count = source.split(from).length - 1;
if (count !== 1) {
  throw new Error(`Expected one sqlite path function, got ${count}`);
}

fs.writeFileSync(bundle, source.replace(from, to), "utf8");
console.log(`patched ${bundle}`);
