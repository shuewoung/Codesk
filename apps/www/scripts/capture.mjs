import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const hub = process.env.CODESK_HUB_URL || 'http://127.0.0.1:18990';
const passwordFile = process.env.CODESK_PASSWORD_FILE
  || path.join(process.env.LOCALAPPDATA || '', 'OneDesk', 'password');
const password = fs.existsSync(passwordFile)
  ? fs.readFileSync(passwordFile, 'utf8').replace(/^\uFEFF/, '').trim()
  : '';

const maskCss = `
  #thread-list { filter: blur(7px); pointer-events: none; }
  #active-session-title { visibility: hidden; }
  #workspace-tree-body { filter: blur(6px); }
`;

async function shot(page, name) {
  const dest = path.join(outDir, name);
  await page.screenshot({ path: dest, type: 'png' });
  console.log('wrote', dest);
}

const browser = await chromium.launch({ headless: true });

const desktop = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
const desk = await desktop.newPage();
await desk.goto(hub, { waitUntil: 'networkidle', timeout: 30000 });
await desk.waitForTimeout(800);
await shot(desk, 'shot-login.png');

if (!password) {
  console.log('no password file, skip app shots');
  await browser.close();
  process.exit(0);
}

await desk.fill('#auth-password', password);
await desk.click('#auth-login-form button[type="submit"]');
await desk.waitForSelector('#auth-overlay.hidden, .app-container', { timeout: 15000 });
await desk.waitForTimeout(2000);
await desk.addStyleTag({ content: maskCss });
const newChat = desk.locator('[data-action="new-chat"]').first();
if (await newChat.isVisible().catch(() => false)) await newChat.click();
await desk.waitForTimeout(800);
await shot(desk, 'shot-desktop.png');

const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const mobile = await phone.newPage();
await mobile.goto(hub, { waitUntil: 'networkidle', timeout: 30000 });
await mobile.waitForTimeout(800);
await shot(mobile, 'shot-phone-login.png');
if (await mobile.locator('#auth-password').isVisible().catch(() => false)) {
  await mobile.fill('#auth-password', password);
  await mobile.click('#auth-login-form button[type="submit"]');
  await mobile.waitForTimeout(2000);
}
await mobile.addStyleTag({ content: maskCss });
await shot(mobile, 'shot-phone.png');

await browser.close();
