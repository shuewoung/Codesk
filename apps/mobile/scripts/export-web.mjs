import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileDir, '../..');
const outDir = path.join(mobileDir, 'dist-web');
const webDir = path.join(repoRoot, 'apps', 'web');

const result = spawnSync(
  'npx',
  ['expo', 'export', '--platform', 'web', '--output-dir', 'dist-web'],
  { cwd: mobileDir, stdio: 'inherit', shell: true },
);
if (result.status !== 0) process.exit(result.status || 1);

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

copyIfExists(path.join(webDir, 'host.html'), path.join(outDir, 'host.html'));
copyIfExists(path.join(webDir, 'favicon-192.png'), path.join(outDir, 'favicon-192.png'));
copyIfExists(path.join(webDir, 'icons', 'codesk-app.png'), path.join(outDir, 'icons', 'codesk-app.png'));
console.log(`[export-web] ${outDir}`);
