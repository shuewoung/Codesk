import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { HandshakePanel } from '../components/HandshakePanel';
import { EmptyState, ErrorBanner, FolderOutlineIcon, PlusCircleOutlineIcon } from '../components/ui';
import { useSession } from '../session';
import { loadListSort, saveListSort, type ListSort } from '../storage';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import type { Project, Thread } from '../types';

function threadTime(thread: Thread): number {
  return thread.mtimeMs || (thread.updatedAt ? Date.parse(thread.updatedAt) : 0) || 0;
}

function sortThreadsByRecent(threads: Thread[]): Thread[] {
  return threads.slice().sort((a, b) => threadTime(b) - threadTime(a));
}

function sortProjectsByRecent(projects: Project[]): Project[] {
  return projects.slice()
    .map((p) => ({ ...p, threads: sortThreadsByRecent(p.threads) }))
    .sort((a, b) => {
      const tb = Math.max(0, ...b.threads.map(threadTime));
      const ta = Math.max(0, ...a.threads.map(threadTime));
      return tb - ta;
    });
}

function relTime(ms?: number, iso?: string): string {
  const t = ms || (iso ? Date.parse(iso) : 0);
  if (!t) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}小时`;
  return `${Math.round(h / 24)}天`;
}

const webNoOutline = Platform.OS === 'web'
  ? ({ outlineWidth: 0, outlineStyle: 'none' as any } as any)
  : null;

export function ThreadListScreen({
  onOpenThread,
  onSettings,
  onScan,
  selectedId,
}: {
  onOpenThread: (threadId: string) => void;
  onSettings: () => void;
  onScan: () => void;
  selectedId?: string;
}) {
  const session = useSession();
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectError, setNewProjectError] = useState('');
  const [newProjectFocused, setNewProjectFocused] = useState(false);
  const [listSort, setListSort] = useState<ListSort>('catalog');

  useEffect(() => {
    void loadListSort().then(setListSort);
  }, []);

  function changeListSort(next: ListSort) {
    setListSort(next);
    void saveListSort(next);
  }

  function suggestProjectPath() {
    const cwd = session.projects.map((p) => p.cwd).find(Boolean) || '';
    const raw = String(cwd).replace(/[\\/]+$/, '');
    if (!raw) return '';
    const sep = raw.includes('/') && !raw.includes('\\') ? '/' : '\\';
    const parent = raw.replace(/[\\/][^\\/]+$/, '');
    return parent ? `${parent}${sep}` : '';
  }

  function openNewProject() {
    setNewProjectError('');
    setNewProjectPath(suggestProjectPath());
    setNewProjectOpen(true);
  }

  function submitNewProject() {
    const cwd = newProjectPath.trim();
    if (!cwd) {
      setNewProjectError('请填写项目文件夹路径');
      return;
    }
    setNewProjectOpen(false);
    session.createThread(cwd);
  }

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await session.refreshThreads();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!selectedId) return;
    const host = session.projects.find((p) => p.threads.some((t) => t.id === selectedId));
    if (host) setOpenProjects((prev) => ({ ...prev, [host.name]: true }));
  }, [selectedId, session.projects]);

  const q = query.trim().toLowerCase();
  const byRecent = listSort === 'recent';
  const visible = session.threads.filter((t) => !session.archivedIds.includes(t.id));
  const waiting = byRecent
    ? sortThreadsByRecent(visible.filter((t) => t.needsApproval))
    : visible.filter((t) => t.needsApproval);
  const pinnedThreads = byRecent
    ? sortThreadsByRecent(visible.filter((t) => t.isPinned || session.pinnedIds.includes(t.id)))
    : visible.filter((t) => t.isPinned || session.pinnedIds.includes(t.id));
  const pinnedProjects = byRecent
    ? sortProjectsByRecent(session.projects.filter((p) => p.isPinned))
    : session.projects.filter((p) => p.isPinned);
  const recent = useMemo(
    () => sortThreadsByRecent(visible).slice(0, 20),
    [visible],
  );

  const projects = useMemo(() => {
    const src = session.projects.map((p) => ({
      ...p,
      threads: p.threads.filter((t) => !session.archivedIds.includes(t.id)),
    }));
    const filtered = q
      ? src
        .map((p) => ({
          ...p,
          threads: p.threads.filter((t) => (t.title || '').toLowerCase().includes(q)),
        }))
        .filter((p) => p.threads.length || p.name.toLowerCase().includes(q))
      : src;
    return byRecent ? sortProjectsByRecent(filtered) : filtered;
  }, [q, session.projects, session.archivedIds, byRecent]);

  function toggle(name: string) {
    setOpenProjects((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  const offline = session.conn === 'hub_offline';
  const empty = offline
    ? { title: '主机离线', detail: '电脑休眠或 Hub 未运行。电脑醒了才能发。' }
    : session.conn !== 'connected'
      ? { title: '未连接', detail: session.connText }
      : !session.threads.length
        ? { title: '还没有聊天', detail: '点「新建对话」或下拉刷新。若一直空，重新配对一次。' }
        : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.shell }]}>
      <View style={styles.topSection}>
        {/* Brand 标题行 */}
        <View style={styles.brandRow}>
          <Text style={[styles.brandTitle, { color: colors.text }]}>Codesk</Text>
          <View style={styles.brandRight}>
            <View style={[styles.statusMiniDot, { backgroundColor: session.conn === 'connected' ? colors.ok : colors.warn }]} />
            <Text style={{ fontSize: 11, color: colors.muted }}>{session.connText}</Text>
            <Pressable onPress={onSettings} hitSlop={10} style={styles.iconBtn}>
              <Text style={{ color: colors.muted, fontSize: 16 }}>⋯</Text>
            </Pressable>
          </View>
        </View>

        {/* ＋ 新建对话按钮 */}
        <Pressable
          onPress={() => { if (!offline) session.createThread(); }}
          style={({ pressed }) => [styles.actionRowBtn, pressed && { opacity: 0.7 }, offline && { opacity: 0.4 }]}
        >
          <View style={styles.actionIconSlot}>
            <PlusCircleOutlineIcon size={15} color={colors.text} />
          </View>
          <Text style={[styles.actionRowText, { color: colors.text }]}>新建对话</Text>
        </Pressable>

        {/* ＋ 新建项目按钮 */}
        <Pressable
          onPress={openNewProject}
          style={({ pressed }) => [styles.actionRowBtn, pressed && { opacity: 0.7 }]}
        >
          <View style={styles.actionIconSlot}>
            <FolderOutlineIcon size={15} color={colors.text} />
          </View>
          <Text style={[styles.actionRowText, { color: colors.text }]}>新建项目</Text>
        </Pressable>

        {/* 搜索框 */}
        <View style={[styles.searchBox, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <Text style={{ color: colors.muted, fontSize: 13, marginRight: 6 }}>🔍</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索项目或对话"
            placeholderTextColor={colors.muted}
            style={[styles.searchInput, { color: colors.text }, webNoOutline]}
          />
          <Pressable onPress={handleRefresh} hitSlop={8} style={{ padding: 4 }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>↻</Text>
          </Pressable>
        </View>
      </View>
      <ErrorBanner text={session.error || session.feedback} onClose={() => { session.clearError(); session.clearFeedback(); }} />
      {session.handshake.active ? (
        <HandshakePanel
          handshake={session.handshake}
          onRetry={session.mode === 'relay' ? onScan : session.refreshThreads}
          retryLabel={session.handshake.phase === 'offline' ? '再试一次' : (session.mode === 'relay' ? (Platform.OS === 'web' ? '重新连接' : '扫出门码') : '刷新')}
        />
      ) : null}
      {session.paired && session.conn !== 'connected' && !session.handshake.active && (session.handshake.needsRetry || session.conn === 'hub_offline' || session.conn === 'idle') ? (
        <Pressable
          onPress={onScan}
          style={[styles.connectBtn, { backgroundColor: colors.text }]}
        >
          <Text style={{ color: colors.bg, fontWeight: '700', fontSize: 16 }}>
            {Platform.OS === 'web' ? '重新连接' : '扫描出门码'}
          </Text>
        </Pressable>
      ) : null}
      {empty && !session.threads.length ? (
        <View style={{ paddingHorizontal: space.md, gap: 12 }}>
          <EmptyState title={empty.title} detail={empty.detail} />
          <Pressable
            onPress={() => session.createThread()}
            style={[styles.connectBtn, { backgroundColor: colors.text }]}
          >
            <Text style={{ color: colors.bg, fontWeight: '700', fontSize: 16 }}>＋ 新建对话</Text>
          </Pressable>
          <Pressable
            onPress={openNewProject}
            style={[styles.connectBtn, { backgroundColor: colors.shell }]}
          >
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>＋ 新建项目</Text>
          </Pressable>
          <Pressable
            onPress={() => { void session.logout(); }}
            style={[styles.connectBtn, { backgroundColor: colors.shell }]}
          >
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>重新输入家里/出门码</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.text}
              colors={[colors.text]}
            />
          }
        >
          {waiting.length ? <Text style={[styles.section, { color: colors.muted }]}>等待批准</Text> : null}
          {waiting.map((t) => (
            <ThreadLine key={`wait-${t.id}`} thread={t} selected={t.id === selectedId} showTime={byRecent} onPress={() => onOpenThread(t.id)} onPin={() => session.togglePin(t.id)} />
          ))}
          {pinnedThreads.length || pinnedProjects.length ? (
            <Text style={[styles.section, { color: colors.muted }]}>置顶</Text>
          ) : null}
          {pinnedProjects.map((p) => (
            <ProjectBlock
              key={`pin-p-${p.name}`}
              project={p}
              open={!!q || !!openProjects[p.name]}
              selectedId={selectedId}
              showTime={byRecent}
              onToggle={() => toggle(p.name)}
              onPin={() => session.togglePin(p.id || p.name, 'project')}
              onCopyPath={() => { if (p.cwd) void Clipboard.setStringAsync(p.cwd); }}
              onOpenThread={onOpenThread}
              onCreateThread={(cwd) => session.createThread(cwd)}
            />
          ))}
          {pinnedThreads.map((t) => (
            <ThreadLine key={`pin-${t.id}`} thread={t} selected={t.id === selectedId} showTime={byRecent} onPress={() => onOpenThread(t.id)} onPin={() => session.togglePin(t.id)} />
          ))}

          <View style={styles.sectionRow}>
            <Text style={[styles.section, { color: colors.muted, paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 }]}>项目</Text>
            <View style={styles.sortRow}>
              <Pressable
                onPress={() => changeListSort('catalog')}
                style={[styles.sortChip, { borderColor: colors.line, backgroundColor: !byRecent ? colors.card : 'transparent' }]}
              >
                <Text style={{ color: colors.text, fontSize: 11, fontWeight: !byRecent ? '700' : '500' }}>默认</Text>
              </Pressable>
              <Pressable
                onPress={() => changeListSort('recent')}
                style={[styles.sortChip, { borderColor: colors.line, backgroundColor: byRecent ? colors.card : 'transparent' }]}
              >
                <Text style={{ color: colors.text, fontSize: 11, fontWeight: byRecent ? '700' : '500' }}>最近运行</Text>
              </Pressable>
            </View>
          </View>
          {projects.map((p) => (
            <ProjectBlock
              key={p.name}
              project={p}
              open={!!q || !!openProjects[p.name]}
              selectedId={selectedId}
              showTime={byRecent}
              onToggle={() => toggle(p.name)}
              onPin={() => session.togglePin(p.id || p.name, 'project')}
              onCopyPath={() => { if (p.cwd) void Clipboard.setStringAsync(p.cwd); }}
              onOpenThread={onOpenThread}
              onCreateThread={(cwd) => session.createThread(cwd)}
            />
          ))}

          <Text style={[styles.section, { color: colors.muted }]}>最近</Text>
          {(q ? recent.filter((t) => (t.title || '').toLowerCase().includes(q)) : recent).map((t) => (
            <ThreadLine key={t.id} thread={t} selected={t.id === selectedId} showTime onPress={() => onOpenThread(t.id)} onPin={() => session.togglePin(t.id)} />
          ))}
        </ScrollView>
      )}
      {newProjectOpen ? (
        <View style={styles.projectMask}>
          <View style={[styles.projectCard, { backgroundColor: colors.bg, borderColor: colors.line }]}>
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700' }}>新建项目</Text>
            <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>
              填写电脑上的文件夹路径。不存在会自动创建，并在里面开一个新对话。
            </Text>
            <TextInput
              value={newProjectPath}
              onChangeText={(v) => { setNewProjectPath(v); setNewProjectError(''); }}
              onFocus={() => setNewProjectFocused(true)}
              onBlur={() => setNewProjectFocused(false)}
              placeholder="D:\projects\my-app"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.projectInput,
                {
                  backgroundColor: colors.shell,
                  color: colors.text,
                  borderColor: newProjectFocused ? colors.text : colors.line,
                  borderWidth: 1,
                },
                webNoOutline,
              ]}
              onSubmitEditing={submitNewProject}
            />
            {newProjectError ? <Text style={{ color: colors.danger, fontSize: 12 }}>{newProjectError}</Text> : null}
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12 }}>
              <Pressable onPress={() => setNewProjectOpen(false)} hitSlop={8}>
                <Text style={{ color: colors.muted, fontSize: 15 }}>取消</Text>
              </Pressable>
              <Pressable onPress={submitNewProject} hitSlop={8}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>创建</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ProjectBlock({
  project,
  open,
  selectedId,
  showTime,
  onToggle,
  onPin,
  onCopyPath,
  onOpenThread,
  onCreateThread,
}: {
  project: Project;
  open: boolean;
  selectedId?: string;
  showTime?: boolean;
  onToggle: () => void;
  onPin?: () => void;
  onCopyPath?: () => void;
  onOpenThread: (id: string) => void;
  onCreateThread: (cwd?: string) => void;
}) {
  const { colors } = useTheme();
  const session = useSession();

  const workingCount = project.threads.filter((t) => t.isActive || t.status === 'working' || t.working).length;
  const waitingCount = project.threads.filter((t) => t.needsApproval || t.status === 'waiting_approval').length;
  const justFinishedCount = project.threads.filter(
    (t) => !t.isActive && t.status !== 'working' && !t.working && !t.needsApproval && t.status !== 'waiting_approval' && (Date.now() - (t.mtimeMs || 0) < 60000)
  ).length;

  return (
    <View style={styles.projectGroup}>
      <View style={styles.folder}>
        <Pressable onPress={onToggle} onLongPress={onPin} delayLongPress={420} style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
          <FolderOutlineIcon open={open} color={colors.muted} size={15} />
          <View style={{ flex: 1, marginLeft: 6 }}>
            <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '500' }} numberOfLines={1}>
              {project.isPinned ? '📌 ' : ''}{project.name}
            </Text>
            {project.cwd ? (
              <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>{project.cwd}</Text>
            ) : null}
          </View>
          {workingCount > 0 ? (
            <View style={styles.badgeWorking}>
              <View style={[styles.dot, { backgroundColor: '#22c55e', width: 5, height: 5 }]} />
              <Text style={{ color: '#22c55e', fontSize: 11, fontWeight: '600' }}>{workingCount}</Text>
            </View>
          ) : waitingCount > 0 ? (
            <View style={styles.badgeWaiting}>
              <Text style={{ color: '#ea580c', fontSize: 11, fontWeight: '600' }}>✋ {waitingCount}</Text>
            </View>
          ) : justFinishedCount > 0 ? (
            <View style={styles.badgeFinished}>
              <Text style={{ color: '#0d9488', fontSize: 11, fontWeight: '600' }}>✓ {justFinishedCount}</Text>
            </View>
          ) : null}
          <Text style={{ color: colors.muted, fontSize: 12, marginLeft: 4, marginRight: 4 }}>{project.threads.length}</Text>
        </Pressable>
        {onCopyPath ? (
          <Pressable onPress={onCopyPath} hitSlop={10} style={styles.projectNewBtn}>
            <Text style={{ color: colors.muted, fontSize: 12 }}>路径</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => onCreateThread(project.cwd || '')}
          hitSlop={10}
          style={styles.projectNewBtn}
        >
          <Text style={{ color: colors.muted, fontSize: 16, fontWeight: '400' }}>+</Text>
        </Pressable>
      </View>
      {open
        ? project.threads.map((t) => (
            <ThreadLine key={t.id} thread={t} selected={t.id === selectedId} indent showTime={showTime} onPress={() => onOpenThread(t.id)} onPin={() => session.togglePin(t.id)} />
          ))
        : null}
    </View>
  );
}

function ThreadLine({
  thread,
  selected,
  showTime,
  indent,
  onPress,
  onPin,
}: {
  thread: Thread;
  selected?: boolean;
  showTime?: boolean;
  indent?: boolean;
  onPress: () => void;
  onPin?: () => void;
}) {
  const { colors } = useTheme();
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title || '');
  const isWorking = thread.isActive || thread.status === 'working' || thread.working;
  const isWaiting = thread.needsApproval || thread.status === 'waiting_approval';
  const isJustFinished = !isWorking && !isWaiting && (Date.now() - (thread.mtimeMs || 0) < 60000);

  function commitRename() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== thread.title) session.renameThread(thread.id, next);
  }

  if (editing) {
    return (
      <View style={[styles.row, indent && styles.indent, { backgroundColor: colors.card }]}>
        <TextInput
          autoFocus
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={commitRename}
          onBlur={commitRename}
          style={[styles.title, { color: colors.text, flex: 1, padding: 0 }]}
        />
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onPin}
      delayLongPress={420}
      {...(Platform.OS === 'web' ? { onDoubleClick: () => { setDraft(thread.title || ''); setEditing(true); } } as any : {})}
      style={[styles.row, indent && styles.indent, selected && { backgroundColor: colors.card }]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 }}>
        {thread.isPinned ? <Text style={{ fontSize: 11 }}>📌</Text> : null}
        {isWorking ? (
          <View style={[styles.dot, { backgroundColor: '#22c55e', width: 7, height: 7 }]} />
        ) : isWaiting ? (
          <View style={[styles.dot, { backgroundColor: '#ea580c', width: 7, height: 7 }]} />
        ) : null}
        <Text style={[styles.title, { color: colors.text, fontWeight: selected ? '500' : '400' }]} numberOfLines={1}>
          {thread.title || '新聊天'}
        </Text>
      </View>

      {isWorking ? (
        <View style={styles.badgeWorking}>
          <Text style={{ color: '#22c55e', fontSize: 11, fontWeight: '700' }}>运行中</Text>
        </View>
      ) : isWaiting ? (
        <View style={styles.badgeWaiting}>
          <Text style={{ color: '#ea580c', fontSize: 11, fontWeight: '700' }}>需批准</Text>
        </View>
      ) : isJustFinished ? (
        <View style={styles.badgeFinished}>
          <Text style={{ color: '#0d9488', fontSize: 11, fontWeight: '700' }}>✓ 刚刚</Text>
        </View>
      ) : showTime ? (
        <Text style={{ color: colors.muted, fontSize: 12 }}>{relTime(thread.mtimeMs, thread.updatedAt)}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topSection: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 2,
    gap: 1,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  brandTitle: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  brandRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusMiniDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  actionRowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  actionIconSlot: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  actionRowIcon: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  actionRowText: {
    fontSize: 14,
    fontWeight: '500',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 32,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    marginTop: 4,
    marginBottom: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 13.5,
    padding: 0,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 8,
  },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  host: { fontSize: 14, fontWeight: '600' },
  iconBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { paddingBottom: 80 },
  section: { fontSize: 12.5, fontWeight: '500', paddingHorizontal: space.md, paddingTop: 14, paddingBottom: 4 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingTop: 14,
    paddingBottom: 4,
  },
  sortRow: { flexDirection: 'row', gap: 6 },
  sortChip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  projectGroup: { marginBottom: 1 },
  folder: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: 7,
    gap: 8,
    borderRadius: 8,
  },
  indent: { paddingLeft: 34 },
  title: { flex: 1, fontSize: 14.5 },
  badgeWorking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeWaiting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(234, 88, 12, 0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeFinished: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(13, 148, 136, 0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  bottom: { padding: space.md },
  search: { borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 },
  connectBtn: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  newBtn: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectNewBtn: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    minWidth: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectNewBtnCompact: {
    paddingHorizontal: 4,
    paddingVertical: 0,
    minWidth: 16,
  },
  projectMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.28)',
    justifyContent: 'center',
    padding: 20,
    zIndex: 20,
  },
  projectCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  projectInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
});
