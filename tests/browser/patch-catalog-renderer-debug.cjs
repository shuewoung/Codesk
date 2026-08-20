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
const backup = `${bundle}.catalog-debug.orig`;
const mode = process.argv[2] || "apply";

if (mode === "revert") {
  if (!fs.existsSync(backup)) throw new Error(`Missing backup: ${backup}`);
  fs.copyFileSync(backup, bundle);
  console.log(`restored ${bundle}`);
  process.exit(0);
}

if (!fs.existsSync(backup)) fs.copyFileSync(bundle, backup);
let source = fs.readFileSync(bundle, "utf8");
const replacements = [
  [
    "a = ka.localThreadCatalog,\n    o;",
    'a = ka.localThreadCatalog,\n    o;\n  console.log("[CatalogRendererDebug] service", a != null, "enabled", r, "flag", i);',
  ],
  [
    "let r = await e.readSnapshot();\n                  if (a) return;",
    'let r = await e.readSnapshot();\n                  console.log("[CatalogRendererDebug] snapshot", r?.entries?.length, r?.hosts);\n                  if (a) return;',
  ],
  [
    "e.subscribe((e) => {\n              Fd(t, e) === `gap` && ((i += 1), o());\n            })",
    'e.subscribe((e) => {\n              console.log("[CatalogRendererDebug] update", e?.type, e?.entries?.length, e?.snapshot?.entries?.length);\n              Fd(t, e) === `gap` && ((i += 1), o());\n            })',
  ],
];
for (const [from, to] of replacements) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`Expected one match for ${from}, got ${count}`);
  source = source.replace(from, to);
}
fs.writeFileSync(bundle, source, "utf8");
console.log(`instrumented ${bundle}`);
