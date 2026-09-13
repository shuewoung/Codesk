import fs from 'node:fs';
import path from 'node:path';
import { isWriterLockError } from './appserver.js';

export function writerSafetyError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

export async function discoverThreadOwner(ipc, threadId) {
  try {
    const ownerId = await ipc.findOwner(threadId);
    if (typeof ownerId === 'string' && ownerId.trim()) return { status: 'found', ownerId };
    if (ownerId === null) return { status: 'none' };
  } catch { /* A failed query is never evidence that a writer is absent. */ }
  return { status: 'unknown' };
}

// No app-server startup until discovery has explicitly ruled out an owner,
// or the caller has proven the desktop is absent (no process AND no ipc pipe).
export async function routeWriterSend({ client, ipc, threadId, isLive, waitForOwnerOrIdle, followerSend, localSend, isDesktopAbsent, log }) {
  const note = (info) => { try { log?.(info); } catch { /* diagnostics must never break routing */ } };
  const desktopAbsent = async () => {
    try { return (await isDesktopAbsent?.()) === true; } catch { return false; }
  };
  // unknown + 桌面确实不在 → 按 none 处理，允许本地接管；否则维持 writer_owner_unknown。
  const settleOwner = async (owner) => (
    owner.status === 'unknown' && await desktopAbsent() ? { status: 'none' } : owner
  );
  // 正常获取锁：resume 冲突时保留 writer_lock_conflict（前端有强制删锁路径），其它错误原样上抛。
  const localTakeover = async (via) => {
    await client.ensureStarted();
    try {
      await client.resumeThread(threadId); // Normal acquisition only: never delete a lock here.
      note({ stage: 'takeover-resumed', via });
    } catch (error) {
      if (isWriterLockError(error)) {
        note({ stage: 'takeover-lock-conflict', via });
        throw writerSafetyError('writer_lock_conflict', '会话写入锁仍被占用，已避免接管；确认桌面已关闭后可强制清锁');
      }
      throw error;
    }
    return { action: await localSend(), follower: false };
  };

  // Owned IDs only describe a live connection generation, never historical
  // ownership. Mocks/older adapters without `running` retain compatibility.
  if (client.running === false) client.ownedThreads.delete(threadId);
  if (client.ownedThreads.has(threadId)) {
    note({ stage: 'local-owned' });
    return { action: await localSend(), follower: false };
  }
  let owner = await settleOwner(await discoverThreadOwner(ipc, threadId));
  note({ stage: 'discover', attempt: 0, status: owner.status, ownerId: owner.ownerId || null });
  let followerNoClient = false;
  const attemptedOwnerIds = []; // 两轮 follower 实际投递的 ownerId，用于区分幽灵（恒定）与真实抖动（变化）
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (owner.status === 'unknown') {
      note({ stage: 'owner-unknown', attempt });
      throw writerSafetyError('writer_owner_unknown', '无法确认会话持锁端，已避免接管；请确认桌面连接后重试');
    }
    if (owner.status === 'none' && isLive()) {
      owner = await settleOwner(await waitForOwnerOrIdle());
      if (owner.status === 'unknown') {
        note({ stage: 'owner-unknown', attempt });
        throw writerSafetyError('writer_owner_unknown', '无法确认会话持锁端，已避免接管；请稍后重试');
      }
      if (owner.status === 'none' && isLive()) {
        note({ stage: 'live-conflict', attempt });
        throw writerSafetyError('writer_lock_conflict', '会话仍在运行，已避免抢锁；请等待结束后重试');
      }
      note({ stage: 'wait-result', attempt, status: owner.status, ownerId: owner.ownerId || null });
    }
    if (owner.status === 'none') {
      note({ stage: 'takeover', attempt, via: 'none' });
      return await localTakeover('none');
    }
    attemptedOwnerIds.push(owner.ownerId);
    const followed = await followerSend(owner.ownerId);
    if (followed.ok) {
      note({ stage: 'follower-ok', attempt, ownerId: owner.ownerId, action: followed.action });
      return { action: followed.action, follower: true };
    }
    // tryFollowerSend 只在 no-client-found 时返回 ok:false；其它失败直接上抛，绝不本地兜底。
    followerNoClient = true;
    note({ stage: 'follower-no-client', attempt, ownerId: owner.ownerId });
    owner = await settleOwner(await discoverThreadOwner(ipc, threadId));
    note({ stage: 'discover', attempt: attempt + 1, status: owner.status, ownerId: owner.ownerId || null });
  }
  if (owner.status === 'unknown') {
    note({ stage: 'owner-unknown', attempt: 2 });
    throw writerSafetyError('writer_owner_unknown', '无法确认会话持锁端，已避免接管；请稍后重试');
  }
  if (followerNoClient) {
    // 两轮 follower 都 no-client-found：重发现为 none（真消失）或 found（注册表幽灵 owner）都由 Hub 接管。
    // 幽灵场景 ownerId 恒定；仅当两轮间 ownerId 确实变化且新 owner 也投递失败（真实持锁端抖动）时保守拒绝。
    const ownerChurned = new Set(attemptedOwnerIds).size > 1;
    if (ownerChurned && owner.status === 'found') {
      note({ stage: 'churn-conflict', ownerIds: attemptedOwnerIds });
      throw writerSafetyError('writer_lock_conflict', '持锁端已变化，请重试发送');
    }
    note({ stage: 'takeover-after-no-client', status: owner.status, ownerId: owner.ownerId || null });
    return await localTakeover('follower-no-client');
  }
  // 保底兜底：正常离开循环必然经过上面的 no-client 分支，这里维持保守拒绝。
  note({ stage: 'churn-conflict' });
  throw writerSafetyError('writer_lock_conflict', '持锁端已变化，请重试发送');
}

