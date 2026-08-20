import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = ['unit.mjs', 'http.mjs', 'relay-outbound.mjs'];
let failed = 0;

for (const file of files) {
  console.log(`\n===== ${file} =====`);
  const child = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code) failed += 1;
}

process.exit(failed ? 1 : 0);
