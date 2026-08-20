#!/usr/bin/env node
// 在 app.asar 头 JSON 里查找 preload 相关文件路径
import fs from 'node:fs';

const ASAR = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar';

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(8);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 12);
const text = jsonBuf.toString('utf8');
fs.closeSync(fd);

// 找所有含 preload 的文件名
const re = /"([^"]*preload[^"]*)"\s*:\s*\{[^}]*?"size"\s*:\s*(\d+)[^}]*?"offset"\s*:\s*"(\d+)"/g;
let m;
const hits = [];
while ((m = re.exec(text))) hits.push({ name: m[1], size: +m[2], offset: m[3] });
hits.forEach((h) => console.log(`${h.name}  size=${h.size} offset=${h.offset}`));

// 也列出顶层结构
const top = text.slice(0, 200);
console.log('\nheader 开头:', top);
