#!/usr/bin/env node
// 诊断2：展开项目后对比项目内会话排序
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8214';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(12000);

// 点击"折叠显示"按钮展开所有项目下的会话
const collapseBtn = page.getByText('折叠显示');
if (await collapseBtn.isVisible().catch(() => false)) {
  console.log('找到"折叠显示"按钮，切换到展开模式...');
  await collapseBtn.click();
  await page.waitForTimeout(3000);
}

// 截图展开状态
await page.screenshot({ path: 'diagnose-expanded.png' });

// 获取完整侧栏文本
const text = await page.evaluate(() => {
  const sidebar = document.querySelector('aside') || document.querySelector('nav');
  return sidebar ? sidebar.innerText : document.body.innerText.substring(0, 3000);
});

console.log('===== 展开后侧栏文本 =====');
text.split('\n').filter(l => l.trim()).forEach((line, i) => {
  console.log(`  ${String(i + 1).padStart(3)}. ${line.trim().substring(0, 70)}`);
});

// 也试试点击"聊天"按钮看那个视图
const chatBtn = page.getByText('聊天').first();
if (await chatBtn.isVisible().catch(() => false)) {
  console.log('\n===== 点击"聊天"后 =====');
  await chatBtn.click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'diagnose-chat-view.png' });
  
  const chatText = await page.evaluate(() => {
    const sidebar = document.querySelector('aside') || document.querySelector('nav');
    return sidebar ? sidebar.innerText : '';
  });
  chatText.split('\n').filter(l => l.trim()).forEach((line, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. ${line.trim().substring(0, 70)}`);
  });
}

await browser.close();
