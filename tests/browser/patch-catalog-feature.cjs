#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const bundle = path.join(
  repoRoot,
  "codex-web-upstream",
  "scratch",
  "asar",
  "webview",
  "assets",
  "app-initial~app-main~page-BF1QkwFT.js",
);
const backup = `${bundle}.catalog-feature.orig`;
const mode = process.argv[2] || "apply";

if (mode === "revert") {
  if (!fs.existsSync(backup)) throw new Error(`Missing backup: ${backup}`);
  fs.copyFileSync(backup, bundle);
  console.log(`restored ${bundle}`);
  process.exit(0);
}

if (!fs.existsSync(backup)) fs.copyFileSync(bundle, backup);
const source = fs.readFileSync(bundle, "utf8");
const from = "i = Wr(`567837310`),";
const to = "i = Wr(`567837310`) || ka.localThreadCatalog != null,";
const count = source.split(from).length - 1;
if (count !== 1) throw new Error(`Expected one feature gate, got ${count}`);
fs.writeFileSync(bundle, source.replace(from, to), "utf8");
console.log(`patched ${bundle}`);
