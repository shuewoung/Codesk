#!/usr/bin/env node
// 诊断：项目排序在 Web UI 中是否与桌面端一致
// 对比 ~/.codex/.codex-global-state.json 的 project-order 与 Web UI 实际渲染
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL = 'http://127.0.0.1:8214';

// 1. 读取桌面端的项目排序
const statePath = path.join(os.homedir(), '.codex', '.codex-global-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const projectOrder = state['project-order'] || [];
const localProjects = state['local-projects'] || {};

console.log('===== 桌面端 project-order（前 15）=====');
projectOrder.slice(0, 15).forEach((id, i) => {
  const p = localProjects[id];
  console.log(`  ${String(i + 1).padStart(2)}. ${p?.name || '?('+id.slice(0,8)+')'}`);
});

// 2. 通过 Playwright 读取 Web UI 的实际项目排序
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (msg) => {
  if (msg.text().includes('[DIAG]')) console.log(msg.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(12000); // 等待 IPC 完全初始化和数据加载

// 3. 在浏览器上下文中提取项目分组顺序
const webData = await page.evaluate(() => {
  const result = { projectNames: [], sidebarText: [], errors: [] };
  
  // 尝试提取侧栏中的项目标题
  // Codex UI 的侧栏项目通常是 section header / group header
  const allText = [];
  const sidebar = document.querySelector('aside') || document.querySelector('nav') || document.querySelector('[class*="sidebar"]');
  if (sidebar) {
    // 查找项目组的标题元素
    const headers = sidebar.querySelectorAll('h2, h3, [class*="project"], [class*="group-header"], [data-testid*="project"], button, a');
    headers.forEach(el => {
      const t = el.textContent?.trim();
      if (t && t.length > 0 && t.length < 100) {
        allText.push({ tag: el.tagName, text: t.substring(0, 60), classes: el.className?.substring?.(0, 80) || '' });
      }
    });
  }
  
  // 也获取完整的 body 文本用于比对
  const bodyLines = document.body.innerText.split('\n').filter(l => l.trim().length > 0);
  result.sidebarText = allText;
  result.bodyText = bodyLines.slice(0, 80).map(l => l.substring(0, 60));
  
  return result;
});

console.log('\n===== Web UI 侧栏元素（前 40）=====');
webData.sidebarText.slice(0, 40).forEach((item, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. [${item.tag}] ${item.text}`);
});

console.log('\n===== Web UI body 文本（前 30 行）=====');
webData.bodyText.slice(0, 30).forEach((line, i) => {
  console.log(`  ${String(i + 1).padStart(2)}. ${line}`);
});

// 4. 截图
await page.screenshot({ path: 'diagnose-order.png', fullPage: false });
console.log('\n截图已保存: diagnose-order.png');

await browser.close();
