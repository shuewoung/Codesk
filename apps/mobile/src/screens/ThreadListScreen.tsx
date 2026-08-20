import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { EmptyState, ErrorBanner } from '../components/ui';
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
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

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
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <Pressable onPress={() => session.refreshThreads()} hitSlop={10}>
            <Text style={{ color: colors.text, fontSize: 16 }}>刷新</Text>
          </Pressable>
          <Pressable onPress={onSettings} hitSlop={10}>
            <Text style={{ color: colors.text, fontSize: 18 }}>⋯</Text>
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
    </View>
  );
}

function ProjectBlock({
  project,
  open,
  selectedId,
  onToggle,
  onOpenThread,
}: {
  project: Project;
  open: boolean;
  selectedId?: string;
  onToggle: () => void;
  onOpenThread: (id: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.projectCard, { backgroundColor: colors.shell }]}>
      <Pressable onPress={onToggle} style={styles.folder}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>
          {open ? '▾' : '▸'}  项目  {project.name}
        </Text>
        <Text style={{ color: colors.muted, fontSize: 12 }}>{project.threads.length} 个会话</Text>
      </Pressable>
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
  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, indent && styles.indent, selected && { backgroundColor: colors.shell }]}
    >
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
        {thread.needsApproval ? '等待批准 · ' : ''}{thread.title || '新聊天'}
      </Text>
      {showTime ? <Text style={{ color: colors.muted, fontSize: 12 }}>{relTime(thread.mtimeMs, thread.updatedAt)}</Text> : null}
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
  },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  host: { fontSize: 14, fontWeight: '600' },
  list: { paddingBottom: 80 },
  section: { fontSize: 13, paddingHorizontal: space.md, paddingTop: 16, paddingBottom: 6 },
  projectCard: { marginHorizontal: 12, marginBottom: 8, borderRadius: 12, overflow: 'hidden' },
  folder: {
    paddingHorizontal: space.md,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: 12,
    gap: 8,
  },
  indent: { paddingLeft: 36 },
  title: { flex: 1, fontSize: 16 },
  bottom: { padding: space.md },
  search: { borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 },
  connectBtn: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
});
