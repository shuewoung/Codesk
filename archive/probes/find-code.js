#!/usr/bin/env node
// 在 bundle 里查找函数定义并打印上下文
import fs from 'node:fs';

const file = process.argv[2];
const pattern = process.argv[3]; // 正则字符串
const span = Number(process.argv[4] || 3000);
const buf = fs.readFileSync(file).toString('utf8');
const re = new RegExp(pattern, 'g');
let m;
const hits = [];
while ((m = re.exec(buf))) hits.push(m.index);
console.log('hits:', hits.length, hits.slice(0, 5).join(','));
for (const h of hits.slice(0, 3)) {
  console.log(`\n--- ${h} ---`);
  console.log(buf.slice(Math.max(0, h - 300), h + span));
}
