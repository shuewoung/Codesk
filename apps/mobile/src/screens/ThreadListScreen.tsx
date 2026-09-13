import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform,  RefreshControl, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { HandshakePanel } from '../components/HandshakePanel';
import { AccessiblePressable as Pressable, EmptyState, ErrorBanner, FeedbackBanner, FolderOutlineIcon, PlusCircleOutlineIcon } from '../components/ui';
import { useSession } from '../session';
import { loadListSort, saveListSort, loadOpenProjects, saveOpenProjects, type ListSort } from '../storage';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import type { Project, Thread } from '../types';
import { triggerHaptic } from '../utils/haptics';

import { catalogRows, type CatalogRow, recentThreadRows, relativeThreadTime, projectExpansionKey } from '../recent-threads';

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

const webNoOutline = null;

export function ThreadListScreen({
  onOpenThread,
  onSettings,
  onScan,
  selectedId,
  pendingCreate,
  onCreateThread,
}: {
  onOpenThread: (threadId: string) => void;
  onSettings: () => void;
  onScan: () => void;
  selectedId?: string;
  /** 正在创建中的新会话（乐观反馈：列表横幅 + 项目文件夹徽章） */
  pendingCreate?: { cwd: string; projectName: string } | null;
  /** 由 App 统一处理：立即切入新会话视图再等 thread_created 接管 */
  onCreateThread?: (cwd: string, projectName: string) => void;
}) {
  const session = useSession();
  const { colors, listDensity } = useTheme();
  const [query, setQuery] = useState('');
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [refreshError, setRefreshError] = useState('');
  const refreshing = session.requestState('get_threads')?.status === 'loading';
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectError, setNewProjectError] = useState('');
  const [newProjectFocused, setNewProjectFocused] = useState(false);
  const [listSort, setListSort] = useState<ListSort>('catalog');
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (listSort !== 'recent') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [listSort]);

  const timeline = useMemo(
    () => recentThreadRows(session.threads, session.projects, session.archivedIds, query),
    [session.threads, session.projects, session.archivedIds, query],
  );

  useEffect(() => {
    void loadListSort().then(setListSort);
    void loadOpenProjects().then((saved) => {
      if (saved && Object.keys(saved).length) setOpenProjects(saved);
    });
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

  function startCreateThread(cwd: string, projectName: string) {
    if (pendingCreate) return; // 创建中防连点
    if (onCreateThread) onCreateThread(cwd, projectName);
    else session.createThread(cwd);
  }

  function submitNewProject() {
    const cwd = newProjectPath.trim();
    if (!cwd) {
      setNewProjectError('请填写项目文件夹路径');
      return;
    }
    setNewProjectOpen(false);
    const name = cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || '';
    startCreateThread(cwd, name);
  }

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshError('');
    try {
      await session.refreshThreads();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : '刷新失败，请重试');
    }
  };

  useEffect(() => {
    if (!selectedId) return;
    const host = session.projects.find((p) => p.threads.some((t) => t.id === selectedId));
    if (host) setOpenProjects((prev) => ({ ...prev, [projectExpansionKey(host)]: true }));
  }, [selectedId, session.projects]);

  const q = query.trim().toLowerCase();
  const byRecent = listSort === 'recent';
  const recentCwds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of session.projects) {
      const cwd = String(p.cwd || '').trim();
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      out.push(cwd);
      if (out.length >= 5) break;
    }
    return out;
  }, [session.projects]);

  const catalog = useMemo(() => catalogRows({ threads: session.threads, projects: session.projects,
    archivedIds: session.archivedIds, archivedThreads: session.archivedThreads, pinnedIds: session.pinnedIds,
    query, openProjects }), [session.threads, session.projects, session.archivedIds, session.archivedThreads, session.pinnedIds, query, openProjects]);
  type ListRow = CatalogRow | { kind: 'recent'; key: string; thread: Thread; projectName: string };
  const rows: ListRow[] = byRecent ? timeline.map(row => ({ ...row, key: `timeline:${row.thread.id}`, kind: 'recent' })) : catalog;

  function toggle(project: Project) {
    setOpenProjects((prev) => {
      const key = projectExpansionKey(project);
      const next = { ...prev, [key]: !(prev[key] ?? prev[project.name]) };
      void saveOpenProjects(next);
      return next;
    });
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
            <Text style={{ fontSize: 11, color: colors.muted, flexShrink: 0 }}>
              {session.connText}{session.conn === 'connected' && session.hostName ? ` · ${session.hostName}` : ''}
            </Text>
            <Pressable accessibilityLabel="打开设置" onPress={onSettings} hitSlop={10} style={styles.iconBtn}>
              <Text style={{ color: colors.muted, fontSize: 16 }}>⋯</Text>
            </Pressable>
          </View>
        </View>

        {/* ＋ 新建对话按钮 */}
        <Pressable
          onPress={() => {
            if (!offline) {
              triggerHaptic('light');
              setNewChatOpen(true);
            }
          }}
          style={({ pressed }) => [styles.actionRowBtn, pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] }, offline && { opacity: 0.4 }]}
        >
          <View style={styles.actionIconSlot}>
            <PlusCircleOutlineIcon size={15} color={colors.text} />
          </View>
          <Text style={[styles.actionRowText, { color: colors.text }]}>新建对话</Text>
        </Pressable>

        {/* ＋ 新建项目按钮 */}
        <Pressable
          onPress={() => {
            triggerHaptic('light');
            openNewProject();
          }}
          style={({ pressed }) => [styles.actionRowBtn, pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] }]}
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
          {query ? (
            <Pressable
              onPress={() => {
                triggerHaptic('light');
                setQuery('');
              }}
              hitSlop={8}
              style={{ padding: 4, marginRight: 4 }}
            >
              <Text style={{ color: colors.muted, fontSize: 13, fontWeight: '700' }}>✕</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="刷新会话" disabled={refreshing} accessibilityState={{ busy: refreshing, disabled: refreshing }}
            onPress={() => {
              triggerHaptic('light');
              void handleRefresh();
            }}
            hitSlop={8}
            style={{ padding: 4 }}
          >
            <Text style={{ color: colors.muted, fontSize: 13 }}>↻</Text>
          </Pressable>
        </View>
      </View>
      {pendingCreate ? (
        <View style={[styles.creatingBanner, { backgroundColor: colors.card, borderColor: colors.line }]}>
          <ActivityIndicator size="small" color={colors.text} />
          <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '500', flex: 1 }} numberOfLines={1}>
            正在{pendingCreate.projectName ? `「${pendingCreate.projectName}」` : ''}创建新会话，建好自动进入…
          </Text>
        </View>
      ) : null}
      <ErrorBanner text={refreshError} onClose={() => setRefreshError('')} />
      <ErrorBanner text={session.error} onClose={session.clearError} />
      <FeedbackBanner text={session.feedback} onClose={session.clearFeedback} />
      {session.handshake.active ? (
        <HandshakePanel
          handshake={session.handshake}
          onRetry={session.conn === 'idle' && session.mode === 'relay' ? onScan : session.reconnect}
          retryLabel={session.handshake.phase === 'offline' ? '再试一次' : (session.conn === 'idle' && session.mode === 'relay' ? (Platform.OS === 'web' ? '重新配对' : '扫出门码') : '重新连接')}
        />
      ) : null}
      {session.paired && session.conn !== 'connected' && !session.handshake.active && (session.handshake.needsRetry || session.conn === 'hub_offline' || session.conn === 'idle' || session.conn === 'reconnecting') ? (
        <Pressable
          onPress={session.conn === 'idle' && session.mode === 'relay' ? onScan : session.reconnect}
          style={[styles.connectBtn, { backgroundColor: colors.text }]}
        >
          <Text style={{ color: colors.bg, fontWeight: '700', fontSize: 16 }}>
            {session.conn === 'idle' && session.mode === 'relay'
              ? (Platform.OS === 'web' ? '重新配对' : '扫描出门码')
              : '重新连接'}
          </Text>
        </Pressable>
      ) : null}
      {!byRecent && empty && !session.threads.length ? (
        <View style={{ paddingHorizontal: space.md, gap: 12 }}>
          <EmptyState title={empty.title} detail={empty.detail} />
          {offline ? null : (
            <Pressable
              onPress={() => setNewChatOpen(true)}
              style={[styles.connectBtn, { backgroundColor: colors.text }]}
            >
              <Text style={{ color: colors.bg, fontWeight: '700', fontSize: 16 }}>＋ 新建对话</Text>
            </Pressable>
          )}
          <Pressable
            onPress={openNewProject}
            style={[styles.connectBtn, { backgroundColor: colors.shell }]}
          >
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>＋ 新建项目</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              const run = () => { void session.logout().catch(err => setRefreshError(err instanceof Error ? err.message : '退出失败')); };
              if (Platform.OS === 'web') {
                if (typeof window !== 'undefined' && window.confirm('重新配对会吊销此设备，需要重新输入家里码或出门码。继续？')) run();
                return;
              }
              Alert.alert('重新配对？', '会吊销此设备，需要重新输入家里码或出门码。', [
                { text: '取消', style: 'cancel' },
                { text: '重新配对', style: 'destructive', onPress: run },
              ]);
            }}
            style={[styles.connectBtn, { backgroundColor: colors.shell }]}
          >
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>重新配对</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList<ListRow>
          data={rows}
          keyExtractor={item => item.key}
          contentContainerStyle={styles.list}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          initialNumToRender={24}
          windowSize={7}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void handleRefresh(); }} tintColor={colors.text} colors={[colors.text]} />}
          ListHeaderComponent={<View style={styles.sectionRow}>
            <Text style={{ color: colors.muted }}>{byRecent ? '最近运行' : '会话目录'}</Text>
            <View style={styles.sortRow}>{(['catalog', 'recent'] as const).map(value =>
              <Pressable key={value} accessibilityState={{ selected: listSort === value }} onPress={() => changeListSort(value)}
                style={[styles.sortChip, { borderColor: colors.line, backgroundColor: listSort === value ? colors.card : 'transparent' }]}>
                <Text style={{ color: colors.text }}>{value === 'catalog' ? '默认' : '最近运行'}</Text>
              </Pressable>)}</View>
          </View>}
          ListEmptyComponent={<EmptyState title={q ? '没有匹配的会话' : '暂无最近会话'} detail="试试其他会话名称或项目名称。" />}
          renderItem={({ item }) => {
            if (item.kind === 'section') return <Text style={[styles.section, { color: colors.muted }]}>{item.title}</Text>;
            if (item.kind === 'project') return <ProjectBlock project={item.project} open={item.open} headerOnly
              onToggle={() => toggle(item.project)} onPin={() => session.togglePin(item.project.id || item.project.name, 'project')}
              onCopyPath={() => { if (item.project.cwd) void Clipboard.setStringAsync(item.project.cwd); }}
              onOpenThread={onOpenThread} creating={!!pendingCreate && pendingCreate.cwd === item.project.cwd}
              onCreateThread={cwd => startCreateThread(cwd || '', item.project.name)} />;
            if (item.kind === 'thread' && item.archived) return <Pressable accessibilityLabel={`恢复会话 ${item.thread.title}`} onPress={() => session.unarchiveThread(item.thread.id)} style={styles.row}>
              <Text style={[styles.title, { color: colors.muted }]} numberOfLines={1}>{item.thread.title || '已归档会话'}</Text><Text style={{ color: colors.muted }}>恢复</Text>
            </Pressable>;
            return <ThreadLine thread={item.thread} selected={item.thread.id === selectedId}
              indent={item.kind === 'thread' && item.indent} showTime compact={listDensity === 'compact'}
              recentProjectName={item.kind === 'recent' ? item.projectName : undefined} now={now}
              onPress={() => onOpenThread(item.thread.id)} onPin={() => session.togglePin(item.thread.id)} />;
          }}
        />
      )}
      {newChatOpen ? (
        <View style={styles.projectMask}>
          <View style={[styles.projectCard, { backgroundColor: colors.bg, borderColor: colors.line }]}>
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700' }}>新建对话</Text>
            <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>先选项目目录，避免落到错误文件夹。</Text>
            {session.projects.filter((p) => p.cwd).slice(0, 8).map((p) => (
              <Pressable
                key={p.id || p.cwd || p.name}
                onPress={() => {
                  setNewChatOpen(false);
                  startCreateThread(p.cwd || '', p.name);
                }}
                style={{ paddingVertical: 8 }}
              >
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{p.name}</Text>
                <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>{p.cwd}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => {
                setNewChatOpen(false);
                startCreateThread('', '');
              }}
              style={{ paddingVertical: 8 }}
            >
              <Text style={{ color: colors.text, fontSize: 14 }}>无项目</Text>
            </Pressable>
            <Pressable onPress={() => setNewChatOpen(false)} hitSlop={8} style={{ alignSelf: 'flex-end' }}>
              <Text style={{ color: colors.muted, fontSize: 15 }}>取消</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
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
            {recentCwds.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {recentCwds.map((cwd) => (
                  <Pressable
                    key={cwd}
                    onPress={() => setNewProjectPath(cwd)}
                    style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}
                  >
                    <Text style={{ color: colors.text, fontSize: 12 }} numberOfLines={1}>{cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
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
  headerOnly,
  selectedId,
  showTime,
  onToggle,
  onPin,
  onCopyPath,
  onOpenThread,
  creating,
  onCreateThread,
}: {
  project: Project;
  open: boolean;
  headerOnly?: boolean;
  selectedId?: string;
  showTime?: boolean;
  onToggle: () => void;
  onPin?: () => void;
  onCopyPath?: () => void;
  onOpenThread: (id: string) => void;
  /** 正在新建会话的目标项目：文件夹行显示"新建中"徽章 */
  creating?: boolean;
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
        <Pressable accessibilityLabel={project.name} accessibilityState={{ expanded: open }} onPress={onToggle} onLongPress={onPin} delayLongPress={420} style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
          {/* ZCode 式分组标题：chevron + 小号加粗标题，让"项目"读作目录而非会话 */}
          <Text style={[styles.chevron, { color: colors.muted }]}>{open ? '▾' : '▸'}</Text>
          <View style={{ flex: 1, marginLeft: 7, minWidth: 0 }}>
            <Text style={[styles.projectName, { color: colors.muted }]} numberOfLines={1}
              {...(Platform.OS === 'web' ? { title: project.name } : {})}>
              {project.isPinned ? '📌 ' : ''}{project.name}
            </Text>
            {project.cwd ? (
              <Text style={[styles.projectPath, { color: colors.muted }]} numberOfLines={1}
                {...(Platform.OS === 'web' ? { title: project.cwd } : {})}>{project.cwd}</Text>
            ) : null}
          </View>
          {creating ? (
            <View style={styles.badgeCreating}>
              <View style={[styles.dot, { backgroundColor: '#3b82f6', width: 5, height: 5 }]} />
              <Text style={{ color: '#3b82f6', fontSize: 11, fontWeight: '600' }}>新建中</Text>
            </View>
          ) : workingCount > 0 ? (
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
      {open && !headerOnly
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
  compact = true,
  recentProjectName,
  now,
  onPress,
  onPin,
}: {
  thread: Thread;
  selected?: boolean;
  showTime?: boolean;
  indent?: boolean;
  compact?: boolean;
  recentProjectName?: string;
  now?: number;
  onPress: () => void;
  onPin?: () => void;
}) {
  const { colors, listDensity } = useTheme();
  const session = useSession();
  const dense = compact && listDensity === 'compact';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title || '');
  const isWorking = thread.isActive || thread.status === 'working' || thread.working;
  const isWaiting = thread.needsApproval || thread.status === 'waiting_approval';
  const recentMode = recentProjectName !== undefined;
  const isJustFinished = !isWorking && !isWaiting && ((now ?? Date.now()) - (thread.mtimeMs || 0) < 60000);

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

  const handlePress = () => {
    triggerHaptic('light');
    onPress();
  };

  const handleLongPress = () => {
    triggerHaptic('medium');
    const pinned = thread.isPinned || session.pinnedIds.includes(thread.id);
    const buttons = [
      { text: pinned ? '取消置顶' : '置顶', onPress: () => onPin?.() },
      { text: '重命名', onPress: () => { setDraft(thread.title || ''); setEditing(true); } },
      { text: '复制会话 ID', onPress: () => { void Clipboard.setStringAsync(thread.id); } },
      { text: '归档', style: 'destructive' as const, onPress: () => session.archiveThread(thread.id) },
      { text: '取消', style: 'cancel' as const },
    ];
    if (Platform.OS === 'web') {
      Alert.alert(thread.title || '会话', '选择操作', buttons);
      return;
    }
    Alert.alert(thread.title || '会话', undefined, buttons);
  };

  const statusBadge = isWorking ? (
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
  ) : showTime && !recentMode ? (
    <Text style={{ color: colors.muted, fontSize: 12 }}>{relTime(thread.mtimeMs, thread.updatedAt)}</Text>
  ) : null;

  return (
    <Pressable
      accessibilityLabel={thread.title || '新聊天'}
      accessibilityState={{ selected: !!selected }}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={420}
      {...(Platform.OS === 'web' ? { onDoubleClick: () => { setDraft(thread.title || ''); setEditing(true); } } as any : {})}
      style={({ pressed }) => [
        styles.row,
        indent && styles.indent,
        !dense && { paddingVertical: 11 },
        selected && { backgroundColor: colors.card },
        pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
      ]}
    >
      <View style={[{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 }, recentMode && { minWidth: 0 }]}>
        {thread.isPinned ? <Text style={{ fontSize: 11 }}>📌</Text> : null}
        {isWorking ? (
          <View style={[styles.dot, { backgroundColor: '#22c55e', width: 7, height: 7 }]} />
        ) : isWaiting ? (
          <View style={[styles.dot, { backgroundColor: '#ea580c', width: 7, height: 7 }]} />
        ) : null}
        {recentMode ? (
          <View style={styles.recentNames}>
            <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: selected ? '500' : '400', minWidth: 0 }}
              numberOfLines={1} ellipsizeMode="tail" {...(Platform.OS === 'web' ? { title: thread.title || '新聊天' } : {})}>
              {thread.title || '新聊天'}
            </Text>
            <Text style={{ color: colors.muted, fontSize: 12, minWidth: 0 }} numberOfLines={1} ellipsizeMode="tail"
              {...(Platform.OS === 'web' ? { title: recentProjectName } : {})}>{recentProjectName}</Text>
          </View>
        ) : <Text style={[styles.title, { color: colors.text, fontWeight: selected ? '500' : '400' }]} numberOfLines={1}>
          {thread.title || '新聊天'}
        </Text>}
      </View>

      {thread.summary && (thread.summary.fileChanges > 0 || thread.summary.generatedImages > 0) ? <Text style={{ color: colors.muted, fontSize: 11 }}>{thread.summary.partial ? '已索引 ' : ''}{thread.summary.fileChanges} 文件 · {thread.summary.generatedImages} 图片</Text> : null}
      {recentMode ? <View style={styles.recentMeta}>
        <Text style={{ color: colors.muted, fontSize: 12, flexShrink: 0 }}>
          {relativeThreadTime(thread, now ?? Date.now())}
        </Text>
        {statusBadge}
      </View> : statusBadge}
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
  section: { fontSize: 11, fontWeight: '500', letterSpacing: 0.3, paddingHorizontal: space.md, paddingTop: 14, paddingBottom: 4 },
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
    marginTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 8,
  },
  chevron: {
    width: 14,
    fontSize: 13,
    lineHeight: 15,
    textAlign: 'center',
  },
  projectName: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  projectPath: {
    fontSize: 10.5,
    opacity: 0.85,
    marginTop: 1,
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
  recentNames: { flex: 1, minWidth: 0, gap: 3 },
  recentMeta: { flexShrink: 0, alignItems: 'flex-end', gap: 4 },
  indent: { paddingLeft: 50 },
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
  badgeCreating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  creatingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    marginHorizontal: space.md,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 7,
    paddingHorizontal: 10,
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
