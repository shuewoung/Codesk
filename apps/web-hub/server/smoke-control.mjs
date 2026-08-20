#!/usr/bin/env node
// 控制闭环冒烟：全部操作只针对本脚本自建的会话，不触碰桌面会话
// 验证链：initialize → thread/start → turn/start(流式) → turn/steer → turn/interrupt → thread/list
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer, isWriterLockError } from './appserver.js';

const cwd = path.join(os.tmpdir(), 'remote-hub-smoke');
process.env.NODE_ENV = process.env.NODE_ENV || 'smoke';

const codex = new CodexAppServer();
const log = (...a) => console.log('[smoke]', ...a);

const activities = [];
codex.on('thread-activity', ({ threadId, method }) => {
  activities.push(method);
});

try {
  await codex.ensureStarted();
  log('1. initialize ✅');

  const startR = await codex.startThread({ cwd });
  const threadId = startR?.thread?.id;
  if (!threadId) throw new Error('thread/start 未返回 thread.id: ' + JSON.stringify(startR).slice(0, 300));
  log(`2. thread/start ✅ threadId=${threadId}`);

  const turnR = await codex.sendUserTurn({
    threadId,
    text: '请从 1 慢慢数到 30，每个数字单独一行，数完为止。',
  });
  const turnId = turnR?.turn?.id;
  log(`3. turn/start ✅ turnId=${turnId}`, turnR?.turn ? '' : JSON.stringify(turnR).slice(0, 200));

  // 等 3 秒让 turn 跑起来，然后 steer
  await new Promise((r) => setTimeout(r, 3000));
  try {
    await codex.steerTurn({ threadId, text: '改为主意：只输出到 5 就停。', expectedTurnId: turnId });
    log('4. turn/steer ✅');
  } catch (e) {
    log(`4. turn/steer ⚠️ ${e.message}`);
  }

  // 再等 2 秒，然后打断
  await new Promise((r) => setTimeout(r, 2000));
  try {
    await codex.interruptTurn(threadId);
    log('5. turn/interrupt ✅');
  } catch (e) {
    log(`5. turn/interrupt ⚠️ ${e.message}`);
  }

  // 等收尾通知
  await new Promise((r) => setTimeout(r, 3000));

  const threads = await codex.listThreads();
  const mine = threads.find((t) => t.id === threadId || t.sessionId === threadId);
  log(`6. thread/list ✅ 共 ${threads.length} 条，自建会话${mine ? '可见' : '不可见 ⚠️'}`);

  log('通知流方法:', [...new Set(activities)].join(', ') || '(无)');
  log('\n=== 冒烟通过 ===');
} catch (e) {
  console.error('[smoke] 失败:', e.message);
  if (isWriterLockError(e)) console.error('[smoke] writer-lock 冲突（不应发生在自建会话上）');
  process.exitCode = 1;
} finally {
  codex.stop();
}
