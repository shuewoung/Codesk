// 强制删锁交互的纯逻辑：提示文案、holder_alive 错误识别、二次确认决策。
// 保持无依赖、可被 api.ts 与界面层共用，也便于单测覆盖确认流程。

export const HOLDER_ALIVE_CODE = 'holder_alive';

/** 首次强制删锁确认文案（含桌面/codex 进程存活风险提示）。 */
export const FORCE_CLEAR_WARNING = '仅删除当前会话的锁文件，不会停止桌面任务，也不代表 writer 已释放。\n\n如果桌面仍在写入，可能造成并发冲突或数据损坏。请先停止桌面会话，再确认强制删锁。\n\n若桌面端或其codex进程仍在运行，删锁可能导致并发写入/会话损坏，请优先在桌面关闭该会话或退出桌面。';

/** Hub 返回体是否表明持锁端（桌面/codex 进程）仍存活（契约：409 {error:'holder_alive',holderAlive:true,message}）。 */
export function isHolderAliveResponse(json: Record<string, unknown> | null | undefined): boolean {
  return json?.error === HOLDER_ALIVE_CODE || json?.holderAlive === true;
}

/** 已抛出的错误是否为 holder_alive（错误对象含 code/error/holderAlive 标识字段）。 */
export function isHolderAliveError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: unknown; error?: unknown; holderAlive?: unknown };
  return err.code === HOLDER_ALIVE_CODE || err.error === HOLDER_ALIVE_CODE || err.holderAlive === true;
}

/** holder_alive 409 后的第二次更强确认文案（可附带服务端 message）。 */
export function holderAliveConfirmText(message?: string): string {
  const detail = message ? `${message}\n\n` : '';
  return `检测到桌面进程仍在运行。\n\n${detail}此时删除锁文件可能导致并发写入或会话损坏，仍建议优先在桌面关闭该会话或退出桌面。\n\n确定要强行删除请再确认。`;
}

export type ForceClearRetryPlan = 'confirm-holder-alive' | 'show-error';

/**
 * 请求失败后的下一步：仅当首次（未携带 acknowledgeHolderAlive）请求失败
 * 且错误可识别为 holder_alive 时，才升级为第二次更强确认；其余一律按普通错误展示。
 */
export function planForceClearRetry(error: unknown, acknowledged: boolean): ForceClearRetryPlan {
  return !acknowledged && isHolderAliveError(error) ? 'confirm-holder-alive' : 'show-error';
}
