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
  "main-d9AlrLRg.js",
);
const backup = `${bundle}.catalog-debug.orig`;
const mode = process.argv[2] || "apply";

if (mode === "revert") {
  if (!fs.existsSync(backup)) {
    throw new Error(`Missing debug backup: ${backup}`);
  }
  fs.copyFileSync(backup, bundle);
  console.log(`restored ${bundle}`);
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(bundle, backup);
}

let source = fs.readFileSync(bundle, "utf8");
const replacements = [
  [
    "P=n.Vr();F=P==null?null:(e,t)=>new n.i(P,e,t);I=()=>{};",
    'P=n.Vr();console.log("[CatalogDebug] store",P==null?"NULL":"OK");F=P==null?null:(e,t)=>new n.i(P,e,t);I=()=>{};',
  ],
  [
    "this.localThreadCatalogSyncCoordinator?.requestStartupSync();",
    'this.localThreadCatalogSyncCoordinator?.requestStartupSync().then(e=>console.log("[CatalogDebug] startupSync",e)).catch(e=>console.error("[CatalogDebug] startupSyncError",e));',
  ],
  [
    "requestRun(e,t){if(this.disposed||!this.foreground)return Promise.resolve(`stopped`);",
    'requestRun(e,t){console.log("[CatalogDebug] requestRun",e,t,"foreground",this.foreground,"enabled",this.syncEnabled);if(this.disposed||!this.foreground)return Promise.resolve(`stopped`);',
  ],
  [
    "async runSync(e,t){let r=this.store.readSyncState(),i=this.store.beginScan(t),",
    'async runSync(e,t){console.log("[CatalogDebug] runSync",t,"before",this.store.readSnapshot().entries.length);let r=this.store.readSyncState(),i=this.store.beginScan(t),',
  ],
  [
    "let e=this.store.completeScan(i,c??(t===`incremental`?a:null));return p=!1,",
    'let e=this.store.completeScan(i,c??(t===`incremental`?a:null));console.log("[CatalogDebug] completeScan",t,"changed",e.changedThreadIds.length,"snapshot",this.store.readSnapshot().entries.length);return p=!1,',
  ],
];

for (const [from, to] of replacements) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one match for ${from.slice(0, 90)}, got ${count}`);
  }
  source = source.replace(from, to);
}

fs.writeFileSync(bundle, source, "utf8");
console.log(`instrumented ${bundle}`);
