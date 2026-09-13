import fs from 'node:fs';
import crypto from 'node:crypto';

// Offline evidence, 2026-09-12: selected Desktop codex-cli 0.154.0-alpha.6.2,
// `app-server generate-json-schema --experimental --out <temporary directory>`.
// ClientRequest includes thread/unsubscribe({threadId}); response status is
// unsubscribed | notSubscribed | notLoaded. This proves subscription support,
// NOT writer-lock release semantics. Never probe a live thread to find out.
const VERIFIED_SHA256 = '081e4de4be8e38fac6ed4d95e3b1a0b9f6d31c090ddc36e1696b349fe406f575';
const verifiedFiles = new Map();
function verifiedBinary(file) {
  if (!file) return false;
  try {
    const stat = fs.statSync(file);
    const key = `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (!verifiedFiles.has(key)) {
      verifiedFiles.clear();
      verifiedFiles.set(key, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === VERIFIED_SHA256);
    }
    return verifiedFiles.get(key);
  } catch { return false; }
}

export function getHandoffCapabilities(client) {
  const verified = verifiedBinary(client?.client?.codexPath);
  return {
    unsubscribeProtocol: verified ? true : null,
    perThreadWriterRelease: false,
    globalIdleRelease: true,
    scope: 'global',
    reason: 'per_thread_writer_release_unverified',
    evidence: verified ? 'codex-cli 0.154.0-alpha.6.2 offline JSON schema; unsubscribe is not proven writer release' : 'current binary not verified',
    userInput: { local: true, follower: false },
  };
}

// Must be called synchronously inside the caller's write-action gate. `inflight`
// counts OTHER actions admitted before/during owner discovery, not just RPCs.
// This function never starts an app-server, sends unsubscribe, or deletes locks.
export function handoffThread({ client, threadId, inflight = 0 } = {}) {
  const capabilities = getHandoffCapabilities(client);
  const result = { ok: false, scope: 'global', threadId, releasedThreadIds: [], blockingThreadIds: [], capabilities };
  const reject = (code, ids = []) => ({ ...result, code, blockingThreadIds: ids });
  if (!threadId || !client?.ownedThreads?.has(threadId)) return reject('not_owned');
  if (!Number.isFinite(inflight) || inflight < 0 || inflight > 0 || client.client?.pending?.size > 0 || client.client?.startingPromise) {
    return reject('inflight_actions');
  }
  const ids = [...client.ownedThreads];
  const busy = new Set();
  const unknown = [];
  for (const id of ids) {
    const state = client.runtimeStatus?.(id);
    if (state?.busy === true) busy.add(id);
    else if (!state?.known || state.busy !== false) unknown.push(id);
  }
  for (const entry of [...(client.pendingApprovals?.values() || []), ...(client.pendingUserInputs?.values() || [])]) {
    // Even a nonblocking outstanding request must not be dropped on handoff.
    busy.add(entry.threadId || threadId);
  }
  if (busy.size) return reject([...busy].some((id) => id !== threadId) ? 'other_threads_busy' : 'thread_busy', [...busy]);
  if (unknown.length) return reject('runtime_unknown', unknown);
  try { client.releaseAll(); }
  catch { return reject('release_failed'); }
  // stop() is synchronous, but OS process exit/writer release is asynchronous.
  // Do not promise that Desktop has acquired the writer, nor remove its lock.
  return { ...result, ok: true, code: 'released', releasedThreadIds: ids, releaseRequested: true, writerReleaseConfirmed: false };
}
