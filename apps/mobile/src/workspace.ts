import type { HistoryItem, TimelineNode } from './types';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export type PlanStep = {
  step: string;
  status: PlanStepStatus;
};

export type PlanState = {
  explanation: string;
  steps: PlanStep[];
};

export type ReviewFile = {
  path: string;
  status?: string;
  add?: number;
  del?: number;
};

function parseArgs(item: HistoryItem): Record<string, unknown> | null {
  let args = item.arguments ?? item.input;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
}

function normalizePlanStatus(raw: unknown): PlanStepStatus {
  const value = String(raw || '').toLowerCase();
  if (value === 'completed' || value === 'complete' || value === 'done') return 'completed';
  if (value === 'in_progress' || value === 'in-progress' || value === 'doing') return 'in_progress';
  return 'pending';
}

export function planFromItems(items: HistoryItem[] | undefined): PlanState | null {
  let found: PlanState | null = null;
  for (const item of items || []) {
    const name = String(item.name || item.tool || '');
    if (name !== 'update_plan' && name !== 'plan') continue;
    const args = parseArgs(item);
    const rawSteps = Array.isArray(args?.plan) ? args.plan : Array.isArray(args?.steps) ? args.steps : [];
    const steps = rawSteps
      .map((row) => {
        const rec = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return {
          step: String(rec.step || rec.title || rec.text || ''),
          status: normalizePlanStatus(rec.status),
        };
      })
      .filter((row) => row.step);
    if (!steps.length) continue;
    found = {
      explanation: String(args?.explanation || args?.overview || ''),
      steps,
    };
  }
  return found;
}

export function changedFilesFromGitStatus(status: string): ReviewFile[] {
  const out: ReviewFile[] = [];
  const seen = new Set<string>();
  for (const line of String(status || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const porcelain = trimmed.match(/^([MADRCU?!]{1,2})\s+(.+)$/);
    const named = trimmed.match(/^(modified|new file|deleted|renamed|untracked):\s+(.+)$/i);
    const path = (porcelain?.[2] || named?.[2] || '').replace(/ -> .+$/, '').trim();
    if (!path || seen.has(path) || path.endsWith('/')) continue;
    seen.add(path);
    out.push({ path, status: porcelain?.[1] || named?.[1] || '' });
  }
  return out;
}

export function changedFilesFromDiff(diff: string): ReviewFile[] {
  const out: ReviewFile[] = [];
  const seen = new Set<string>();
  let current: ReviewFile | null = null;
  for (const line of String(diff || '').split('\n')) {
    const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (git) {
      const path = git[2] || git[1];
      if (path && !seen.has(path)) {
        seen.add(path);
        current = { path, add: 0, del: 0 };
        out.push(current);
      } else {
        current = out.find((row) => row.path === path) || null;
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.add = (current.add || 0) + 1;
    if (line.startsWith('-') && !line.startsWith('---')) current.del = (current.del || 0) + 1;
  }
  return out;
}

export function reviewFilesFrom({
  gitStatus,
  gitDiff,
  diffs,
}: {
  gitStatus?: string;
  gitDiff?: string;
  diffs?: TimelineNode[];
}): ReviewFile[] {
  const map = new Map<string, ReviewFile>();
  const add = (row: ReviewFile) => {
    const path = String(row.path || '').trim();
    if (!path) return;
    const prev = map.get(path) || { path };
    map.set(path, {
      path,
      status: row.status || prev.status,
      add: row.add ?? prev.add,
      del: row.del ?? prev.del,
    });
  };
  for (const row of changedFilesFromGitStatus(gitStatus || '')) add(row);
  for (const row of changedFilesFromDiff(gitDiff || '')) add(row);
  for (const node of diffs || []) {
    if (node.kind !== 'diff') continue;
    add({ path: node.path || node.text, add: node.add, del: node.del });
  }
  return [...map.values()];
}

export function buildPlanPrompt(userText: string, existing?: PlanState | null): string {
  const goal = String(userText || '').replace(/^\/plan\s*/i, '').trim();
  const current = existing?.steps.length
    ? `当前计划：\n${existing.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}`
    : '当前还没有计划。';
  return [
    '/plan',
    '',
    '请进入规划模式。先不要改代码或执行命令。用 update_plan 列出分步计划，每一步写清要做什么。',
    current,
    goal ? `目标：\n${goal}` : '如果会话里已有目标，据此规划；否则先根据当前仓库提出计划。',
  ].join('\n');
}

export function buildPlanExecutePrompt(existing?: PlanState | null): string {
  const steps = existing?.steps.length
    ? existing.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')
    : '';
  return [
    '请按当前计划开始执行。遇到需要确认的步骤先问我。',
    steps ? `计划：\n${steps}` : '',
  ].filter(Boolean).join('\n');
}

export function filesMatchingPlanStep(stepText: string, files: { path?: string; text?: string }[]): { path?: string; text?: string }[] {
  const text = String(stepText || '').toLowerCase();
  if (!text) return [];
  const tokens = text.split(/[^a-z0-9_.\\/-]+/i).filter((tok) => tok.length > 2);
  return (files || []).filter((file) => {
    const p = String(file.path || file.text || '').toLowerCase();
    const base = p.split(/[\\/]/).pop() || '';
    if (base && text.includes(base)) return true;
    return tokens.some((tok) => p.includes(tok));
  });
}

export function buildReviewPrompt(userText: string, files: ReviewFile[], gitStatus = ''): string {
  const focus = String(userText || '').replace(/^\/review\s*/i, '').trim();
  const list = files.length
    ? files.map((f) => `- ${f.path}${f.add || f.del ? `  +${f.add || 0}/-${f.del || 0}` : ''}`).join('\n')
    : '(未读到改动文件，请先看 git status / diff)';
  return [
    '/review',
    '',
    '请审查当前工作区的代码改动。重点看正确性、回归风险和可维护性。按文件给出发现（严重程度 + 位置 + 建议）。',
    `审查范围：\n${list}`,
    gitStatus ? `git status：\n${gitStatus.slice(0, 2500)}` : '',
    focus ? `额外关注：\n${focus}` : '',
  ].filter(Boolean).join('\n');
}
