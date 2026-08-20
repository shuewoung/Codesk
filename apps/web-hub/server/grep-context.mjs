#!/usr/bin/env node
// 在超大的压缩 JS 里提取模式上下文（grep -o 大正则太慢）
// 用法: node grep-context.mjs <file> <pattern> <before> <after> [maxHits]
import fs from 'node:fs';

const [file, pattern, before = 120, after = 400, maxHits = 3] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const re = new RegExp(pattern, 'g');
let hits = 0;
let m;
while ((m = re.exec(text)) && hits < Number(maxHits)) {
  const start = Math.max(0, m.index - Number(before));
  const end = Math.min(text.length, m.index + m[0].length + Number(after));
  console.log(`\n===== hit ${++hits} @ ${m.index} =====`);
  console.log(text.slice(start, end));
}
if (!hits) console.log('[no hits]');
