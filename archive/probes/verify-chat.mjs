#!/usr/bin/env node
// 验证：发起新对话 + 接收流式回复 + 设置面板
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8214';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(9000);

// ---- 1. 新对话：找 composer 输入框 ----
const editor = page.locator('[contenteditable="true"]').first();
await editor.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
console.log('composer 可见:', await editor.isVisible().catch(() => false));

await editor.click();
await page.keyboard.type('请只回复两个字：收到。不要执行任何其他操作。', { delay: 20 });
await page.screenshot({ path: 'chat-1-typed.png' });

// 提交（Enter）
await page.keyboard.press('Enter');
console.log('已提交，等待流式回复...');

// 轮询等待回复出现（最多 90s）
let replyText = '';
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => document.body.innerText);
  if (t.includes('收到')) {
    replyText = t;
    console.log(`第 ${(i + 1) * 3}s 检测到回复`);
    break;
  }
}
await page.screenshot({ path: 'chat-2-reply.png' });
const bodyNow = await page.evaluate(() => document.body.innerText);
console.log('\n===== 对话后 bodyText（截取）=====');
console.log(bodyNow.replace(/\n+/g, ' | ').slice(0, 700));
console.log('\n流式回复出现:', bodyNow.includes('收到'));

// ---- 2. 设置面板 ----
// 尝试常见入口：头像/账户菜单里的 Settings
const settingsEntry = page.getByText(/Settings|设置/).first();
if (await settingsEntry.isVisible().catch(() => false)) {
  await settingsEntry.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'chat-3-settings.png' });
  const sText = await page.evaluate(() => document.body.innerText);
  console.log('\n===== 设置面板（截取）=====');
  console.log(sText.replace(/\n+/g, ' | ').slice(0, 500));
} else {
  console.log('\n设置入口未直接可见，跳过（可能藏在账户菜单）');
}

await browser.close();
