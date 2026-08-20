#!/usr/bin/env node
// 对比：桌面存储的项目顺序 vs web UI 实际显示顺序
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 1. 桌面存储顺序
const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', '.codex-global-state.json'), 'utf8'));
const projects = st['local-projects'] || {};
const byId = new Map();
for (const [id, p] of Object.entries(projects)) byId.set(id, p);
const desktopOrder = (st['project-order'] || []).map((id) => {
  const p = byId.get(id);
  return { id, name: p?.name || `?(${id.slice(0, 8)})`, roots: p?.rootPaths || p?.sources || [] };
});
console.log('===== 桌面存储的 project-order（前 15）=====');
desktopOrder.slice(0, 15).forEach((p, i) => console.log(String(i + 1).padStart(2), p.name));

// 2. web UI 显示顺序
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:8214', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(10000);
const webOrder = await page.evaluate(() => {
  // 侧栏项目区块：取 Projects 标题之后的按钮/行文本
  const text = [];
  const els = document.querySelectorAll('[data-testid*="project"], nav a, aside a, [role="treeitem"]');
  els.forEach((e) => text.push(e.textContent?.trim()));
  return text.filter(Boolean);
});
console.log('\n===== web UI 侧栏元素（前 40）=====');
webOrder.slice(0, 40).forEach((t, i) => console.log(String(i + 1).padStart(2), t?.slice(0, 50)));
await browser.close();
