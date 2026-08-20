#!/usr/bin/env node
// 从当前安装的 Codex 桌面版 app.asar 提取 webview 静态文件和 preload.js
// 用法: node extract-webview.js
const fs = require("node:fs");
const path = require("node:path");

const ASAR = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar";
const OUT = path.join(__dirname, "extracted_app");

const fd = fs.openSync(ASAR, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);

// asar 头: [4B 外层size=4][4B headerSize][4B jsonLen][json][pad][数据]
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(8);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 12);
let dir;
try {
  dir = JSON.parse(jsonBuf.toString("utf8"));
} catch (e) {
  // 兜底：从 '{"files"' 起做括号配对
  const text = jsonBuf.toString("latin1");
  const jsonStart = text.indexOf("{");
  let depth = 0, inStr = false, esc = false, jsonEnd = -1;
  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
  }
  dir = JSON.parse(text.slice(jsonStart, jsonEnd));
}

// 数据区起点：标准为 8 + headerSize；用 package.json 内容校验
const candidates = [8 + headerSize, 12 + jsonLen];
let dataStart = candidates[0];
{
  const pj = dir.files["package.json"];
  for (const c of candidates) {
    const buf = Buffer.alloc(pj.size);
    fs.readSync(fd, buf, 0, pj.size, c + Number(pj.offset));
    try { JSON.parse(buf.toString("utf8")); dataStart = c; break; } catch {}
  }
}
console.log("asar 数据区起点:", dataStart);

function extract(node, name, dest) {
  if (node.files) {
    fs.mkdirSync(dest, { recursive: true });
    for (const [child, v] of Object.entries(node.files)) extract(v, child, path.join(dest, child));
    return;
  }
  // 文件
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
  fs.writeFileSync(dest, buf);
}

const targets = ["webview", ".vite/build/preload.js", "package.json"];
for (const t of targets) {
  const node = t.split("/").reduce((n, seg) => n?.files?.[seg], dir);
  if (!node) { console.log("跳过(不存在):", t); continue; }
  const dest = path.join(OUT, t);
  extract(node, t, dest);
  console.log("已提取:", t);
}

// 统计
function count(node) {
  if (!node.files) return { f: 1, b: node.size };
  let f = 0, b = 0;
  for (const v of Object.values(node.files)) { const r = count(v); f += r.f; b += r.b; }
  return { f, b };
}
const c = count(dir.files["webview"]);
console.log(`webview: ${c.f} 个文件, ${(c.b / 1024 / 1024).toFixed(1)} MB`);
fs.closeSync(fd);
console.log("完成 ->", OUT);
