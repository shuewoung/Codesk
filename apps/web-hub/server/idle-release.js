// ----------------------------------------------------
// Hub 空闲写锁自动释放（纯函数，便于测试）
// ----------------------------------------------------
// Hub 通过 resume/start 抢到的会话写入权会一直持有到进程重启，导致桌面端
// 长期被挡。这里集中“是否应释放”的判定逻辑：
//   安全条件（释放前二次确认）：
//     1. 无进行中的发送/审批/停止（inflight 计数）
//     2. 无任何 owned 线程处于 live / running / waiting_approval
//   触发条件（满足其一）：
//     a. 全局最后写活动时间距今 ≥ HUB_IDLE_RELEASE_HOURS（默认 4，0 禁用）
//     b. 到达 HUB_DAILY_RELEASE_AT 指定的每日本地时间 "HH:MM"（每日一次）
// 读取方式与现有 env 配置一致；index.js 启动时打印生效配置。
// ----------------------------------------------------

export const DEFAULT_IDLE_RELEASE_HOURS = 4;

// "HH:MM"（本地时间）→ 归一化 "HH:MM"，非法或缺省返回 null（禁用）
export function parseDailyReleaseAt(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function parseIdleReleaseConfig(env = process.env) {
  const raw = env.HUB_IDLE_RELEASE_HOURS;
  const text = String(raw == null ? '' : raw).trim();
  let idleHours = DEFAULT_IDLE_RELEASE_HOURS;
  if (text !== '') {
    const value = Number(text);
    // 非法值回退默认（与现有 env 配置的容错风格一致），负数按 0 处理
    idleHours = Number.isFinite(value) ? Math.max(0, value) : DEFAULT_IDLE_RELEASE_HOURS;
  }
  const dailyAt = parseDailyReleaseAt(env.HUB_DAILY_RELEASE_AT);
  return {
    idleHours,
    idleMs: idleHours * 60 * 60 * 1000,
    dailyAt,
    enabled: idleHours > 0 || !!dailyAt,
  };
}

// now 当天（本地时区）dailyAt 对应的时间戳；跨日/夏令时由 Date 本地语义处理
export function dailySlotStartMs(dailyAt, now) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(dailyAt || ''));
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

// 是否应释放 Hub 持有的全部写入权。
// 入参：owned 线程 busy 状态（live/running/waiting_approval 的聚合布尔）、
//       inflight 数、lastActivityAt、lastDailyReleaseAt、now、配置。
// 返回 { release, reason }；release=false 时 reason 说明原因便于日志排查。
export function shouldReleaseIdleWriterLocks({
  ownedCount = 0,
  ownedBusy = false,
  runtimeStates = null,
  inflight = 0,
  lastActivityAt = null,
  lastDailyReleaseAt = 0,
  now = Date.now(),
  config = null,
} = {}) {
  if (ownedCount <= 0) return { release: false, reason: 'no_owned_threads' };
  if (!config || !config.enabled) return { release: false, reason: 'disabled' };
  if (inflight > 0) return { release: false, reason: 'inflight_actions' };
  if (runtimeStates != null) {
    const states = Array.from(runtimeStates);
    if (states.some((s) => s?.busy === true)) return { release: false, reason: 'owned_thread_busy' };
    if (states.length !== ownedCount || states.some((s) => !s?.known || s.busy !== false)) return { release: false, reason: 'runtime_unknown' };
  } else if (ownedBusy) return { release: false, reason: 'owned_thread_busy' };

  // a. 空闲阈值（HUB_IDLE_RELEASE_HOURS > 0 时启用）
  if (config.idleHours > 0) {
    if (lastActivityAt == null) return { release: false, reason: 'no_activity_record' };
    if (now - lastActivityAt >= config.idleMs) return { release: true, reason: 'idle_timeout' };
  }

  // b. 每日定点（HUB_DAILY_RELEASE_AT）：到点后第一次安全窗口触发，每日一次
  if (config.dailyAt) {
    const slotStart = dailySlotStartMs(config.dailyAt, now);
    if (slotStart != null && now >= slotStart && lastDailyReleaseAt < slotStart) {
      return { release: true, reason: 'daily_schedule' };
    }
    if (slotStart != null && lastDailyReleaseAt >= slotStart) {
      return { release: false, reason: 'daily_already_done' };
    }
    return { release: false, reason: 'daily_not_due' };
  }

  return { release: false, reason: 'not_idle_enough' };
}
