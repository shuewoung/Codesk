import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'apps/web-hub/server/.jpush.json');
const dest = process.argv[2];
if (!dest) {
  console.error('usage: write-jpush-env.mjs <out>');
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const key = raw.appKey || raw.app_key || '';
const secret = raw.masterSecret || raw.master_secret || '';
if (!key || !secret) {
  console.error('missing jpush key/secret');
  process.exit(1);
}
fs.writeFileSync(dest, `JPUSH_APP_KEY=${key}\nJPUSH_MASTER_SECRET=${secret}\n`, { mode: 0o600 });
console.log('wrote env snippet');
