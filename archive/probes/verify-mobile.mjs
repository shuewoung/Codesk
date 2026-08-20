#!/usr/bin/env node
// 手机端视口验证（iPhone 尺寸）
import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8214', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(9000);
await page.screenshot({ path: 'mobile-1.png' });

const state = await page.evaluate(() => {
  const vp = document.querySelector('meta[name=viewport]');
  return {
    viewportMeta: vp ? vp.content : 'NONE',
    bodyWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
    hasHScroll: document.body.scrollWidth > window.innerWidth,
    text: document.body.innerText.slice(0, 300),
  };
});
console.log(JSON.stringify(state, null, 1));
await browser.close();