export function normalizeWriterThreadId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^(?:thread-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw writerSafetyError('invalid_thread_id', 'threadId 必须是严格 UUID', 400);
  }
  return value.replace(/^thread-/i, '').toLowerCase();
}

export function forceClearWriterLock(codexHome, body, { isHolderAlive } = {}) {
  if (body?.confirmed !== true) {
    throw writerSafetyError('confirmation_required', '必须明确确认 confirmed:true', 400);
  }
  const threadId = normalizeWriterThreadId(body?.threadId);
  const directory = path.join(codexHome, 'thread-writer-locks');
  const target = path.join(directory, `${threadId}.lock`);
  let dirStat;
  let stat;
  try {
    dirStat = fs.lstatSync(directory);
    stat = fs.lstatSync(target);
  } catch (error) {
    // 锁不存在（或目录缺失）：行为不变，幂等返回 cleared:false
    if (error.code === 'ENOENT') return { ok: true, cleared: false, threadId };
    throw writerSafetyError('writer_lock_clear_failed', '无法删除写入锁文件', 500);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw writerSafetyError('unsafe_lock_file', '锁目录不是安全的普通目录');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw writerSafetyError('unsafe_lock_file', '拒绝删除符号链接或非普通锁文件');
  }
  // 持有者存活护栏：锁文件存在 + 桌面/其它 codex 进程仍在运行 → 409 holder_alive。
  // 携带 acknowledgeHolderAlive:true（用户明确确认风险）才放行兜底强删。
  if (body?.acknowledgeHolderAlive !== true && typeof isHolderAlive === 'function') {
    let holderAlive = false;
    try { holderAlive = isHolderAlive(threadId) === true; } catch { /* 探测失败不阻断 */ }
    if (holderAlive) {
      throw Object.assign(
        writerSafetyError(
          'holder_alive',
          '桌面/其他codex进程仍在运行…请先关闭桌面该会话或退出桌面；确认风险请携带acknowledgeHolderAlive重试',
          409
        ),
        { holderAlive: true }
      );
    }
  }
  try {
    fs.unlinkSync(target);
    return { ok: true, cleared: true, threadId };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, cleared: false, threadId };
    if (error.status) throw error;
    // Do not expose paths, lock contents, or platform error details to callers/logs.
    throw writerSafetyError('writer_lock_clear_failed', '无法删除写入锁文件', 500);
  }
}

export function handleForceClearWriterLock(req, res, { codexHome, sendJson, isHolderAlive, audit = console.info }) {
  let body = '';
  let bytes = 0;
  let finished = false;
  const fail = (status, code, error) => {
    if (finished) return;
    finished = true;
    audit(`[writer-lock] force-clear rejected code=${code}`);
    sendJson(req, res, status, { ok: false, code, error });
  };
  req.on('data', (chunk) => {
    if (finished) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4096) return fail(413, 'body_too_large', '请求体过大');
    body += chunk;
  });
  req.on('error', () => fail(400, 'invalid_request', '请求读取失败'));
  req.on('end', () => {
    if (finished) return;
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return fail(400, 'invalid_json', '无效 JSON'); }
    try {
      const result = forceClearWriterLock(codexHome, parsed, { isHolderAlive });
      finished = true;
      audit(`[writer-lock] force-clear threadId=${result.threadId} cleared=${result.cleared}`);
      sendJson(req, res, 200, result);
    } catch (error) {
      if (error.code === 'holder_alive') {
        // 与前端契约：{ error:'holder_alive', holderAlive:true, message }
        if (finished) return;
        finished = true;
        audit('[writer-lock] force-clear rejected code=holder_alive');
        sendJson(req, res, error.status || 409, {
          ok: false,
          code: 'holder_alive',
          error: 'holder_alive',
          holderAlive: true,
          message: error.message,
        });
        return;
      }
      fail(error.status || 500, error.code || 'writer_lock_clear_failed', error.message);
    }
  });
}
