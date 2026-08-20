#!/usr/bin/env node
// 验证 codex-web 页面：渲染、登录态、会话列表
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8214';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const logs = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') logs.push(`[console.${t}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 400)}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));

console.log('加载页面...');
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
// 等应用初始化 + WS IPC 交换
await page.waitForTimeout(12000);

const state = await page.evaluate(() => {
  const root = document.getElementById('root');
  return {
    title: document.title,
    hasBridge: !!window.electronBridge,
    windowType: window.codexWindowType,
    rootChildren: root ? root.children.length : -1,
    bodyText: document.body.innerText.slice(0, 1200),
  };
});
console.log('\n===== 页面状态 =====');
console.log('title:', state.title);
console.log('electronBridge:', state.hasBridge, '| windowType:', state.windowType);
console.log('root children:', state.rootChildren);
console.log('bodyText:', state.bodyText.replace(/\n+/g, ' | ').slice(0, 1000));

console.log('\n===== 错误日志 (前 25 条) =====');
logs.slice(0, 25).forEach((l) => console.log(l));

await page.screenshot({ path: 'codexweb-page.png', fullPage: false });
console.log('\n截图: codexweb-page.png');
await browser.close();
