import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { EmptyState, ErrorBanner, FolderOutlineIcon } from '../components/ui';
import { useSession } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import type { Project, Thread } from '../types';

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
  const { colors, listDensity } = useTheme();
  const compact = listDensity === 'compact';
  const [query, setQuery] = useState('');
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectError, setNewProjectError] = useState('');

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
  const visible = session.threads.filter((t) => !session.archivedIds.includes(t.id));
  const waiting = visible.filter((t) => t.needsApproval);
  const pinnedThreads = visible.filter((t) => t.isPinned || session.pinnedIds.includes(t.id));
  const pinnedProjects = session.projects.filter((p) => p.isPinned);
  const recent = useMemo(
    () => visible.slice().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0)).slice(0, 20),
    [visible],
  );

  const projects = useMemo(() => {
    const src = session.projects.map((p) => ({
      ...p,
      threads: p.threads.filter((t) => !session.archivedIds.includes(t.id)),
    }));
    if (!q) return src;
    return src
      .map((p) => ({
        ...p,
        threads: p.threads.filter((t) => (t.title || '').toLowerCase().includes(q)),
      }))
      .filter((p) => p.threads.length || p.name.toLowerCase().includes(q));
  }, [q, session.projects, session.archivedIds]);

  function toggle(name: string) {
    setOpenProjects((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  const empty = session.conn === 'hub_offline'
    ? { title: '主机离线', detail: '电脑休眠或 Hub 未运行。' }
    : session.conn !== 'connected'
      ? { title: '未连接', detail: session.connText }
      : !session.threads.length
        ? { title: '还没有聊天', detail: '点右上角「刷新」拉列表。若一直空，重新配对一次。' }
        : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.top}>
        <View style={styles.hostRow}>
          <View style={[styles.dot, { backgroundColor: session.conn === 'connected' ? colors.ok : colors.warn }]} />
          <Text style={[styles.host, { color: colors.text }]} numberOfLines={1}>
            {session.connText}
          </Text>
        </View>
        <View style={styles.topActions}>
          <Pressable
            onPress={() => session.createThread()}
            style={[styles.newBtn, { backgroundColor: colors.text }]}
            hitSlop={8}
          >
            <Text style={{ color: colors.bg, fontSize: 12.5, fontWeight: '700' }}>＋ 对话</Text>
          </Pressable>
          <Pressable
            onPress={openNewProject}
            style={[styles.newBtn, { backgroundColor: colors.shell }]}
            hitSlop={8}
          >
            <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '600' }}>＋ 项目</Text>
          </Pressable>
          <Pressable onPress={onSettings} hitSlop={10} style={styles.iconBtn}>
            <Text style={{ color: colors.muted, fontSize: 16 }}>⋯</Text>
          </Pressable>
        </View>
      </View>
      <ErrorBanner text={session.error} onClose={session.clearError} />
      {session.conn !== 'connected' ? (
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
            <ThreadLine key={`wait-${t.id}`} thread={t} selected={t.id === selectedId} onPress={() => onOpenThread(t.id)} />
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
              onToggle={() => toggle(p.name)}
              onOpenThread={onOpenThread}
              onCreateThread={(cwd) => session.createThread(cwd)}
            />
          ))}
          {pinnedThreads.map((t) => (
            <ThreadLine key={`pin-${t.id}`} thread={t} selected={t.id === selectedId} onPress={() => onOpenThread(t.id)} />
          ))}

          <Text style={[styles.section, { color: colors.muted }]}>项目</Text>
          {projects.map((p) => (
            <ProjectBlock
              key={p.name}
              project={p}
              open={!!q || !!openProjects[p.name]}
              selectedId={selectedId}
              onToggle={() => toggle(p.name)}
              onOpenThread={onOpenThread}
              onCreateThread={(cwd) => session.createThread(cwd)}
            />
          ))}

          <Text style={[styles.section, { color: colors.muted }]}>最近</Text>
          {(q ? recent.filter((t) => (t.title || '').toLowerCase().includes(q)) : recent).map((t) => (
            <ThreadLine key={t.id} thread={t} selected={t.id === selectedId} showTime onPress={() => onOpenThread(t.id)} />
          ))}
        </ScrollView>
      )}
      <View style={[styles.bottom, { backgroundColor: colors.bg }]}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索聊天"
          placeholderTextColor={colors.muted}
          style={[styles.search, { backgroundColor: colors.shell, color: colors.text }]}
        />
      </View>
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
              placeholder="D:\projects\my-app"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.projectInput, { backgroundColor: colors.shell, color: colors.text, borderColor: colors.line }]}
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
  onToggle,
  onOpenThread,
  onCreateThread,
}: {
  project: Project;
  open: boolean;
  selectedId?: string;
  onToggle: () => void;
  onOpenThread: (id: string) => void;
  onCreateThread: (cwd?: string) => void;
}) {
  const { colors } = useTheme();

  const workingCount = project.threads.filter((t) => t.isActive || t.status === 'working' || t.working).length;
  const waitingCount = project.threads.filter((t) => t.needsApproval || t.status === 'waiting_approval').length;
  const justFinishedCount = project.threads.filter(
    (t) => !t.isActive && t.status !== 'working' && !t.working && !t.needsApproval && t.status !== 'waiting_approval' && (Date.now() - (t.mtimeMs || 0) < 60000)
  ).length;

  return (
    <View style={styles.projectGroup}>
      <View style={styles.folder}>
        <Pressable onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
          <FolderOutlineIcon open={open} color={colors.muted} size={15} />
          <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '600', flex: 1, marginLeft: 6 }} numberOfLines={1}>
            {project.name}
          </Text>
          {workingCount > 0 ? (
            <View style={styles.badgeWorking}>
              <View style={[styles.dot, { backgroundColor: '#22c55e', width: 5, height: 5 }]} />
              <Text style={{ color: '#22c55e', fontSize: 11, fontWeight: '700' }}>{workingCount}</Text>
            </View>
          ) : waitingCount > 0 ? (
            <View style={styles.badgeWaiting}>
              <Text style={{ color: '#ea580c', fontSize: 11, fontWeight: '700' }}>✋ {waitingCount}</Text>
            </View>
          ) : justFinishedCount > 0 ? (
            <View style={styles.badgeFinished}>
              <Text style={{ color: '#0d9488', fontSize: 11, fontWeight: '700' }}>✓ {justFinishedCount}</Text>
            </View>
          ) : null}
          <Text style={{ color: colors.muted, fontSize: 12, marginLeft: 4, marginRight: 4 }}>{project.threads.length}</Text>
        </Pressable>
        <Pressable
          onPress={() => onCreateThread(project.cwd || '')}
          hitSlop={10}
          style={styles.projectNewBtn}
        >
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>+</Text>
        </Pressable>
      </View>
      {open
        ? project.threads.map((t) => (
            <ThreadLine key={t.id} thread={t} selected={t.id === selectedId} indent onPress={() => onOpenThread(t.id)} />
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
}: {
  thread: Thread;
  selected?: boolean;
  showTime?: boolean;
  indent?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const isWorking = thread.isActive || thread.status === 'working' || thread.working;
  const isWaiting = thread.needsApproval || thread.status === 'waiting_approval';
  const isJustFinished = !isWorking && !isWaiting && (Date.now() - (thread.mtimeMs || 0) < 60000);

  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, indent && styles.indent, selected && { backgroundColor: colors.card }]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 }}>
        {isWorking ? (
          <View style={[styles.dot, { backgroundColor: '#22c55e', width: 7, height: 7 }]} />
        ) : isWaiting ? (
          <View style={[styles.dot, { backgroundColor: '#ea580c', width: 7, height: 7 }]} />
        ) : null}
        <Text style={[styles.title, { color: colors.text, fontWeight: selected ? '600' : '400' }]} numberOfLines={1}>
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
  section: { fontSize: 12.5, fontWeight: '600', paddingHorizontal: space.md, paddingTop: 14, paddingBottom: 4 },
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
