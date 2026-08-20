#!/usr/bin/env node
// 列出 asar .vite/build 下的所有文件（找主进程入口）
import fs from 'node:fs';

const ASAR = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.6296.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar';
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(8);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 12);
const raw = jsonBuf.toString('utf8');
const dir = JSON.parse(raw.slice(raw.indexOf('{"files"'), raw.lastIndexOf('}') + 1));
fs.closeSync(fd);

const build = dir.files['.vite'].files.build.files;
const list = Object.entries(build)
  .filter(([name, node]) => !node.files)
  .map(([name, node]) => `${String(node.size).padStart(9)}  ${name}`)
  .sort()
  .join('\n');
console.log(list);
