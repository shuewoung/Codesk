export function isQuotaExhausted(usage: { primaryUsedPercent?: number } | null | undefined): boolean {
  const pct = Number(usage?.primaryUsedPercent);
  return Number.isFinite(pct) && pct >= 100;
}

export function isQuotaError(text: string): boolean {
  return /quota|rate[\s_-]*limit|usage[\s_-]*limit|too many requests|429|insufficient[_-]?quota|tokens? exceeded|limit reached|额度/i.test(
    String(text || ''),
  );
}

export function formatQuotaReset(resetAtMs?: number, now = Date.now()): string {
  const t = Number(resetAtMs);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (t <= now) return '';
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = Math.floor((d.getTime() - start.getTime()) / 86400000);
  if (day === 0) return `今天 ${hm}`;
  if (day === 1) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function quotaExhaustedMessage(
  usage?: { resetAtMs?: number; primaryUsedPercent?: number } | null,
  errText = '',
): string {
  const when = formatQuotaReset(usage?.resetAtMs);
  if (when) return `额度用完，${when} 重置后再试`;
  if (isQuotaError(errText)) return '额度用完或请求太频繁，请稍后再试';
  return '额度用完，请稍后再试';
}

export function formatContextUsage(usage?: {
  totalTokens?: number;
  maxContext?: number;
  usedPercent?: number;
} | null): string {
  const total = Number(usage?.totalTokens);
  const max = Number(usage?.maxContext);
  const pct = Number(usage?.usedPercent);
  if (Number.isFinite(total) && Number.isFinite(max) && max > 0) {
    const usedK = Math.round(total / 1000);
    const maxK = Math.round(max / 1000);
    const shown = Number.isFinite(pct) ? `（${Math.round(pct)}%）` : '';
    return `已用 ${usedK}K / ${maxK}K${shown}`;
  }
  if (Number.isFinite(pct)) return `占用 ${Math.round(pct)}%`;
  return '';
}

export function formatQuotaLine(usage?: {
  primaryUsedPercent?: number;
  resetAtMs?: number;
} | null, now = Date.now()): string {
  const used = Number(usage?.primaryUsedPercent);
  const left = Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : null;
  const when = formatQuotaReset(usage?.resetAtMs, now);
  if (left == null && !when) return '';
  if (left == null) return `重置 ${when}`;
  return when ? `账号剩余 ${Math.round(left)}% · ${when} 重置` : `账号剩余 ${Math.round(left)}%`;
}
