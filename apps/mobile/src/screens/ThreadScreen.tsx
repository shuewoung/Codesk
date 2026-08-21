import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { ApprovalBar } from '../components/ApprovalBar';
import { EmptyState, ErrorBanner, FolderOutlineIcon } from '../components/ui';
import { approvalFromHistory, commandGroupCounts, flattenItems, groupCommandNodes, type FeedNode } from '../history';
import { useSession } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import { ACCESS_MODES, accessMeta, type TimelineNode } from '../types';

const EFFORT_LABELS: Record<string, string> = {
  none: '无',
  minimal: '最低',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高',
};

const webNoOutline = Platform.OS === 'web'
  ? ({ outlineWidth: 0, outlineStyle: 'none' as any, borderWidth: 0 } as any)
  : null;

export function ThreadScreen({
  threadId,
  onOpenLeft,
  onOpenRight,
  onOpenFile,
  onScan,
  hideSideButtons = false,
}: {
  threadId?: string;
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onOpenFile: (path: string) => void;
  onScan: () => void;
  hideSideButtons?: boolean;
}) {
  const session = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');
  const [kb, setKb] = useState(0);
  const [plus, setPlus] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'status' | 'more' | 'rename' | 'model' | 'effort' | 'access' | 'search' | 'goal'>('none');
  const [goalDraft, setGoalDraft] = useState('');

  const SLASH_ITEMS = [
    { cmd: '/mcp', desc: 'MCP 服务器', kind: 'mcp' },
    { cmd: '/compact', desc: '压缩上下文', kind: 'send' },
    { cmd: '/plan', desc: '计划模式', kind: 'send' },
    { cmd: '/goal', desc: '设置要持续追求的目标', kind: 'goal' },
  ];

  const slashQuery = draft.trim().startsWith('/') ? draft.trim().slice(1).toLowerCase() : '';
  const showSlash = draft.trim().startsWith('/');
  const filteredSlash = SLASH_ITEMS.filter(item =>
    item.cmd.toLowerCase().includes(slashQuery) || item.desc.toLowerCase().includes(slashQuery)
  );
  const [searchQ, setSearchQ] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [pending, setPending] = useState<{ name: string; path: string; image: boolean }[]>([]);
  const [expandedCmdGroups, setExpandedCmdGroups] = useState<Set<string>>(new Set());
  const listRef = useRef<FlatList<FeedNode>>(null);
  const thread = session.threads.find((t) => t.id === threadId);
  const history = threadId ? session.histories[threadId] : undefined;
  const approval = threadId ? session.approvals[threadId] || approvalFromHistory(threadId, history) : null;

  const nodes = useMemo(
    () => flattenItems(history?.items || []).filter((n) => n.kind === 'user' || n.kind === 'assistant' || n.kind === 'diff' || n.kind === 'command' || n.kind === 'system'),
    [history?.items],
  );
  const feed = useMemo(() => groupCommandNodes(nodes), [nodes]);
  const working = history?.status === 'working';
  const project = session.projects.find((p) => p.threads.some((t) => t.id === threadId));

  useEffect(() => {
    if (threadId) session.openThread(threadId);
  }, [threadId]);

  useEffect(() => {
    if (sheet === 'goal' && session.goal && session.goal.threadId === threadId) setGoalDraft(session.goal.objective);
  }, [session.goal, sheet, threadId]);

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      setKb(0);
      return;
    }
    const show = Keyboard.addListener('keyboardWillShow', (e) => {
      setKb(Math.max(0, e.endCoordinates.height - insets.bottom));
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => {
      setKb(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom]);

  useEffect(() => {
    if (!nodes.length) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [nodes.length, history?.status]);

  useEffect(() => {
    const up = session.lastUpload;
    if (!up || up.error || !up.path) return;
    setPending((prev) => [...prev, { name: up.name, path: up.path, image: /\.(png|jpe?g|gif|webp)$/i.test(up.name) }]);
    session.clearUpload();
  }, [session.lastUpload]);

  async function pickPhoto(fromCamera: boolean) {
    if (!threadId) return;
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      session.clearError();
      return;
    }
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    const name = asset.fileName || `photo-${Date.now()}.jpg`;
    let b64 = asset.base64 || '';
    if (!b64 && asset.uri) b64 = await new File(asset.uri).base64();
    if (!b64) return;
    session.uploadFile(threadId, name, b64, asset.mimeType || 'image/jpeg');
    setPlus(false);
  }

  async function pickFile() {
    if (!threadId) return;
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    const b64 = await new File(asset.uri).base64();
    session.uploadFile(threadId, asset.name || 'file', b64, asset.mimeType || '');
    setPlus(false);
  }

  function send() {
    if (!threadId) {
      session.createThread(session.projects[0]?.cwd);
      return;
    }
    const text = draft.trim();
    if (!text && !pending.length) return;
    const input = [
      ...pending.map((p) => (p.image ? { type: 'localImage', path: p.path } : { type: 'mention', name: p.name, path: p.path })),
      ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
    ];
    if (text.startsWith('$ ')) {
      session.runCommand(threadId, text.slice(2));
      setDraft('');
      return;
    }
    if (/^\/(review|compact|init|status|plan)\b/.test(text)) {
      session.sendComposer(threadId, text, false);
      setDraft('');
      return;
    }
    session.sendComposer(threadId, text, working, input);
    setDraft('');
    setPending([]);
  }

  const ctxUsed = history?.tokenUsage?.usedPercent
    ?? session.quota.usedPercent
    ?? 0;
  const accountUsed = session.quota.primaryUsedPercent;
  const windowLeft = accountUsed == null ? null : Math.max(0, Math.min(100, 100 - accountUsed));
  const hostLabel = session.hostName || '';
  const modelId = session.config.rawModel || session.config.model || '';
  const modelLabel = session.models.find((m) => m.id === modelId)?.displayName || modelId || '模型';
  const effortLabel = EFFORT_LABELS[session.config.effort || ''] || session.config.effort || '推理';
  const access = accessMeta(session.config.accessMode);
  const resetText = session.quota.resetAtMs
    ? new Date(session.quota.resetAtMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '未知';

  const mdStyle = {
    body: { color: colors.text, fontSize: 16, lineHeight: 24 },
    heading1: { color: colors.text, fontSize: 22, fontWeight: '700' as const },
    heading2: { color: colors.text, fontSize: 19, fontWeight: '700' as const },
    paragraph: { color: colors.text, fontSize: 16, lineHeight: 24 },
    strong: { color: colors.text, fontWeight: '700' as const },
    em: { color: colors.text },
    link: { color: colors.text, fontWeight: '700' as const, textDecorationLine: 'underline' as const },
    code_inline: {
      color: colors.text,
      fontWeight: '700' as const,
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderColor: 'transparent',
      padding: 0,
      paddingHorizontal: 0,
      paddingVertical: 0,
      borderRadius: 0,
    },
    code_block: {
      backgroundColor: colors.shell,
      color: colors.text,
      borderRadius: 8,
      padding: 8,
      borderWidth: 0,
    },
    fence: {
      backgroundColor: colors.shell,
      color: colors.text,
      borderRadius: 8,
      padding: 8,
      borderWidth: 0,
    },
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingBottom: kb > 0 ? kb : insets.bottom + 8 }]}>
      <View style={styles.mainWrap}>
        <View style={styles.header}>
        {!hideSideButtons && (
          <Pressable onPress={onOpenLeft} style={[styles.round, { backgroundColor: colors.shell }]} hitSlop={6}>
            <Text style={{ color: colors.text, fontSize: 18 }}>☰</Text>
          </Pressable>
        )}
        <Pressable onPress={() => setSheet('status')} style={[styles.round, { backgroundColor: colors.shell }]} hitSlop={6}>
          <QuotaRing remaining={windowLeft} />
        </Pressable>
        <View style={[styles.titlePill, { backgroundColor: colors.shell }]}>
          <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>
            {thread?.title || '新聊天'}
          </Text>
          <View style={styles.metaRow}>
            <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>
              {project?.name || '未分组'}
            </Text>
            <View style={[styles.liveDot, { backgroundColor: session.conn === 'connected' ? '#22c55e' : '#ef4444' }]} />
            {hostLabel ? (
              <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>
                {hostLabel}
              </Text>
            ) : null}
          </View>
        </View>
        {!hideSideButtons && (
          <Pressable onPress={onOpenRight} style={[styles.round, { backgroundColor: colors.shell }]} hitSlop={6}>
            <FolderOutlineIcon size={16} />
          </Pressable>
        )}
        <Pressable onPress={() => setSheet((s) => (s === 'more' ? 'none' : 'more'))} style={[styles.round, { backgroundColor: colors.shell }]} hitSlop={6}>
          <Text style={{ color: colors.text, fontSize: 18 }}>⋯</Text>
        </Pressable>
      </View>

      <ErrorBanner text={session.error || session.feedback} onClose={() => { session.clearError(); session.clearFeedback(); }} />
      {!session.paired ? (
        <Pressable
          onPress={onScan}
          style={{ marginHorizontal: 16, marginBottom: 8, backgroundColor: colors.text, borderRadius: 12, paddingVertical: 12, alignItems: 'center' }}
        >
          <Text style={{ color: colors.bg, fontWeight: '700' }}>
            {Platform.OS === 'web' ? '未连接，点此重新配对' : '未连接，点此扫码'}
          </Text>
        </Pressable>
      ) : session.conn !== 'connected' ? (
        <Text style={{ marginHorizontal: 16, marginBottom: 8, color: colors.muted, fontSize: 13 }}>
          {session.connText}
        </Text>
      ) : null}

      <FlatList
        ref={listRef}
        data={feed}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.feed}
        ListEmptyComponent={<EmptyState title={threadId ? '开始处理' : '选择或新建会话'} />}
        ListHeaderComponent={
          threadId && history?.hasMore ? (
            <Pressable
              onPress={() => session.loadOlderHistory(threadId)}
              style={{ paddingVertical: 12, alignItems: 'center' }}
            >
              <Text style={{ color: colors.muted, fontSize: 13 }}>加载更早的消息</Text>
            </Pressable>
          ) : null
        }
        onScroll={(e) => {
          if (!threadId || !history?.hasMore) return;
          if (e.nativeEvent.contentOffset.y < 40) session.loadOlderHistory(threadId);
        }}
        scrollEventThrottle={200}
        renderItem={({ item }) => (
          item.kind === 'cmd-group' ? (
            <CommandGroupView
              groupId={item.id}
              commands={item.commands}
              expanded={expandedCmdGroups.has(item.id)}
              onToggle={() => {
                setExpandedCmdGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
              }}
            />
          ) : (
            <NodeView node={item} mdStyle={mdStyle} onOpenFile={onOpenFile} />
          )
        )}
      />

      {approval && threadId ? (
        <View style={styles.pad}>
          <ApprovalBar approval={approval} onDecide={(d) => session.sendApproval(threadId, d)} />
        </View>
      ) : null}

      {/* Floating Active Action / Working Capsule */}
      {working ? (
        <View style={styles.floatingCapsuleWrap}>
          <View style={[styles.capsuleInner, { backgroundColor: colors.shell, borderColor: colors.line }]}>
            <ActivityIndicator size="small" color={colors.text} style={{ transform: [{ scale: 0.75 }] }} />
            <Text style={[styles.capsuleText, { color: colors.text }]} numberOfLines={1}>
              {history?.activeActionText ? `正在执行: ${history.activeActionText}` : 'Codex 正在运行…'}
            </Text>
          </View>
        </View>
      ) : null}

      {sheet === 'status' ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Text style={[styles.cardK, { color: colors.muted }]}>状态</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>
              {session.connText}
            </Text>
            <Text style={[styles.cardK, { color: colors.muted }]}>对话线程</Text>
            <Text selectable style={[styles.cardV, { color: colors.text }]}>{threadId || '—'}</Text>
            <Text style={[styles.cardK, { color: colors.muted }]}>目录</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>{history?.cwd || project?.cwd || '—'}</Text>
            <Text style={[styles.cardK, { color: colors.muted }]}>上下文</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>
              {history?.tokenUsage?.totalTokens && history?.tokenUsage?.maxContext
                ? `已用 ${Math.round(history.tokenUsage.totalTokens / 1000)}K / ${Math.round(history.tokenUsage.maxContext / 1000)}K（占用 ${ctxUsed}%）`
                : ctxUsed ? `占用 ${ctxUsed}%` : '暂无'}
            </Text>
            <Text style={[styles.cardK, { color: colors.muted }]}>用量窗口</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>
              {windowLeft != null ? `剩余 ${Math.round(windowLeft)}% · 重置 ${resetText}` : '暂无'}
            </Text>
          </View>
        </Pressable>
      ) : null}

      {sheet === 'more' && threadId ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Pressable style={styles.menuItem} onPress={() => setSheet('search')}>
              <Text style={{ color: colors.text, fontSize: 16 }}>🔍 会话内搜索</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { session.togglePin(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.text, fontSize: 16 }}>{session.pinnedIds.includes(threadId) ? '📌 取消置顶' : '📌 置顶'}</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { void Clipboard.setStringAsync(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.text, fontSize: 16 }}>📋 复制会话 ID</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { setRenameDraft(thread?.title || ''); setSheet('rename'); }}>
              <Text style={{ color: colors.text, fontSize: 16 }}>✏️ 重命名</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { session.archiveThread(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.danger, fontSize: 16 }}>📦 归档</Text>
            </Pressable>
          </View>
        </Pressable>
      ) : null}

      {sheet === 'search' && threadId ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Text style={{ color: colors.text, fontWeight: '600', marginBottom: 8 }}>会话内搜索</Text>
            <TextInput
              value={searchQ}
              onChangeText={setSearchQ}
              placeholder="关键词"
              placeholderTextColor={colors.muted}
              style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, color: colors.text }}
              onSubmitEditing={() => session.searchThread(threadId, searchQ)}
            />
            <Pressable style={{ marginTop: 10, alignSelf: 'flex-end' }} onPress={() => session.searchThread(threadId, searchQ)}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>搜索</Text>
            </Pressable>
            {session.searchHits.map((hit, i) => (
              <Text key={`${hit.index}-${i}`} selectable style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>
                {hit.snippet}
              </Text>
            ))}
          </View>
        </Pressable>
      ) : null}

      {sheet === 'rename' && threadId ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Text style={{ color: colors.text, fontWeight: '600', marginBottom: 8 }}>重命名</Text>
            <TextInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, color: colors.text }}
            />
            <Pressable
              style={{ marginTop: 12, alignSelf: 'flex-end' }}
              onPress={() => { session.renameThread(threadId, renameDraft); setSheet('none'); }}
            >
              <Text style={{ color: colors.text, fontWeight: '700' }}>保存</Text>
            </Pressable>
          </View>
        </Pressable>
      ) : null}

      {sheet === 'goal' && threadId ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Text style={{ color: colors.text, fontWeight: '600', marginBottom: 8 }}>目标</Text>
            <TextInput
              value={goalDraft}
              onChangeText={setGoalDraft}
              placeholder="本会话要持续追求的目标"
              placeholderTextColor={colors.muted}
              multiline
              style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, color: colors.text, minHeight: 88 }}
            />
            <View style={{ marginTop: 12, flexDirection: 'row', justifyContent: 'flex-end', gap: 16 }}>
              <Pressable onPress={() => { session.setGoal(threadId, ''); setGoalDraft(''); setSheet('none'); }}>
                <Text style={{ color: colors.muted, fontWeight: '600' }}>清除</Text>
              </Pressable>
              <Pressable onPress={() => { session.setGoal(threadId, goalDraft); setSheet('none'); }}>
                <Text style={{ color: colors.text, fontWeight: '700' }}>保存</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      ) : null}

      {plus ? (
        <View style={[styles.plusMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          {Platform.OS === 'web' ? null : (
            <Pressable style={styles.plusItem} onPress={() => { void pickPhoto(true); }}>
              <Text style={{ color: colors.text, fontSize: 15 }}>📷 拍照附加</Text>
            </Pressable>
          )}
          <Pressable style={styles.plusItem} onPress={() => { void pickPhoto(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🖼️ 上传图片</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { void pickFile(); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>📄 上传文件</Text>
          </Pressable>
          {threadId ? (
            <Pressable style={styles.plusItem} onPress={() => { session.gitStatus(threadId); setPlus(false); }}>
              <Text style={{ color: colors.text, fontSize: 15 }}>🌿 查看 Git 状态</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.plusItem} onPress={() => { setDraft('/review '); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🔍 /review 代码审查</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { setDraft('/compact '); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🗜️ /compact 压缩上下文</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { setDraft('$ '); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>💻 跑终端命令（$ 开头）</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Access mode popover menu (anchored right above composer) */}
      {sheet === 'access' ? (
        <View style={[styles.popoverMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <View style={styles.popoverHeader}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>应如何批准 Codex 操作？</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={8}>
              <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
          {(Object.keys(ACCESS_MODES) as Array<keyof typeof ACCESS_MODES>).map((id) => {
            const meta = ACCESS_MODES[id];
            const on = (session.config.accessMode || 'full') === id;
            const desc = id === 'ask'
              ? '编辑外部文件和使用互联网时始终询问'
              : id === 'auto'
                ? '仅对检测到的风险操作请求批准'
                : '可不受限制地访问互联网和电脑上的任何文件';
            return (
              <Pressable
                key={id}
                unstable_pressDelay={0}
                style={[styles.plusItem, on && { backgroundColor: colors.shell }]}
                onPress={() => { session.updateConfig('permission', id); setSheet('none'); }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: on ? '700' : '500' }}>
                    {meta.icon} {meta.label}
                  </Text>
                  {on ? <Text style={{ color: '#10b981', fontWeight: '700', fontSize: 14 }}>✓</Text> : null}
                </View>
                <Text style={{ color: colors.muted, fontSize: 12, marginTop: 3 }}>{desc}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* Model & Reasoning popover menu (anchored right above composer) */}
      {sheet === 'model' ? (
        <View style={[styles.popoverMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <View style={styles.popoverHeader}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>选择模型与推理</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={8}>
              <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: Math.round(Dimensions.get('window').height * 0.35) }}>
            {session.models.map((m) => {
              const on = modelId === m.id;
              return (
                <Pressable
                  key={m.id}
                  unstable_pressDelay={0}
                  style={[styles.plusItem, on && { backgroundColor: colors.shell }]}
                  onPress={() => {
                    session.updateConfig('model', m.id);
                    const ids = (m.supportedReasoningEfforts || []).map((e) => e.id).filter(Boolean);
                    const cur = session.config.effort || '';
                    if (ids.length && !ids.includes(cur)) {
                      session.updateConfig('effort', m.defaultReasoningEffort || ids[0]);
                    }
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: on ? '700' : '500' }}>
                      {m.displayName || m.id}
                    </Text>
                    {on ? <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>✓</Text> : null}
                  </View>
                  {m.id !== (m.displayName || m.id) ? (
                    <Text style={{ color: colors.muted, fontSize: 11, marginTop: 1 }}>{m.id}</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, paddingBottom: 12 }}>
            <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 16, marginBottom: 8, fontWeight: '600' }}>
              推理强度 (Reasoning Effort)
            </Text>
            <View style={{ flexDirection: 'row', paddingHorizontal: 14, gap: 6, flexWrap: 'wrap' }}>
              {(session.models.find((m) => m.id === modelId)?.supportedReasoningEfforts || [])
                .map((e) => e.id)
                .filter(Boolean)
                .concat(
                  session.models.find((m) => m.id === modelId)?.supportedReasoningEfforts?.length
                    ? []
                    : ['none', 'low', 'medium', 'high', 'xhigh'],
                )
                .map((lvl) => {
                  const on = (session.config.effort || 'medium') === lvl;
                  const label = EFFORT_LABELS[lvl] || lvl;
                  return (
                    <Pressable
                      key={lvl}
                      unstable_pressDelay={0}
                      style={[
                        styles.miniChip,
                        {
                          backgroundColor: on ? colors.text : colors.shell,
                          borderColor: on ? colors.text : colors.line,
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                        },
                      ]}
                      onPress={() => { session.updateConfig('effort', lvl); }}
                    >
                      <Text style={{ color: on ? colors.bg : colors.text, fontSize: 12, fontWeight: on ? '700' : '500' }}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
            </View>
          </View>
        </View>
      ) : null}

      {session.git ? (
        <Text selectable style={{ color: colors.muted, paddingHorizontal: 16, paddingBottom: 6, fontSize: 12 }}>
          {(session.git.error || [session.git.status, session.git.diff, session.git.log].filter(Boolean).join('\n')).slice(0, 4000)}
        </Text>
      ) : null}
      {session.commandOut ? (
        <Text selectable style={{ color: colors.muted, paddingHorizontal: 16, paddingBottom: 6, fontSize: 12 }}>
          {session.commandOut.slice(-4000)}
        </Text>
      ) : null}

      {/* Slash command menu (live filter when typing /) - 与 Codex 保持一致 */}
      {showSlash && filteredSlash.length > 0 ? (
        <View style={[styles.slashMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          {filteredSlash.map((item, idx) => (
            <Pressable
              key={idx}
              style={styles.plusItem}
              onPress={() => {
                if (item.kind === 'goal') {
                  setGoalDraft(session.goal && session.goal.threadId === threadId ? session.goal.objective : '');
                  if (threadId) session.getGoal(threadId);
                  setSheet('goal');
                  setDraft('');
                } else if (item.kind === 'mcp') {
                  setDraft(item.cmd + ' ');
                } else {
                  setDraft(item.cmd + ' ');
                }
              }}
            >
              <Text style={{ color: colors.text, fontSize: 15 }}>
                {item.cmd} <Text style={{ color: colors.muted }}>{item.desc}</Text>
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.composerWrap}>
        <View style={[styles.inputCard, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          {pending.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingBar}>
              {pending.map((p, idx) => (
                <View key={`${p.path}-${idx}`} style={[styles.pendingChip, { backgroundColor: colors.card, borderColor: colors.line }]}>
                  <Text style={{ fontSize: 13 }}>{p.image ? '🖼️' : '📄'}</Text>
                  <Text style={[styles.pendingName, { color: colors.text }]} numberOfLines={1}>{p.name}</Text>
                  <Pressable
                    onPress={() => setPending((prev) => prev.filter((_, i) => i !== idx))}
                    hitSlop={8}
                    style={styles.pendingRemove}
                  >
                    <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '700' }}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={threadId ? '随心输入' : '先开一个会话'}
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.text }, webNoOutline]}
            multiline
            editable={session.conn === 'connected' && !approval}
            underlineColorAndroid="transparent"
          />
          <View style={styles.composerBar}>
            <View style={styles.composerLeft}>
              <Pressable style={styles.toolBtn} onPress={() => { setPlus((v) => !v); }} hitSlop={6}>
                <Text style={{ color: colors.text, fontSize: 20, fontWeight: '400' }}>+</Text>
              </Pressable>
              <Pressable
                style={styles.toolBtn}
                onPress={() => {
                  setPlus(false);
                  setDraft(draft.startsWith('/') ? draft : '/');
                }}
                hitSlop={6}
              >
                <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>/</Text>
              </Pressable>
              <Pressable
                style={styles.chipBtn}
                onPress={() => { setPlus(false); setDraft('/'); }}
                hitSlop={4}
              >
                <Text style={{ color: colors.text, fontSize: 13 }}>⚡ Skill</Text>
              </Pressable>
              <Pressable
                style={styles.chipBtn}
                onPress={() => { setPlus(false); setDraft('/mcp '); }}
                hitSlop={4}
              >
                <Text style={{ color: colors.text, fontSize: 13 }}>☀ MCP</Text>
              </Pressable>
              <Pressable
                style={styles.chipBtn}
                onPress={() => setSheet(sheet === 'access' ? 'none' : 'access')}
                hitSlop={4}
              >
                <Text style={{
                  color: session.config.accessMode === 'auto'
                    ? '#10b981'
                    : session.config.accessMode === 'ask'
                      ? '#3b82f6'
                      : '#ea580c',
                  fontSize: 13,
                  fontWeight: '600',
                }}>
                  {access.icon} {access.label}
                </Text>
              </Pressable>
            </View>
            <View style={styles.composerRight}>
              <Pressable
                style={[styles.modelPill, { backgroundColor: colors.shell, borderColor: colors.line }]}
                onPress={() => setSheet(sheet === 'model' ? 'none' : 'model')}
              >
                <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
                  {modelLabel} · <Text style={{ color: colors.muted }}>{effortLabel}</Text> ∨
                </Text>
              </Pressable>
              {working && threadId ? (
                <Pressable
                  style={({ pressed }) => [styles.send, { backgroundColor: colors.danger }, pressed && { opacity: 0.75 }, webNoOutline]}
                  onPress={() => session.sendStop(threadId)}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>停</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={({ pressed }) => [
                    styles.send,
                    { backgroundColor: colors.send, opacity: draft.trim() || pending.length ? 1 : 0.35 },
                    pressed && { opacity: 0.75 },
                    webNoOutline,
                  ]}
                  onPress={send}
                >
                  <Text style={{ color: colors.sendText, fontWeight: '700', fontSize: 15 }}>↑</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </View>
    </View>
  </View>
  );
}

function quotaColor(remaining: number | null): string {
  if (remaining == null) return '#8e8ea0';
  const t = 1 - Math.max(0, Math.min(1, (remaining - 8) / 32));
  const r = Math.round(13 + (239 - 13) * t);
  const g = Math.round(13 + (68 - 13) * t);
  const b = Math.round(13 + (68 - 13) * t);
  return `rgb(${r},${g},${b})`;
}

function QuotaRing({ remaining }: { remaining: number | null }) {
  const color = quotaColor(remaining);
  const label = remaining == null ? '—' : String(Math.round(remaining));
  return (
    <View style={[styles.ring, { borderColor: color }]}>
      <Text style={{ color, fontSize: 9, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

function DiffNodeView({ node, onOpenFile }: { node: TimelineNode; onOpenFile: (path: string) => void }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={[styles.diffCard, { backgroundColor: colors.shell, borderColor: colors.line }]}>
      <View style={styles.diffHeader}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.diffPath, { color: colors.text }]} numberOfLines={1}>📝 已修改 {node.text}</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>
            <Text style={{ color: '#22c55e', fontWeight: '700' }}>+{node.add || 0}</Text>  <Text style={{ color: '#ef4444', fontWeight: '700' }}>-{node.del || 0}</Text>
          </Text>
        </View>
        <View style={styles.diffActions}>
          {node.patch ? (
            <Pressable style={[styles.diffBtn, { backgroundColor: colors.card }]} onPress={() => setExpanded((v) => !v)}>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>{expanded ? '收起差异' : '查看差异'}</Text>
            </Pressable>
          ) : null}
          {node.path ? (
            <Pressable style={[styles.diffBtn, { backgroundColor: colors.card }]} onPress={() => node.path && onOpenFile(node.path)}>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>打开文件</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {expanded && node.patch ? (
        <ScrollView horizontal style={styles.patchScroll}>
          <Text selectable style={[styles.patchText, { color: colors.text }]}>{node.patch}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function CommandGroupView({
  groupId,
  commands,
  expanded,
  onToggle,
}: {
  groupId: string;
  commands: TimelineNode[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const isMulti = commands.length > 1;
  const summary = isMulti
    ? `终端执行了 ${commands.length} 条命令 ▾`
    : `${commands[0]?.text || '运行了命令'} ▾`;
  return (
    <Pressable onPress={onToggle} style={[styles.cmdGroup, { opacity: 0.88 }]}>
      <Text style={[styles.cmdLine, { color: colors.muted }]} numberOfLines={1}>
        🔲  {summary}
      </Text>
      {expanded
        ? commands.map((c) => (
            <Text key={`${groupId}-${c.id}`} style={[styles.cmdDetail, { color: colors.muted, opacity: 0.88 }]} numberOfLines={1}>
              └  {c.text}
            </Text>
          ))
        : null}
    </Pressable>
  );
}

function NodeView({
  node,
  mdStyle,
  onOpenFile,
}: {
  node: TimelineNode;
  mdStyle: Record<string, object>;
  onOpenFile: (path: string) => void;
}) {
  const { colors, theme } = useTheme();
  const [copied, setCopied] = useState(false);

  if (node.kind === 'user') {
    const [userExpanded, setUserExpanded] = useState(false);
    const lastTapRef = useRef<number>(0);
    const text = node.text || '';
    const lineCount = text.split('\n').length;
    const isLong = lineCount > 5 || text.length > 200;

    const ink = colors.text;
    const bg = colors.user;
    const border = colors.line;

    const handlePress = () => {
      const now = Date.now();
      if (now - lastTapRef.current < 350) {
        if (isLong) {
          setUserExpanded((v) => !v);
        }
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    };

    return (
      <View style={styles.userWrap}>
        <Pressable
          onPress={handlePress}
          onLongPress={() => { void Clipboard.setStringAsync(text); }}
          style={[styles.userBubble, { backgroundColor: bg, borderWidth: 1, borderColor: border }]}
        >
          <View style={!userExpanded && isLong ? { maxHeight: 110, overflow: 'hidden' } : undefined}>
            <Text selectable style={{ color: ink, fontSize: 15, lineHeight: 22 }}>
              {text}
            </Text>
          </View>
          {isLong ? (
            <Pressable
              onPress={() => setUserExpanded((v) => !v)}
              style={styles.btnTogglePrompt}
              hitSlop={6}
            >
              <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600' }}>
                {userExpanded ? '收起 ˄（双击亦可折叠）' : '展开全文 ˅'}
              </Text>
            </Pressable>
          ) : null}
        </Pressable>
      </View>
    );
  }

  if (node.kind === 'assistant') {
    const [assistantExpanded, setAssistantExpanded] = useState(true);
    const lastTapRef = useRef<number>(0);
    const text = node.text || '';
    const isVeryLong = text.split('\n').length > 18 || text.length > 800;

    const handlePress = () => {
      const now = Date.now();
      if (now - lastTapRef.current < 350) {
        if (isVeryLong) {
          setAssistantExpanded((v) => !v);
        }
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    };

    const handleLinkPress = (url: string) => {
      if (!url) return false;
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void Linking.openURL(url);
        return false;
      }
      const clean = url.replace(/^file:\/{2,3}/, '');
      onOpenFile(clean);
      return false;
    };

    return (
      <View style={styles.assistantWrap}>
        <Pressable
          style={styles.assistant}
          onPress={handlePress}
          onLongPress={() => { void Clipboard.setStringAsync(text); }}
        >
          <View style={!assistantExpanded && isVeryLong ? { maxHeight: 220, overflow: 'hidden' } : undefined}>
            <Markdown style={mdStyle} onLinkPress={handleLinkPress}>{text}</Markdown>
          </View>
          {isVeryLong ? (
            <Pressable
              onPress={() => setAssistantExpanded((v) => !v)}
              style={[styles.btnTogglePrompt, { alignSelf: 'flex-start', marginTop: 4 }]}
              hitSlop={6}
            >
              <Text style={{ color: colors.muted, fontSize: 12 }}>
                {assistantExpanded ? '双击消息可快速折叠 ˄' : '已折叠长消息（双击或点击展开 ˅）'}
              </Text>
            </Pressable>
          ) : null}
        </Pressable>
        <Pressable
          style={[styles.copyIconBtn, { backgroundColor: colors.shell }]}
          onPress={() => {
            void Clipboard.setStringAsync(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          hitSlop={6}
        >
          <Text style={{ fontSize: 11, color: colors.muted }}>{copied ? '✓ 已复制' : '复制'}</Text>
        </Pressable>
      </View>
    );
  }

  if (node.kind === 'command') {
    return (
      <View style={styles.cmdGroup}>
        <Text style={[styles.cmdLine, { color: colors.muted }]} numberOfLines={1}>🔲  {node.text}</Text>
      </View>
    );
  }

  if (node.kind === 'diff') {
    return <DiffNodeView node={node} onOpenFile={onOpenFile} />;
  }

  if (node.kind === 'system') {
    return (
      <View style={styles.systemWrap}>
        <Text style={{ color: colors.muted, fontSize: 12, textAlign: 'left' }}>{node.text}</Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  mainWrap: { flex: 1, width: '100%', maxWidth: 880, alignSelf: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
  },
  round: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  titlePill: { flex: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  ring: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  configBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 4,
  },
  configPill: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  miniChip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  mask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.28)',
    justifyContent: 'center',
    padding: 20,
    zIndex: 20,
  },
  card: { borderRadius: 16, padding: 14, gap: 4 },
  cardK: { fontSize: 11, marginTop: 6 },
  cardV: { fontSize: 14, lineHeight: 20 },
  menuItem: { paddingVertical: 10 },
  feed: { paddingHorizontal: 12, paddingBottom: 8, flexGrow: 1, gap: 6 },
  userWrap: { alignItems: 'flex-end' },
  userBubble: { maxWidth: '85%', borderRadius: 18, paddingHorizontal: 13, paddingVertical: 8 },
  btnTogglePrompt: {
    marginTop: 4,
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
  },
  assistantWrap: { alignSelf: 'stretch', paddingRight: 6, position: 'relative' },
  assistant: { alignSelf: 'stretch', paddingRight: 20 },
  copyIconBtn: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginTop: 3 },
  cmdCard: { paddingVertical: 1 },
  cmdText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },
  cmdGroup: { paddingVertical: 1, backgroundColor: 'transparent' },
  cmdGroupHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cmdCount: { fontSize: 11 },
  cmdLine: { fontSize: 12, lineHeight: 17 },
  cmdDetail: { fontSize: 11, lineHeight: 15, paddingLeft: 12 },
  diffCard: { borderRadius: 10, borderWidth: 1, padding: 10, gap: 6 },
  diffHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  diffPath: { fontSize: 13, fontWeight: '600' },
  diffActions: { flexDirection: 'row', gap: 6 },
  diffBtn: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  patchScroll: { maxHeight: 160, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.06)', padding: 6 },
  patchText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 15 },
  systemWrap: { alignSelf: 'flex-start', alignItems: 'flex-start', marginVertical: 2, paddingLeft: 2 },
  pad: { paddingHorizontal: 12, paddingBottom: 6 },
  floatingCapsuleWrap: { paddingHorizontal: 12, paddingBottom: 4, alignItems: 'center' },
  capsuleInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
    maxWidth: '92%',
  },
  capsuleText: { fontSize: 11, fontWeight: '600' },
  pendingBar: { paddingHorizontal: 12, paddingBottom: 6, gap: 6, flexDirection: 'row' },
  pendingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: 160,
  },
  pendingName: { fontSize: 11, maxWidth: 100 },
  pendingRemove: { padding: 2 },
  plusMenu: { marginHorizontal: 10, marginBottom: 4, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  slashMenu: { marginHorizontal: 10, marginBottom: 4, borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  popoverMenu: { marginHorizontal: 10, marginBottom: 4, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  popoverHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 2 },
  sheetCard: { marginHorizontal: 12, borderRadius: 14, borderWidth: 1, overflow: 'hidden', zIndex: 1 },
  plusItem: { paddingVertical: 10, paddingHorizontal: 14 },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingBottom: 10,
    gap: 6,
  },
  composerWrap: { paddingHorizontal: 10, paddingBottom: 8 },
  inputCard: {
    borderWidth: 1,
    borderRadius: 18,
    overflow: 'hidden',
    paddingTop: 4,
    paddingBottom: 4,
    paddingHorizontal: 2,
  },
  composerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingTop: 2,
    gap: 6,
  },
  composerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 4, minWidth: 0 },
  composerRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  toolBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  chipBtn: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 6 },
  modelPill: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 8, paddingVertical: 4, maxWidth: 200 },
  inputPill: { flex: 1, borderRadius: 20, paddingHorizontal: 12, minHeight: 38, justifyContent: 'center' },
  input: {
    fontSize: 15,
    maxHeight: 110,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  send: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
    overflow: 'hidden',
  },
});
