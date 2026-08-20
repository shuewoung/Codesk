#!/usr/bin/env node
// 提取 .vite/build 下的 preload 文件用于对照
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar';
const OUT = path.join(process.cwd(), 'extracted_app', 'preload_ref');
fs.mkdirSync(OUT, { recursive: true });

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(8);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 12);
const raw = jsonBuf.toString('utf8');
const jsonStart = raw.indexOf('{"files"');
const dir = JSON.parse(raw.slice(jsonStart, raw.lastIndexOf('}') + 1));
const dataStart = 8 + headerSize;

const targets = [
  ['browser-page-preload.js', 'browser-page-preload.js'],
  ['preload.js', 'main-preload.js'],
  ['sandbox-preload.js', 'sandbox-preload.js'],
];
for (const [seg, name] of targets) {
  const node = dir.files['.vite'].files.build.files[seg];
  if (!node) { console.log('不存在:', seg); continue; }
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('提取:', name, node.size, 'bytes');
}
fs.closeSync(fd);
