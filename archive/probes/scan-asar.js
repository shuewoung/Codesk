#!/usr/bin/env node
// 在 app.asar 二进制里搜 "codex-ipc"，输出前后上下文
const fs = require("node:fs");

const ASAR = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar";
const NEEDLES = ["codex-ipc", "\\\\.\\pipe\\", "connect-app-host", "CapnWeb", "capnweb"];

const CHUNK = 8 * 1024 * 1024;
const buf = Buffer.alloc(CHUNK + 4096);
const fd = fs.openSync(ASAR, "r");
const size = fs.fstatSync(fd).size;
let pos = 0;
let overlap = 0;
const found = new Map(); // needle -> count

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
      if (count <= 6) {
        const start = Math.max(0, idx - 500);
        const end = Math.min(text.length, idx + needle.length + 1500);
        const ctx = text.slice(start, end).replace(/[^\x20-\x7e]/g, "·");
        console.log(`\n===== [${needle}] #${count} @file-offset≈${pos + idx - overlap} =====`);
        console.log(ctx);
      }
      idx += needle.length;
    }
  }
  // 保留尾部 overlap 防止跨块漏匹配
  overlap = Math.min(4096, n);
  buf.copy(buf, 0, overlap + n - overlap, overlap + n);
  pos += n;
}
fs.closeSync(fd);
console.log("\n=== 统计 ===");
for (const [k, v] of found) console.log(`${k}: ${v} 处`);
if (found.size === 0) console.log("未找到任何关键词");
