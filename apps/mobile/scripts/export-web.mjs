import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.resolve(mobileDir, '../web-hub/assets');
const outDir = path.join(mobileDir, 'dist-web');
const assets = ['host.html', 'favicon-192.png', 'icons/codesk-app.png'];

function requireFile(file) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
    throw new Error(`[export-web] Missing or empty resource: ${file}`);
  }
}

for (const asset of assets) requireFile(path.join(assetsDir, asset));
// Never leave a previous export (or an archived PWA shell) in a successful build.
fs.rmSync(outDir, { recursive: true, force: true });
const result = spawnSync(process.execPath, [
  path.join(mobileDir, 'node_modules/expo/bin/cli'),
  'export', '--platform', 'web', '--output-dir', 'dist-web',
], { cwd: mobileDir, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

for (const asset of assets) {
  const dest = path.join(outDir, asset);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(assetsDir, asset), dest);
}
for (const asset of ['index.html', ...assets]) requireFile(path.join(outDir, asset));
const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)];
if (!scripts.length) throw new Error('[export-web] Expo entry scripts missing');
const links = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)];
for (const [, src] of [...scripts, ...links]) {
  if (/^(?:https?:)?\/\//.test(src)) throw new Error(`[export-web] Unexpected external entry: ${src}`);
  const file = path.resolve(outDir, `.${src.startsWith('/') ? src : `/${src}`}`.split(/[?#]/)[0]);
  if (!file.startsWith(outDir + path.sep)) throw new Error('[export-web] Invalid entry path');
  requireFile(file);
}
for (const file of ['app.js', 'sw.js']) {
  if (fs.existsSync(path.join(outDir, file))) throw new Error(`[export-web] Archived PWA resource: ${file}`);
}
console.log(`[export-web] Validated ${outDir}`);
