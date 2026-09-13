import type { Project, Thread } from './types';

/** Zero/missing timestamps are treated as unknown; invalid mtime falls back to updatedAt. */
export function threadTime(thread: Pick<Thread, 'mtimeMs' | 'updatedAt'>): number {
  if (Number.isFinite(thread.mtimeMs) && thread.mtimeMs! > 0 && thread.mtimeMs! <= 8.64e15) return thread.mtimeMs!;
  const parsed = thread.updatedAt ? Date.parse(thread.updatedAt) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function sortThreadsByRecent(threads: readonly Thread[]): Thread[] {
  return threads.slice().sort((a, b) => threadTime(b) - threadTime(a));
}

export function isUnsentPlaceholderThread(thread: Pick<Thread, 'title'>): boolean {
  const title = String(thread.title || '').trim();
  return !title || title === '新聊天' || title === '新对话' || /\/新聊天$/.test(title);
}

export function relativeThreadTime(thread: Pick<Thread, 'mtimeMs' | 'updatedAt'>, now: number): string {
  const time = threadTime(thread);
  if (!time || !Number.isFinite(now)) return '时间未知';
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`;
  return `${Math.floor(minutes / 1440)}天前`;
}

export function recentThreadRows(
  threads: readonly Thread[], projects: readonly Project[], archivedIds: readonly string[], query: string,
): { thread: Thread; projectName: string }[] {
  const archived = new Set(archivedIds);
  const namesById = new Map<string, string>();
  const namesByCwd = new Map<string, string>();
  for (const project of projects) {
    if (project.cwd) namesByCwd.set(project.cwd, project.name);
    for (const thread of project.threads) namesById.set(thread.id, project.name);
  }
  const q = query.trim().toLowerCase();
  const matches = threadQueryMatcher(query, projects);
  return sortThreadsByRecent(threads.filter((t) => !archived.has(t.id) && !isUnsentPlaceholderThread(t)))
    .map((thread) => ({
      thread,
      projectName: thread.projectName?.trim() || namesById.get(thread.id) || (thread.cwd ? namesByCwd.get(thread.cwd) : '') || '无项目',
    }))
    .filter(({ thread, projectName }) => !q || matches(thread) || projectName.toLowerCase().includes(q));
}

function threadQueryMatcher(query: string, projects: readonly Project[]) {
  const q = query.trim().toLowerCase();
  const byId = new Map<string, Project>();
  const byCwd = new Map<string, Project>();
  for (const project of projects) {
    if (project.cwd && !byCwd.has(project.cwd)) byCwd.set(project.cwd, project);
    for (const thread of project.threads) if (!byId.has(thread.id)) byId.set(thread.id, project);
  }
  return (thread: Thread): boolean => {
    if (!q) return true;
    const project = byId.get(thread.id) || byCwd.get(thread.cwd || '');
    return [thread.title, thread.projectName, thread.cwd, project?.name, project?.cwd]
      .some(value => String(value || '').toLowerCase().includes(q));
  };
}

export function matchesThreadQuery(thread: Thread, query: string, projects: readonly Project[] = []): boolean {
  return threadQueryMatcher(query, projects)(thread);
}

export function projectExpansionKey(project: Pick<Project, 'id' | 'cwd' | 'name'>): string {
  return project.id || project.cwd || project.name;
}

export type CatalogRow =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'project'; key: string; project: Project; open: boolean }
  | { kind: 'thread'; key: string; thread: Thread; indent?: boolean; archived?: boolean };

export function catalogRows(options: {
  threads: readonly Thread[]; projects: readonly Project[]; archivedIds: readonly string[];
  archivedThreads: readonly Thread[]; pinnedIds: readonly string[];
  query: string; openProjects: Readonly<Record<string, boolean>>;
}): CatalogRow[] {
  const { projects, query, openProjects } = options;
  const matches = threadQueryMatcher(query, projects);
  const archived = new Set([...options.archivedIds, ...options.archivedThreads.map(t => t.id)]);
  const visible = options.threads.filter(t => !archived.has(t.id) && matches(t));
  const rows: CatalogRow[] = [];
  const section = (key: string, title: string) => rows.push({ kind: 'section', key, title });
  const threads = (key: string, items: readonly Thread[], indent = false, isArchived = false) => {
    const seen = new Set<string>();
    for (const thread of items) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      rows.push({ kind: 'thread', key: `${key}:thread:${thread.id}`, thread, indent, archived: isArchived });
    }
  };
  const filteredProjects = projects.map(project => ({ ...project,
    threads: project.threads.filter(t => !archived.has(t.id) && matches(t)),
  })).filter(p => !query.trim() || p.threads.length || [p.name, p.cwd].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())));
  const addProjects = (prefix: string, items: Project[]) => {
    items.forEach((project, index) => {
      const key = `${prefix}:project:${project.id || project.cwd || project.name}:${index}`;
      const open = !!query.trim() || !!(openProjects[projectExpansionKey(project)] ?? openProjects[project.name]);
      rows.push({ kind: 'project', key, project, open });
      if (open) threads(key, project.threads, true);
    });
  };
  const waiting = visible.filter(t => t.needsApproval || t.status === 'waiting_approval');
  if (waiting.length) { section('waiting', '等待批准'); threads('waiting', waiting); }
  const pinned = visible.filter(t => t.isPinned || options.pinnedIds.includes(t.id));
  const pinnedProjects = filteredProjects.filter(p => p.isPinned);
  if (pinned.length || pinnedProjects.length) { section('pinned', '置顶'); addProjects('pinned', pinnedProjects); threads('pinned', pinned); }
  if (filteredProjects.length) { section('projects', '项目'); addProjects('catalog', filteredProjects); }
  const waitingIds = new Set(waiting.map(t => t.id));
  const recent = sortThreadsByRecent(visible.filter(t => !isUnsentPlaceholderThread(t) && !waitingIds.has(t.id))).slice(0, 20);
  if (recent.length) { section('recent', '最近'); threads('recent', recent); }
  const archivedMatches = options.archivedThreads.filter(t => matches(t));
  if (archivedMatches.length) { section('archived', '已归档'); threads('archived', archivedMatches, false, true); }
  return rows;
}
