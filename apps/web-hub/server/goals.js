import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function packGoal(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function withCopy(dbPath, fn) {
  if (!fs.existsSync(dbPath)) return fn(null);
  const walPath = dbPath + '-wal';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-goals-'));
  try {
    const copy = path.join(tmpDir, 'goals_1.sqlite');
    fs.copyFileSync(dbPath, copy);
    if (fs.existsSync(walPath)) fs.copyFileSync(walPath, copy + '-wal');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function createGoalsStore(codexHome) {
  const dbPath = path.join(codexHome, 'goals_1.sqlite');

  function getThreadGoal(threadId) {
    const id = String(threadId || '').trim();
    if (!id) return null;
    try {
      return withCopy(dbPath, (db) => {
        if (!db) return null;
        const row = db.prepare('SELECT * FROM thread_goals WHERE thread_id = ?').get(id);
        return packGoal(row);
      });
    } catch {
      return null;
    }
  }

  function setThreadGoal(threadId, objective) {
    const id = String(threadId || '').trim();
    if (!id) throw new Error('缺少会话');
    const text = String(objective || '').trim();
    const now = Date.now();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      if (!text) {
        db.prepare('DELETE FROM thread_goals WHERE thread_id = ?').run(id);
        return null;
      }
      const existing = db.prepare('SELECT * FROM thread_goals WHERE thread_id = ?').get(id);
      if (existing) {
        db.prepare(
          'UPDATE thread_goals SET objective = ?, status = ?, updated_at_ms = ? WHERE thread_id = ?',
        ).run(text, 'active', now, id);
        return packGoal({ ...existing, objective: text, status: 'active', updated_at_ms: now });
      }
      const goalId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO thread_goals (
          thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'active', NULL, 0, 0, ?, ?)`,
      ).run(id, goalId, text, now, now);
      return packGoal({
        thread_id: id,
        goal_id: goalId,
        objective: text,
        status: 'active',
        token_budget: null,
        tokens_used: 0,
        time_used_seconds: 0,
        created_at_ms: now,
        updated_at_ms: now,
      });
    } finally {
      db.close();
    }
  }

  return { getThreadGoal, setThreadGoal };
}
