#!/usr/bin/env node
// 检查共享 catalog 的 recency 分布
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import path from 'node:path';

const db = new Database(path.join(homedir(), '.codex', 'sqlite', 'codex-dev.db'), { readonly: true });
const rows = db
  .prepare(
    `SELECT thread_id, display_title, source_created_at, source_updated_at, source_recency_at, cwd
     FROM local_thread_catalog WHERE host_id='local' AND missing_candidate=0
     ORDER BY source_recency_at DESC LIMIT 15`
  )
  .all();

for (const r of rows) {
  const rec = new Date(r.source_recency_at * 1000).toISOString().slice(5, 19);
  const upd = new Date(r.source_updated_at * 1000).toISOString().slice(5, 16);
  const dir = path.basename(r.cwd || '');
  console.log(`${rec} | upd ${upd} | ${String(r.display_title || '').slice(0, 26).padEnd(26)} | ${dir}`);
}

// 分布统计：recency 与 updated 的偏差
const all = db.prepare(`SELECT source_updated_at, source_recency_at FROM local_thread_catalog WHERE host_id='local'`).all();
const sameDay = all.filter((r) => Math.abs(r.source_recency_at - r.source_updated_at) < 3600).length;
const recToday = all.filter((r) => r.source_recency_at > 1786810000).length;
console.log(`\n共 ${all.length} 行: recency≈updated(±1h) ${sameDay} 行 | recency 在今天 ${recToday} 行`);
db.close();
