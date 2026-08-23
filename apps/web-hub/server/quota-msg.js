export function isQuotaExhausted(usage) {
  const pct = Number(usage && usage.primaryUsedPercent);
  return Number.isFinite(pct) && pct >= 100;
}

export function isQuotaError(text) {
  return /quota|rate[\s_-]*limit|usage[\s_-]*limit|too many requests|429|insufficient[_-]?quota|tokens? exceeded|limit reached|额度/i.test(
    String(text || ''),
  );
}

export function formatQuotaReset(resetAtMs, now = Date.now()) {
  const t = Number(resetAtMs);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (t <= now) return '';
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = Math.floor((d.getTime() - start.getTime()) / 86400000);
  if (day === 0) return `今天 ${hm}`;
  if (day === 1) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function quotaExhaustedMessage(usage, errText = '') {
  const when = formatQuotaReset(usage && usage.resetAtMs);
  if (when) return `额度用完，${when} 重置后再试`;
  if (isQuotaError(errText)) return '额度用完或请求太频繁，请稍后再试';
  return '额度用完，请稍后再试';
}
