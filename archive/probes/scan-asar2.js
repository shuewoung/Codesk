#!/usr/bin/env node
// asar 第二轮：搜握手/注册相关关键词
const fs = require("node:fs");

const ASAR = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar";
const NEEDLES = [
  "no-client-found",
  "attachMessageReader",
  "ipc-attach",
  "client-hello",
  "hello",
  "register-client",
  "attachClient",
  "handshake",
];
const MAX_SHOW = 4;

const CHUNK = 8 * 1024 * 1024;
const buf = Buffer.alloc(CHUNK + 8192);
const fd = fs.openSync(ASAR, "r");
const size = fs.fstatSync(fd).size;
let pos = 0;
let overlap = 0;
const found = new Map();

while (pos < size) {
  const toRead = Math.min(CHUNK, size - pos);
  const n = fs.readSync(fd, buf, overlap, toRead, pos);
  const view = buf.slice(0, overlap + n);
  const text = view.toString("latin1");
  for (const needle of NEEDLES) {
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      const count = (found.get(needle) || 0) + 1;
      found.set(needle, count);
      if (count <= MAX_SHOW) {
        const start = Math.max(0, idx - 1200);
        const end = Math.min(text.length, idx + needle.length + 2200);
        const ctx = text.slice(start, end).replace(/[^\x20-\x7e]/g, "·");
        console.log(`\n===== [${needle}] #${count} @≈${pos + idx - overlap} =====`);
        console.log(ctx);
      }
      idx += needle.length;
    }
  }
  overlap = Math.min(8192, n);
  buf.copy(buf, 0, overlap + n - overlap, overlap + n);
  pos += n;
}
fs.closeSync(fd);
console.log("\n=== 统计 ===");
for (const [k, v] of found) console.log(`${k}: ${v} 处`);
