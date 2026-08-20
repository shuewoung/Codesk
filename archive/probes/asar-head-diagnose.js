#!/usr/bin/env node
// asar 头诊断：打印前 64 字节的原始字段，尝试多种偏移组合解析
const fs = require("node:fs");

const ASAR = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar";
const fd = fs.openSync(ASAR, "r");
const head = Buffer.alloc(64);
fs.readSync(fd, head, 0, 64, 0);

console.log("前 64 字节 hex:");
console.log(Array.from(head).map((b) => b.toString(16).padStart(2, "0")).join(" "));
console.log("前 64 字节 ascii:");
console.log(head.toString("latin1").replace(/[^\x20-\x7e]/g, "."));

for (let i = 0; i < 8; i++) {
  console.log(`u32@${i * 4} = ${head.readUInt32LE(i * 4)}`);
}

// 尝试: 第4字节是 headerSize, 第8字节是 jsonLen
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(8);
console.log(`headerSize=${headerSize} jsonLen=${jsonLen}`);
if (jsonLen > 0 && jsonLen < 100 * 1024 * 1024) {
  const buf = Buffer.alloc(jsonLen);
  fs.readSync(fd, buf, 0, jsonLen, 12);
  try {
    const dir = JSON.parse(buf.toString("utf8"));
    console.log("解析成功! 顶层 keys:", Object.keys(dir).slice(0, 10).join(", "));
    if (dir.files) {
      const top = Object.keys(dir.files).slice(0, 20);
      console.log("files 前 20 项:", top.join(", "));
      const pj = dir.files["package.json"];
      console.log("package.json:", pj ? JSON.stringify(pj).slice(0, 200) : "N/A");
      // 数据区起点验证
      const dataStart = 8 + headerSize;
      const pbuf = Buffer.alloc(pj.size);
      fs.readSync(fd, pbuf, 0, pj.size, dataStart + Number(pj.offset));
      try { console.log("package.json 内容校验:", JSON.parse(pbuf.toString("utf8")).name ?? "?"); }
      catch (e) { console.log("package.json 校验失败:", e.message); }
    }
  } catch (e) {
    console.log("解析失败:", e.message);
  }
} else {
  console.log("jsonLen 可疑，尝试 jsonLen=head[0]:", head.readUInt32LE(0));
}
fs.closeSync(fd);
