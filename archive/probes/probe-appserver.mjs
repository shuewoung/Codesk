#!/usr/bin/env node
// 直接 spawn codex app-server，问 thread/list，验证 vscode 来源会话是否返回
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODEX = process.env.CODEX_CLI_PATH || path.resolve(here, '..', '..', 'codex-bin', 'codex.exe');
const proc = spawn(CODEX, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n');
const results = [];

proc.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { results.push(JSON.parse(line)); } catch {}
  }
});
proc.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(2500);
send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'probe', title: 'probe', version: '0.0.1' } } });
await wait(1500);
send({ id: 'r1', method: 'thread/list', params: { limit: 15, useStateDbOnly: true, sourceKinds: [], sortKey: "updated_at", archived: false } });
await wait(4000);

const listResp = results.find((m) => m.id === 'r1');
if (listResp?.result?.data) {
  console.log('thread/list 返回', listResp.result.data.length, '条:');
  listResp.result.data.forEach((t, i) => {
    console.log(String(i + 1).padStart(2),
      String(t.source?.kind ?? t.source ?? '?').padEnd(8),
      new Date((t.updatedAt ?? t.recencyAt ?? 0) * 1000).toISOString().slice(5, 16),
      (t.name ?? t.preview ?? t.title ?? '').slice(0, 34));
  });
} else {
  console.log('响应:', JSON.stringify(listResp)?.slice(0, 500));
  console.log('\n其他消息样本:', results.slice(0, 5).map((m) => JSON.stringify(m).slice(0, 120)).join('\n'));
}
proc.kill();
process.exit(0);
