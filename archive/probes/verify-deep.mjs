#!/usr/bin/env node
// 深度诊断：捕获 window message / MessagePort / 网络层
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:18992';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (msg) => {
  const t = msg.type();
  if (['error', 'warning'].includes(t)) console.log(`[console.${t}] ${msg.text().slice(0, 500)}`);
});
page.on('pageerror', (err) => console.log(`[pageerror] ${err.stack?.slice(0, 800) || err.message}`));

// 注入探针
await page.addInitScript(() => {
  window.__probeLog = [];
  const log = (...a) => { try { window.__probeLog.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)?.slice(0, 200)).join(' ')); } catch {} };
  // 捕获 window message
  window.addEventListener('message', (e) => {
    const d = e.data;
    log('[window:message]', typeof d === 'object' && d ? (d.type || d.method || d.__proto__?.constructor?.name || Object.keys(d).join(',')) : String(d));
  }, true);
  // 捕获原始 electronBridge 调用
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (url?.startsWith('sentry')) log('[fetch]', url);
    return origFetch.apply(this, args);
  };
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6000);

const probe = await page.evaluate(() => window.__probeLog.slice(-60));
console.log('\n===== 探针日志 (后 60 条) =====');
probe.forEach((l) => console.log(l));

await browser.close();
