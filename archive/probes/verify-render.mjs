#!/usr/bin/env node
// 验证 webview 渲染：加载 http://127.0.0.1:18992，等待渲染，dump DOM + console
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:18992';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const logs = [];
page.on('console', (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));

console.log('加载页面...');
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

// 等待 8s 让应用渲染 + IPC 交换
await page.waitForTimeout(8000);

// 抓取关键状态
const state = await page.evaluate(() => {
  const root = document.getElementById('root');
  const text = root ? root.innerText.slice(0, 1500) : 'NO_ROOT';
  const body = document.body.innerText.slice(0, 1500);
  return {
    title: document.title,
    hasElectronBridge: !!window.electronBridge,
    bridgeKeys: window.electronBridge ? Object.keys(window.electronBridge).join(',') : '',
    rootText: text,
    bodyText: body,
    rootChildCount: root ? root.children.length : -1,
  };
});

console.log('\n===== 页面状态 =====');
console.log('title:', state.title);
console.log('electronBridge 存在:', state.hasElectronBridge);
console.log('bridge keys:', state.bridgeKeys);
console.log('root children:', state.rootChildCount);
console.log('rootText:', state.rootText.replace(/\n+/g, ' | ').slice(0, 800));
console.log('bodyText:', state.bodyText.replace(/\n+/g, ' | ').slice(0, 800));

console.log('\n===== 控制台日志 (前 40 条) =====');
logs.slice(0, 40).forEach((l) => console.log(l));

await browser.close();
