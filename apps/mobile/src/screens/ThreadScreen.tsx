import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Keyboard,
  type KeyboardEvent,
  Linking,
  Platform,
  useWindowDimensions,
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
import { approvalFromHistory, flattenItems, groupCommandNodes, type FeedNode } from '../history';
import { HandshakePanel } from '../components/HandshakePanel';
import { isQuotaError, isQuotaExhausted, quotaExhaustedMessage, formatContextUsage, formatQuotaLine } from '../quota';
import { WorkspaceSheet } from './WorkspaceSheet';
import { useHistories, useSession, useTools, useWorkspace } from '../session';
import { radius } from '../theme';
import { useTheme } from '../theme-context';
import { ACCESS_MODES, accessMeta, type FailedSend, type TimelineNode } from '../types';

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

const SPEED_OPTIONS = [
  { id: 'default', label: '标准' },
  { id: 'fast', label: '快速' },
] as const;

const webNoOutline = Platform.OS === 'web'
  ? ({ outlineWidth: 0, outlineStyle: 'none' as any, borderWidth: 0 } as any)
  : null;

export function ThreadScreen({
  threadId,
  onBack,
  onOpenLeft,
  onOpenRight,
  onOpenFile,
  onScan,
  onOpenThread,
  hideSideButtons = false,
}: {
  threadId?: string;
  onBack?: () => void;
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onOpenFile: (path: string) => void;
  onScan: () => void;
  onOpenThread?: (id: string) => void;
  hideSideButtons?: boolean;
}) {
  const session = useSession();
  const {
    histories: historiesMap,
    approvals,
    loadingOlder: loadingOlderMap,
    openThread,
    loadOlderHistory,
    sendApproval,
  } = useHistories();
  const tools = useTools();
  const workspace = useWorkspace();
  const { colors, showProcess } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const phone = screenW < 700;
  const [draft, setDraft] = useState('');
  const [kb, setKb] = useState(0);
  const [imeOpen, setImeOpen] = useState(false);
  const restHRef = useRef(screenH);
  const screenHRef = useRef(screenH);
  screenHRef.current = screenH;
  const [plus, setPlus] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'status' | 'more' | 'rename' | 'model' | 'effort' | 'access' | 'search' | 'goal' | 'skill' | 'mcp' | 'plugin' | 'plan' | 'review' | 'steer'>('none');
  const [goalDraft, setGoalDraft] = useState('');

  const SLASH_ITEMS = [
    { cmd: '/review', desc: '代码审查', kind: 'review' },
    { cmd: '/compact', desc: '压缩上下文', kind: 'send' },
    { cmd: '/init', desc: '初始化项目', kind: 'send' },
    { cmd: '/status', desc: '查看状态', kind: 'send' },
    { cmd: '/plan', desc: '规划模式', kind: 'plan' },
    { cmd: '/model', desc: '选择模型', kind: 'model' },
    { cmd: '/reasoning', desc: '推理强度', kind: 'effort' },
    { cmd: '/mcp', desc: 'MCP 服务器', kind: 'mcp' },
    { cmd: '/plugin', desc: '已安装插件', kind: 'plugin' },
    { cmd: '/goal', desc: '设置要持续追求的目标', kind: 'goal' },
    { cmd: '/aux', desc: '开辅助会话（不抢当前桌面会话）', kind: 'aux' },
  ];

  const slashQuery = draft.trim().startsWith('/') ? draft.trim().slice(1).toLowerCase() : '';
  const showSlash = draft.trim().startsWith('/');
  const filteredSlash = SLASH_ITEMS.filter(item =>
    item.cmd.toLowerCase().includes(slashQuery) || item.desc.toLowerCase().includes(slashQuery)
  );
  const [searchQ, setSearchQ] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [pending, setPending] = useState<{ name: string; path: string; image: boolean; skill?: boolean }[]>([]);
  const thread = session.threads.find((t) => t.id === threadId);
  const history = threadId ? historiesMap[threadId] : undefined;
  const loadingOlder = Boolean(threadId && loadingOlderMap[threadId]);
  const approval = threadId ? approvals[threadId] || approvalFromHistory(threadId, history) : null;

  const queuedMention = session.mention;
  const clearMention = session.clearMention;
  useEffect(() => {
    if (!queuedMention) return;
    const next = queuedMention;
    setPending((prev) => (prev.some((p) => p.path === next.path) ? prev : [...prev, { name: next.name, path: next.path, image: false }]));
    setDraft((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@${next.name} `);
    clearMention();
  }, [queuedMention, clearMention]);

  const dismissComposerPopups = () => {
    const trimmed = draft.trim();
    if (trimmed === '/' || trimmed === '/mcp' || trimmed === '/compact' || trimmed === '/plan' || trimmed === '/review' || trimmed === '$') {
      setDraft('');
    }
    if (plus) setPlus(false);
    if (sheet === 'access' || sheet === 'model') setSheet('none');
  };

  const nodes = useMemo(
    () => flattenItems(history?.items || []).filter((n) => {
      if (n.kind === 'user' || n.kind === 'assistant' || n.kind === 'diff' || n.kind === 'system') return true;
      if (!showProcess) return false;
      return n.kind === 'command' || n.kind === 'agent' || n.kind === 'reasoning';
    }),
    [history?.items, showProcess],
  );
  const feed = useMemo(() => groupCommandNodes(nodes), [nodes]);
  const working = history?.status === 'working';
  const project = session.projects.find((p) => p.threads.some((t) => t.id === threadId));
  const failedForThread = useMemo(
    () => (threadId ? session.failedSends.filter((item) => item.threadId === threadId) : []),
    [session.failedSends, threadId],
  );

  useEffect(() => {
    if (threadId) openThread(threadId);
  }, [threadId, openThread]);

  useEffect(() => {
    if (sheet === 'goal' && session.goal && session.goal.threadId === threadId) setGoalDraft(session.goal.objective);
  }, [session.goal, sheet, threadId]);

  useEffect(() => {
    if (imeOpen || isInputFocused) return;
    restHRef.current = screenH;
  }, [screenH, imeOpen, isInputFocused]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      setKb(0);
      setImeOpen(false);
      return;
    }
    const onShow = (e: KeyboardEvent) => {
      const imeH = Math.max(0, e.endCoordinates.height);
      const apply = () => {
        const resizedBy = Math.max(0, restHRef.current - screenHRef.current);
        setKb(Math.max(0, imeH - insets.bottom - resizedBy));
        setImeOpen(true);
      };
      apply();
      if (Platform.OS !== 'ios') requestAnimationFrame(apply);
    };
    const onHide = () => {
      setKb(0);
      setImeOpen(false);
    };
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, onShow);
    const hide = Keyboard.addListener(hideEvt, onHide);
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom]);

  useEffect(() => {
    const up = workspace.lastUpload;
    if (!up || up.error || !up.path) return;
    setPending((prev) => [...prev, { name: up.name, path: up.path, image: /\.(png|jpe?g|gif|webp)$/i.test(up.name) }]);
    workspace.clearUpload();
  }, [workspace.lastUpload, workspace.clearUpload]);

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
    workspace.uploadFile(threadId, name, b64, asset.mimeType || 'image/jpeg');
    setPlus(false);
  }

  async function pickFile() {
    if (!threadId) return;
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    const b64 = await new File(asset.uri).base64();
    workspace.uploadFile(threadId, asset.name || 'file', b64, asset.mimeType || '');
    setPlus(false);
  }

  function auxiliaryTitle() {
    const parent = String(thread?.title || '').replace(/^辅助[ ·・\-]+/, '').trim();
    return parent ? `辅助 · ${parent}` : '辅助会话';
  }

  function openAuxiliaryThread() {
    const cwd = history?.cwd || project?.cwd || '';
    session.createThread(cwd, auxiliaryTitle());
    setSheet('none');
    setDraft('');
  }

  function send() {
    if (!threadId) {
      session.createThread(session.projects[0]?.cwd);
      return;
    }
    const text = draft.trim();
    if (!text && !pending.length) return;
    const input = [
      ...pending.map((p) => (
        p.skill
          ? { type: 'skill', name: p.name, path: p.path }
          : p.image
            ? { type: 'localImage', path: p.path }
            : { type: 'mention', name: p.name, path: p.path }
      )),
      ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
    ];
    if (text.startsWith('$ ')) {
      if (tools.runCommand(threadId, text.slice(2))) setDraft('');
      return;
    }
    if (/^\/plan\b/i.test(text)) {
      setSheet('plan');
      setDraft(text.replace(/^\/plan\s*/i, ''));
      return;
    }
    if (/^\/review\b/i.test(text)) {
      setSheet('review');
      setDraft(text.replace(/^\/review\s*/i, ''));
      return;
    }
    if (/^\/aux\b/i.test(text)) {
      openAuxiliaryThread();
      return;
    }
    if (/^\/(compact|init|status)\b/.test(text)) {
      if (session.sendComposer(threadId, text, false)) setDraft('');
      return;
    }
    if (session.conn === 'hub_offline') return;
    if (isQuotaExhausted(session.quota)) return;
    if (working) {
      setSheet('steer');
      return;
    }
    if (session.sendComposer(threadId, text, false, input)) {
      setDraft('');
      setPending([]);
    }
  }

  function confirmSteer() {
    if (!threadId) return;
    const text = draft.trim();
    const input = [
      ...pending.map((p) => (
        p.skill
          ? { type: 'skill', name: p.name, path: p.path }
          : p.image
            ? { type: 'localImage', path: p.path }
            : { type: 'mention', name: p.name, path: p.path }
      )),
      ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
    ];
    if (session.sendComposer(threadId, text, true, input)) {
      setDraft('');
      setPending([]);
      setSheet('none');
    }
  }

  function discardSteer() {
    setDraft('');
    setPending([]);
    setSheet('none');
  }

  const ctxUsed = history?.tokenUsage?.usedPercent
    ?? session.quota.usedPercent
    ?? 0;
  const accountUsed = session.quota.primaryUsedPercent;
  const windowLeft = accountUsed == null ? null : Math.max(0, Math.min(100, 100 - accountUsed));
  const modelId = session.config.rawModel || session.config.model || '';
  const modelLabel = session.models.find((m) => m.id === modelId)?.displayName || modelId || '模型';
  const effortLabel = EFFORT_LABELS[session.config.effort || ''] || session.config.effort || '推理';
  const access = accessMeta(session.config.accessMode);
  const resetText = session.quota.resetAtMs
    ? new Date(session.quota.resetAtMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '未知';

  const mdStyle = useMemo(() => ({
    body: { color: colors.text, fontSize: 15.5, lineHeight: 23 },
    heading1: { color: colors.text, fontSize: 20, fontWeight: '600' as const },
    heading2: { color: colors.text, fontSize: 18, fontWeight: '600' as const },
    paragraph: { color: colors.text, fontSize: 15.5, lineHeight: 23 },
    strong: { color: colors.text, fontWeight: '600' as const },
    em: { color: colors.text },
    link: { color: colors.text, fontWeight: '600' as const, textDecorationLine: 'underline' as const },
    code_inline: {
      color: colors.text,
      fontWeight: '600' as const,
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
  }), [colors]);

  // MessageFeed 的 props 必须引用稳定，否则打字/切 sheet 时 memo 失效、整个列表重渲染。
  const { retryFailedSend, dismissFailedSend } = session;
  const handleReuse = useCallback((text: string) => setDraft(text), []);
  const handleRetryFailed = useCallback((id: string) => retryFailedSend(id), [retryFailedSend]);
  const handleRestoreFailed = useCallback((item: FailedSend) => {
    setDraft(item.text);
    dismissFailedSend(item.id);
  }, [dismissFailedSend]);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingBottom: kb > 0 ? kb : ((imeOpen || (Platform.OS === 'web' && isInputFocused && phone)) ? 8 : insets.bottom + 8) }]}>
      <View style={styles.mainWrap}>
        <View style={[styles.header, { borderBottomColor: colors.line }]}>
          <View style={styles.headerLeft}>
            {onBack ? (
              <Pressable onPress={onBack} style={[styles.headerIconBtn, { backgroundColor: colors.shell }]} hitSlop={6} accessibilityLabel="返回任务列表">
                <Text style={{ color: colors.text, fontSize: 16 }}>←</Text>
              </Pressable>
            ) : !hideSideButtons ? (
              <Pressable onPress={onOpenLeft} style={[styles.headerIconBtn, { backgroundColor: colors.shell }]} hitSlop={6}>
                <Text style={{ color: colors.text, fontSize: 16 }}>☰</Text>
              </Pressable>
            ) : null}
            <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
              {thread?.title || '新聊天'}
            </Text>
            <View style={[styles.headerBadge, { backgroundColor: session.conn === 'connected' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)' }]}>
              <View style={[styles.liveDot, { backgroundColor: session.conn === 'connected' ? '#22c55e' : '#ef4444' }]} />
              <Text style={{ fontSize: 11, fontWeight: '600', color: session.conn === 'connected' ? '#15803d' : '#ef4444' }}>
                {session.conn === 'connected' ? (history?.status === 'working' ? '运行中' : '已就绪') : '离线'}
              </Text>
            </View>
          </View>
          <View style={styles.headerRight}>
            {!hideSideButtons && (
              <Pressable onPress={onOpenRight} style={[styles.headerIconBtn, { backgroundColor: colors.shell }]} hitSlop={6} accessibilityLabel="工作区文件">
                <FolderOutlineIcon size={15} />
              </Pressable>
            )}
            <Pressable onPress={() => setSheet((s) => (s === 'more' ? 'none' : 'more'))} style={[styles.headerIconBtn, { backgroundColor: colors.shell }]} hitSlop={6} accessibilityLabel="更多操作">
              <Text style={{ color: colors.text, fontSize: 16 }}>⋯</Text>
            </Pressable>
          </View>
        </View>

      {session.handshake.active ? (
        <HandshakePanel
          handshake={session.handshake}
          onRetry={session.mode === 'relay' ? onScan : session.refreshThreads}
          retryLabel={session.handshake.phase === 'offline' ? '再试一次' : (session.mode === 'relay' ? (Platform.OS === 'web' ? '重新连接' : '扫出门码') : '刷新')}
        />
      ) : null}
      {history?.lockHolder === 'desktop' ? (
        <Text style={{ marginHorizontal: 16, marginBottom: 8, color: '#92400e', fontSize: 12 }}>
          电脑正在持锁。发、停、审批都交给桌面；点批准后若桌面还弹窗，请在电脑上再确认一次。
        </Text>
      ) : history?.lockHolder === 'hub' ? (
        <Text style={{ marginHorizontal: 16, marginBottom: 8, color: colors.muted, fontSize: 12 }}>
          当前由 Hub 代跑，手机批准即可，不必开桌面。
        </Text>
      ) : null}
      {session.conn === 'hub_offline' ? (
        <Text style={{ marginHorizontal: 16, marginBottom: 8, color: colors.danger, fontSize: 12 }}>
          主机离线。电脑醒了才能发消息。
        </Text>
      ) : null}
      {isQuotaExhausted(session.quota) || isQuotaError(session.error) ? (
        <Text style={{ marginHorizontal: 16, marginBottom: 8, color: '#b91c1c', fontSize: 12 }}>
          {isQuotaError(session.error) && /额度用完/.test(session.error)
            ? session.error
            : quotaExhaustedMessage(session.quota, session.error)}
        </Text>
      ) : null}
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

      <MessageFeed
        feed={feed}
        threadId={threadId}
        status={history?.status}
        full={Boolean(history?.full)}
        hasMore={Boolean(history?.hasMore)}
        remainingServer={Math.max(0, (history?.totalItems || 0) - (history?.items?.length || 0))}
        loadingOlder={loadingOlder}
        failed={failedForThread}
        mdStyle={mdStyle}
        onOpenFile={onOpenFile}
        onReuse={handleReuse}
        onLoadOlder={loadOlderHistory}
        onRetryFailed={handleRetryFailed}
        onRestoreFailed={handleRestoreFailed}
      />

      {approval && threadId ? (
        <View style={styles.pad}>
          <ApprovalBar approval={approval} lockHolder={history?.lockHolder} onDecide={(d) => sendApproval(threadId, d)} />
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
              {formatContextUsage(history?.tokenUsage) || (ctxUsed ? `占用 ${ctxUsed}%` : '暂无')}
            </Text>
            {(history?.tokenUsage?.sources || []).map((src) => (
              <Text key={src.label} style={{ color: colors.muted, fontSize: 12 }}>
                {src.label} {Math.round(src.percent)}%
              </Text>
            ))}
            <Text style={[styles.cardK, { color: colors.muted }]}>用量窗口</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>
              {formatQuotaLine(session.quota) || (windowLeft != null ? `剩余 ${Math.round(windowLeft)}% · 重置 ${resetText}` : '暂无')}
            </Text>
          </View>
        </Pressable>
      ) : null}

      {sheet === 'more' && threadId ? (
        <View style={styles.dropdownWrap}>
          <Pressable style={styles.dropdownBackdrop} onPress={() => setSheet('none')} />
          <View style={[styles.dropdownMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
            <Pressable style={styles.dropdownItem} onPress={() => setSheet('search')}>
              <Text style={{ color: colors.text, fontSize: 14 }}>🔍 会话内搜索</Text>
            </Pressable>
            <Pressable style={styles.dropdownItem} onPress={() => { session.togglePin(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.text, fontSize: 14 }}>{(thread?.isPinned || session.pinnedIds.includes(threadId)) ? '📌 取消置顶' : '📌 置顶'}</Text>
            </Pressable>
            <Pressable style={styles.dropdownItem} onPress={() => { void Clipboard.setStringAsync(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.text, fontSize: 14 }}>📋 复制会话 ID</Text>
            </Pressable>
            <Pressable style={styles.dropdownItem} onPress={() => { setRenameDraft(thread?.title || ''); setSheet('rename'); }}>
              <Text style={{ color: colors.text, fontSize: 14 }}>✏️ 重命名</Text>
            </Pressable>
            <Pressable style={styles.dropdownItem} onPress={openAuxiliaryThread}>
              <Text style={{ color: colors.text, fontSize: 14 }}>⧉ 开辅助会话</Text>
            </Pressable>
            <View style={[styles.dropdownDivider, { backgroundColor: colors.line }]} />
            <Pressable style={styles.dropdownItem} onPress={() => { session.archiveThread(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.danger, fontSize: 14 }}>📦 归档</Text>
            </Pressable>
          </View>
        </View>
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
              onSubmitEditing={() => tools.searchThread(threadId, searchQ)}
            />
            <Pressable style={{ marginTop: 10, alignSelf: 'flex-end' }} onPress={() => tools.searchThread(threadId, searchQ)}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>搜索</Text>
            </Pressable>
            {tools.searchHits.map((hit, i) => (
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

      {sheet === 'skill' ? (
        <View style={[styles.popoverMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <View style={styles.popoverHeader}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>Skill</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={8}>
              <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: Math.round(Dimensions.get('window').height * 0.4) }}>
            {(session.skills.length ? session.skills : []).map((skill) => (
              <View key={skill.path || skill.name} style={[styles.plusItem, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => {
                    if (!skill.path) return;
                    setPending((prev) => prev.some((p) => p.path === skill.path) ? prev : [...prev, { name: skill.name, path: skill.path || '', image: false, skill: true }]);
                    setSheet('none');
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{skill.name}</Text>
                  {skill.shortDescription || skill.description ? (
                    <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={2}>{skill.shortDescription || skill.description}</Text>
                  ) : null}
                </Pressable>
                <Pressable
                  onPress={() => session.setSkillEnabled({ path: skill.path, name: skill.name, enabled: skill.enabled === false }, history?.cwd || project?.cwd || '')}
                  hitSlop={8}
                >
                  <Text style={{ color: skill.enabled === false ? colors.muted : colors.ok, fontSize: 12, fontWeight: '700' }}>
                    {skill.enabled === false ? '开启' : '停用'}
                  </Text>
                </Pressable>
              </View>
            ))}
            {!session.skills.length ? <Text style={{ color: colors.muted, padding: 16 }}>没有可用 Skill</Text> : null}
          </ScrollView>
        </View>
      ) : null}

      {sheet === 'plugin' ? (
        <View style={[styles.popoverMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <View style={styles.popoverHeader}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>插件</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={8}>
              <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: Math.round(Dimensions.get('window').height * 0.4) }}>
            {session.plugins.map((plugin) => (
              <View key={plugin.id} style={[styles.plusItem, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => {
                    setDraft((prev) => `${prev ? `${prev.trim()} ` : ''}${plugin.mention || `@${plugin.name}`} `);
                    setSheet('none');
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{plugin.displayName || plugin.name}</Text>
                  <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={2}>
                    {plugin.needsDesktopUi ? '需电脑画面 · ' : ''}{plugin.description || plugin.mention}
                  </Text>
                </Pressable>
                <Pressable onPress={() => session.setPluginEnabled(plugin.id, plugin.enabled === false)} hitSlop={8}>
                  <Text style={{ color: plugin.enabled === false ? colors.muted : colors.ok, fontSize: 12, fontWeight: '700' }}>
                    {plugin.enabled === false ? '开启' : '停用'}
                  </Text>
                </Pressable>
              </View>
            ))}
            {!session.plugins.length ? <Text style={{ color: colors.muted, padding: 16 }}>没有已安装插件</Text> : null}
          </ScrollView>
        </View>
      ) : null}

      {sheet === 'mcp' ? (
        <View style={[styles.popoverMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <View style={styles.popoverHeader}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>MCP</Text>
            <Pressable onPress={() => { session.reloadMcp(); }} hitSlop={8}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>重载</Text>
            </Pressable>
            <Pressable onPress={() => setSheet('none')} hitSlop={8}>
              <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: Math.round(Dimensions.get('window').height * 0.4) }}>
            {session.mcpServers.map((s) => (
              <View key={s.name} style={styles.plusItem}>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{s.name}</Text>
                <Text style={{ color: s.needsAuth ? '#b45309' : colors.muted, fontSize: 12, fontWeight: s.needsAuth ? '700' : '400' }}>
                  {s.needsAuth ? `⚠ 需在电脑登录 · ${s.authStatus || 'oauth'}` : `${s.toolCount || 0} 个工具${s.tools?.length ? ` · ${s.tools.slice(0, 4).join(', ')}` : ''}`}
                </Text>
              </View>
            ))}
            {!session.mcpServers.length ? <Text style={{ color: colors.muted, padding: 16 }}>没有 MCP 服务器</Text> : null}
          </ScrollView>
        </View>
      ) : null}

      {sheet === 'steer' ? (
        <View style={[styles.popoverMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <View style={styles.popoverHeader}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>当前正在跑，调整方向？</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={8}>
              <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
          <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 14, paddingBottom: 8 }} numberOfLines={3}>
            {draft.trim() || '（附件）'}
          </Text>
          <Pressable style={styles.plusItem} onPress={confirmSteer}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>立即调整</Text>
            <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>发给桌面，插入当前这一轮</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={discardSteer}>
            <Text style={{ color: '#b91c1c', fontSize: 15, fontWeight: '600' }}>删除</Text>
            <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>丢掉这条，不发给 Codex</Text>
          </Pressable>
        </View>
      ) : null}

      {plus ? (
        <View style={[styles.plusMenu, { backgroundColor: colors.bg, borderColor: colors.line, maxHeight: phone ? Math.round(screenH * 0.42) : undefined }]}>
          <ScrollView keyboardShouldPersistTaps="handled">
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
          <Pressable style={styles.plusItem} onPress={() => {
            session.requestSkills(history?.cwd || project?.cwd || '');
            setSheet('skill');
            setPlus(false);
          }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>⚡ Skill</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { session.requestMcp(); setSheet('mcp'); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>☀ MCP</Text>
          </Pressable>
          {threadId ? (
            <Pressable style={styles.plusItem} onPress={() => {
              if (phone) onOpenRight();
              else tools.gitStatus(threadId);
              setPlus(false);
            }}>
              <Text style={{ color: colors.text, fontSize: 15 }}>{phone ? '🌿 工作区 / Git / 命令' : '🌿 查看 Git 状态'}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.plusItem} onPress={() => { setSheet('review'); setPlus(false); setDraft(''); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🔍 /review 代码审查</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { setSheet('plan'); setPlus(false); setDraft(''); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🗂 /plan 规划模式</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { session.requestPlugins(); setSheet('plugin'); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🔌 已安装插件</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { setDraft('/compact '); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🗜️ /compact 压缩上下文</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => {
            if (phone) { onOpenRight(); setPlus(false); }
            else { setDraft('$ '); setPlus(false); }
          }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>💻 跑终端命令</Text>
          </Pressable>
          </ScrollView>
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
          {(Object.keys(ACCESS_MODES) as (keyof typeof ACCESS_MODES)[]).map((id) => {
            const meta = ACCESS_MODES[id];
            const on = (session.config.accessMode || 'full') === id;
            const desc = meta.hint;
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
            <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 16, marginTop: 10, marginBottom: 8, fontWeight: '600' }}>
              速度
            </Text>
            <View style={{ flexDirection: 'row', paddingHorizontal: 14, gap: 6, flexWrap: 'wrap' }}>
              {SPEED_OPTIONS.map((opt) => {
                const on = (session.config.speed || 'default') === opt.id;
                return (
                  <Pressable
                    key={opt.id}
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
                    onPress={() => { session.updateConfig('speed', opt.id); }}
                  >
                    <Text style={{ color: on ? colors.bg : colors.text, fontSize: 12, fontWeight: on ? '700' : '500' }}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      ) : null}

      {!phone && tools.git ? (
        <Text selectable style={{ color: colors.muted, paddingHorizontal: 16, paddingBottom: 6, fontSize: 12 }}>
          {(tools.git.error || [tools.git.status, tools.git.diff, tools.git.log].filter(Boolean).join('\n')).slice(0, 4000)}
        </Text>
      ) : null}
      {!phone && tools.commandOut ? (
        <Text selectable style={{ color: colors.muted, paddingHorizontal: 16, paddingBottom: 6, fontSize: 12 }}>
          {tools.commandOut.slice(-4000)}
        </Text>
      ) : null}

      {/* Slash command menu (live filter when typing /) - 与 Codex 保持一致 */}
      {showSlash && filteredSlash.length > 0 ? (
        <View style={[styles.slashMenu, { backgroundColor: colors.bg, borderColor: colors.line, maxHeight: phone ? Math.round(screenH * 0.36) : 240 }]}>
          <ScrollView keyboardShouldPersistTaps="handled">
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
                  session.requestMcp();
                  setSheet('mcp');
                  setDraft('');
                } else if (item.kind === 'model') {
                  setSheet('model');
                  setDraft('');
                } else if (item.kind === 'effort') {
                  setSheet('model');
                  setDraft('');
                } else if (item.kind === 'plugin') {
                  session.requestPlugins();
                  setSheet('plugin');
                  setDraft('');
                } else if (item.kind === 'plan' || item.kind === 'review') {
                  setSheet(item.kind);
                  setDraft('');
                } else if (item.kind === 'aux') {
                  openAuxiliaryThread();
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
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.composerWrap}>
        <View style={[styles.inputCard, { backgroundColor: colors.bg, borderColor: isInputFocused ? colors.text : colors.line, borderWidth: 1 }]}>
          {pending.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingBar}>
              {pending.map((p, idx) => (
                <View key={`${p.path}-${idx}`} style={[styles.pendingChip, { backgroundColor: colors.card, borderColor: colors.line }]}>
                  <Text style={{ fontSize: 13 }}>{p.skill ? '⚡' : p.image ? '🖼️' : '📄'}</Text>
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
            placeholder={session.conn === 'hub_offline' ? '电脑醒了才能发' : (threadId ? '随心输入' : '先开一个会话')}
            placeholderTextColor={colors.muted}
            style={[
              styles.input,
              { color: colors.text },
              phone && !isInputFocused && !draft.includes('\n')
                ? { height: 28, maxHeight: 28 }
                : { minHeight: phone ? 46 : 32, maxHeight: 110 },
              webNoOutline,
            ]}
            multiline
            editable={session.conn === 'connected' && !approval && !isQuotaExhausted(session.quota)}
            underlineColorAndroid="transparent"
            onPressIn={dismissComposerPopups}
            onFocus={(e) => {
              dismissComposerPopups();
              setIsInputFocused(true);
              if (Platform.OS === 'web') {
                const node = e.target as unknown as { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void };
                node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
              }
            }}
            onBlur={() => setIsInputFocused(false)}
          />
          <View style={styles.composerBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={styles.composerLeftScroll}
              contentContainerStyle={styles.composerLeft}
            >
              <Pressable
                style={styles.toolBtn}
                onPress={() => {
                  setPlus((v) => !v);
                  if (sheet === 'access' || sheet === 'model') setSheet('none');
                  const t = draft.trim();
                  if (t === '/' || t === '/mcp' || t === '/compact' || t === '/plan' || t === '/review' || t === '$') {
                    setDraft('');
                  }
                }}
                hitSlop={6}
              >
                <Text style={{ color: colors.text, fontSize: 20, fontWeight: '400' }}>+</Text>
              </Pressable>
              <Pressable
                style={styles.toolBtn}
                onPress={() => {
                  setPlus(false);
                  if (sheet === 'access' || sheet === 'model') setSheet('none');
                  setDraft(draft.startsWith('/') ? draft : '/');
                }}
                hitSlop={6}
              >
                <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>/</Text>
              </Pressable>
              {phone ? (
                <Pressable
                  style={[styles.chipBtn, { paddingHorizontal: 6, minWidth: 26, alignItems: 'center' }]}
                  onPress={() => { setPlus(false); setSheet((s) => (s === 'status' ? 'none' : 'status')); }}
                  hitSlop={4}
                  accessibilityLabel="剩余额度"
                >
                  <Text style={{ color: isQuotaExhausted(session.quota) ? colors.danger : colors.muted, fontSize: 13 }}>◎</Text>
                </Pressable>
              ) : null}
              {phone ? null : (
              <Pressable
                style={styles.chipBtn}
                onPress={() => {
                  setPlus(false);
                  session.requestSkills(history?.cwd || project?.cwd || '');
                  setSheet('skill');
                }}
                hitSlop={4}
              >
                <Text style={{ color: colors.text, fontSize: 13 }}>⚡ Skill</Text>
              </Pressable>
              )}
              {phone ? null : (
              <Pressable
                style={styles.chipBtn}
                onPress={() => {
                  setPlus(false);
                  if (sheet === 'access' || sheet === 'model') setSheet('none');
                  setDraft('/mcp ');
                }}
                hitSlop={4}
              >
                <Text style={{ color: colors.text, fontSize: 13 }}>☀ MCP</Text>
              </Pressable>
              )}
              <Pressable
                style={[styles.chipBtn, phone && { paddingHorizontal: 6, minWidth: 26, alignItems: 'center' }]}
                onPress={() => {
                  setPlus(false);
                  const t = draft.trim();
                  if (t === '/' || t === '/mcp' || t === '/compact' || t === '/plan' || t === '/review' || t === '$') {
                    setDraft('');
                  }
                  setSheet((s) => (s === 'access' ? 'none' : 'access'));
                }}
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
                  {access.icon}{phone ? '' : ` ${access.shortLabel}`}
                </Text>
              </Pressable>
            </ScrollView>
            <View style={styles.composerRight}>
              <Pressable
                style={[styles.modelPill, { backgroundColor: colors.shell, borderColor: colors.line }]}
                onPress={() => {
                  setPlus(false);
                  const t = draft.trim();
                  if (t === '/' || t === '/mcp' || t === '/compact' || t === '/plan' || t === '/review' || t === '$') {
                    setDraft('');
                  }
                  setSheet((s) => (s === 'model' ? 'none' : 'model'));
                }}
              >
                <Text style={{ color: colors.text, fontSize: 12, fontWeight: '500' }} numberOfLines={1}>
                  {phone ? `${modelLabel.split(' ')[0] || modelLabel} ∨` : <>{modelLabel} · <Text style={{ color: colors.muted }}>{effortLabel}</Text> ∨</>}
                </Text>
              </Pressable>
              {working && threadId ? (
                <Pressable
                  style={({ pressed }) => [styles.send, { backgroundColor: colors.danger }, pressed && { opacity: 0.75 }, webNoOutline]}
                  onPress={() => session.sendStop(threadId)}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>停</Text>
                </Pressable>
              ) : null}
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
            </View>
          </View>
        </View>
      </View>
      {sheet === 'plan' || sheet === 'review' ? (
        <WorkspaceSheet
          mode={sheet}
          history={history}
          diffs={nodes.filter((n) => n.kind === 'diff')}
          git={tools.git}
          working={working}
          onClose={() => setSheet('none')}
          onRefreshGit={() => { if (threadId) tools.gitStatus(threadId); }}
          onOpenFile={(path) => { if (threadId) workspace.requestFile(threadId, path); }}
          onSend={(text, mode) => {
            if (!threadId) return false;
            return session.sendComposer(threadId, text, working, undefined, mode);
          }}
        />
      ) : null}
    </View>
    </View>
  );
}

// 消息列表独立成 memo 组件：输入框打字、开关 sheet 只重渲染 ThreadScreen 外壳，
// 列表本身（含全部 Markdown 消息）不参与重渲染。props 需保持引用稳定。
const FEED_WINDOW = Platform.OS === 'web' ? 80 : 400;
const FEED_CHUNK = Platform.OS === 'web' ? 60 : 200;

const feedKeyExtractor = (item: FeedNode) => item.id;

const MessageFeed = memo(function MessageFeed({
  feed,
  threadId,
  status,
  full,
  hasMore,
  remainingServer,
  loadingOlder,
  failed,
  mdStyle,
  onOpenFile,
  onReuse,
  onLoadOlder,
  onRetryFailed,
  onRestoreFailed,
}: {
  feed: FeedNode[];
  threadId?: string;
  status?: string;
  full: boolean;
  hasMore: boolean;
  remainingServer: number;
  loadingOlder: boolean;
  failed: FailedSend[];
  mdStyle: Record<string, object>;
  onOpenFile: (path: string) => void;
  onReuse: (text: string) => void;
  onLoadOlder: (threadId: string) => void;
  onRetryFailed: (id: string) => void;
  onRestoreFailed: (item: FailedSend) => void;
}) {
  const { colors } = useTheme();
  const listRef = useRef<FlatList<FeedNode>>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [expandedCmdGroups, setExpandedCmdGroups] = useState<Set<string>>(new Set());
  const [expandedAgentGroups, setExpandedAgentGroups] = useState<Set<string>>(new Set());
  const isNearBottomRef = useRef(true);
  const lastThreadIdRef = useRef<string | undefined | null>(null);
  const prevCountRef = useRef(0);
  const skipStickToBottomRef = useRef(false);
  const preserveScrollRef = useRef<{ y: number; height: number } | null>(null);
  const lastScrollRef = useRef({ y: 0, height: 0 });
  const feedLenRef = useRef(0);

  const visibleFeed = useMemo(
    () => (hiddenCount > 0 ? feed.slice(hiddenCount) : feed),
    [feed, hiddenCount],
  );

  const toggleCmdGroup = useCallback((id: string) => {
    setExpandedCmdGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAgentGroup = useCallback((id: string) => {
    setExpandedAgentGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderFeedItem = useCallback(({ item }: { item: FeedNode; index: number }) => {
    if (item.kind === 'cmd-group') {
      return (
        <CommandGroupView
          groupId={item.id}
          commands={item.commands}
          expanded={expandedCmdGroups.has(item.id)}
          onToggle={toggleCmdGroup}
        />
      );
    }
    if (item.kind === 'agent-group') {
      return (
        <AgentGroupView
          groupId={item.id}
          agents={item.agents}
          expanded={expandedAgentGroups.has(item.id)}
          onToggle={toggleAgentGroup}
        />
      );
    }
    return <NodeView node={item} mdStyle={mdStyle} onOpenFile={onOpenFile} onReuse={onReuse} />;
  }, [mdStyle, onOpenFile, onReuse, expandedCmdGroups, expandedAgentGroups, toggleCmdGroup, toggleAgentGroup]);

  useEffect(() => {
    skipStickToBottomRef.current = false;
    preserveScrollRef.current = null;
    feedLenRef.current = feed.length;
    setHiddenCount(full && feed.length > FEED_WINDOW ? feed.length - FEED_WINDOW : 0);
    // 仅在切换会话时重置窗口，故意不依赖 full/feed.length，避免流式更新时反复重开窗口
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    const prevLen = feedLenRef.current;
    feedLenRef.current = feed.length;
    if (skipStickToBottomRef.current && feed.length > prevLen) {
      setHiddenCount((hidden) => {
        const prevVisible = Math.max(1, prevLen - hidden);
        const keep = Math.min(prevVisible, FEED_WINDOW);
        return Math.max(0, feed.length - keep);
      });
    }
  }, [feed.length]);

  useEffect(() => {
    if (loadingOlder) return;
    const t = setTimeout(() => {
      skipStickToBottomRef.current = false;
    }, 400);
    return () => clearTimeout(t);
  }, [loadingOlder, hiddenCount]);

  useEffect(() => {
    if (!feed.length && !failed.length) return;
    if (threadId !== lastThreadIdRef.current) {
      lastThreadIdRef.current = threadId;
      isNearBottomRef.current = true;
      prevCountRef.current = feed.length;
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
      return;
    }
    const countIncreased = feed.length > prevCountRef.current;
    prevCountRef.current = feed.length;
    if (countIncreased && isNearBottomRef.current && !skipStickToBottomRef.current) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [threadId, feed.length, failed.length, status]);

  return (
    <FlatList
      ref={listRef}
      data={visibleFeed}
      extraData={`${loadingOlder}:${hiddenCount}:${hasMore ? 1 : 0}`}
      keyExtractor={feedKeyExtractor}
      contentContainerStyle={[styles.feed, { paddingBottom: 28 }]}
      initialNumToRender={25}
      maxToRenderPerBatch={25}
      windowSize={11}
      ListEmptyComponent={<EmptyState title={threadId ? '开始处理' : '选择或新建会话'} />}
      ListHeaderComponent={(() => {
        if (!threadId) return null;
        const canReveal = hiddenCount > 0;
        const canFetch = hasMore && !canReveal;
        const showDone = full && !canReveal && !canFetch && !loadingOlder;
        if (!loadingOlder && !canReveal && !canFetch && !showDone) return null;
        const label = loadingOlder
          ? '正在载入更早消息…'
          : canReveal
            ? `↑ 继续向上加载（还有 ${hiddenCount} 条更早消息）`
            : canFetch
              ? `↑ 加载更早的历史消息${remainingServer > 0 ? `（剩余 ${remainingServer} 条）` : ''}`
              : '已到最早的消息';
        const inner = (
          <>
            {loadingOlder ? <ActivityIndicator size="small" color={colors.muted} /> : null}
            <Text style={{ color: colors.muted, fontSize: 13, fontWeight: '500' }}>{label}</Text>
          </>
        );
        if (!canReveal && !canFetch) {
          return <View style={[styles.loadMoreBar, { opacity: 0.85 }]}>{inner}</View>;
        }
        return (
          <Pressable
            disabled={loadingOlder}
            onPress={() => {
              skipStickToBottomRef.current = true;
              isNearBottomRef.current = false;
              if (canReveal) {
                preserveScrollRef.current = {
                  y: lastScrollRef.current.y,
                  height: lastScrollRef.current.height,
                };
                setHiddenCount((count) => Math.max(0, count - FEED_CHUNK));
                return;
              }
              if (canFetch) onLoadOlder(threadId);
            }}
            style={[styles.loadMoreBar, { opacity: loadingOlder ? 0.7 : 1 }]}
          >
            {inner}
          </Pressable>
        );
      })()}
      onContentSizeChange={(_w, h) => {
        const prev = preserveScrollRef.current;
        lastScrollRef.current.height = h;
        if (prev) {
          const delta = h - prev.height;
          if (delta > 0) {
            listRef.current?.scrollToOffset({ offset: prev.y + delta, animated: false });
            lastScrollRef.current.y = prev.y + delta;
          }
          preserveScrollRef.current = null;
          return;
        }
        if (isNearBottomRef.current && !skipStickToBottomRef.current) {
          listRef.current?.scrollToEnd({ animated: false });
        }
      }}
      onScroll={(e) => {
        const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
        lastScrollRef.current = { y: contentOffset.y, height: contentSize.height };
        const distToBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
        isNearBottomRef.current = distToBottom < 120;
      }}
      scrollEventThrottle={100}
      renderItem={renderFeedItem}
      ListFooterComponent={
        failed.length ? (
          <View style={{ gap: 6, paddingTop: 4 }}>
            {failed.map((item) => (
              <FailedSendView
                key={item.id}
                item={item}
                onRetry={() => onRetryFailed(item.id)}
                onRestore={() => onRestoreFailed(item)}
              />
            ))}
          </View>
        ) : null
      }
    />
  );
});

function DiffNodeView({ node, onOpenFile }: { node: TimelineNode; onOpenFile: (path: string) => void }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={[styles.diffCard, { backgroundColor: colors.shell, borderColor: colors.line }]}>
      <View style={styles.diffHeader}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.diffPath, { color: colors.text }]} numberOfLines={1}>◇  {node.text}</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>
            <Text style={{ color: '#16a34a', fontWeight: '600' }}>+{node.add || 0}</Text>  <Text style={{ color: '#dc2626', fontWeight: '600' }}>-{node.del || 0}</Text>
          </Text>
        </View>
        <View style={styles.diffActions}>
          {node.patch ? (
            <Pressable style={[styles.diffBtn, { backgroundColor: colors.card }]} onPress={() => setExpanded((v) => !v)}>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '500' }}>{expanded ? '收起差异' : '查看差异'}</Text>
            </Pressable>
          ) : null}
          {node.path ? (
            <Pressable style={[styles.diffBtn, { backgroundColor: colors.card }]} onPress={() => node.path && onOpenFile(node.path)}>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '500' }}>打开文件</Text>
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

function nodeTextsEqual(a: TimelineNode[], b: TimelineNode[]): boolean {
  return a.length === b.length && a.every((n, i) => n.id === b[i].id && n.text === b[i].text);
}

const CommandGroupView = memo(function CommandGroupView({
  groupId,
  commands,
  expanded,
  onToggle,
}: {
  groupId: string;
  commands: TimelineNode[];
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { colors } = useTheme();
  const isMulti = commands.length > 1;
  const summary = isMulti
    ? `终端执行了 ${commands.length} 条命令 ▾`
    : `${commands[0]?.text || '运行了命令'} ▾`;
  return (
    <Pressable onPress={() => onToggle(groupId)} style={[styles.cmdGroup, { opacity: 0.88 }]}>
      <Text style={[styles.cmdLine, { color: colors.muted }]} numberOfLines={1}>
        □  {summary}
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
}, (a, b) => a.expanded === b.expanded && a.onToggle === b.onToggle && nodeTextsEqual(a.commands, b.commands));

const AgentGroupView = memo(function AgentGroupView({
  groupId,
  agents,
  expanded,
  onToggle,
}: {
  groupId: string;
  agents: TimelineNode[];
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { colors } = useTheme();
  const isMulti = agents.length > 1;
  const summary = isMulti
    ? `•  子智能体动态 (${agents.length} 条已更新) ▾`
    : `•  ${agents[0]?.text || '子智能体已更新'}`;

  if (!isMulti) {
    return (
      <View style={styles.cmdGroup}>
        <Text style={[styles.cmdLine, { color: colors.muted, opacity: 0.85 }]} numberOfLines={1}>
          {summary}
        </Text>
      </View>
    );
  }

  return (
    <Pressable onPress={() => onToggle(groupId)} style={[styles.cmdGroup, { opacity: 0.88 }]}>
      <Text style={[styles.cmdLine, { color: colors.muted }]} numberOfLines={1}>
        {expanded ? `•  子智能体动态 (${agents.length} 条已更新) ▴` : summary}
      </Text>
      {expanded
        ? agents.map((a) => (
            <Text key={`${groupId}-${a.id}`} style={[styles.cmdDetail, { color: colors.muted, opacity: 0.85 }]} numberOfLines={1}>
              └  {a.text}
            </Text>
          ))
        : null}
    </Pressable>
  );
}, (a, b) => a.expanded === b.expanded && a.onToggle === b.onToggle && nodeTextsEqual(a.agents, b.agents));

function FailedSendView({
  item,
  onRetry,
  onRestore,
}: {
  item: FailedSend;
  onRetry: () => void;
  onRestore: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.userWrap}>
      <View style={[styles.userBubble, styles.failedBubble, { backgroundColor: colors.user, borderColor: colors.danger }]}>
        <Text selectable style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}>
          {item.text || '(附件)'}
        </Text>
        <View style={styles.failedMeta}>
          <Text style={{ color: colors.danger, fontSize: 12 }}>发送失败</Text>
          <Pressable onPress={onRetry} style={[styles.failedBtn, { borderColor: colors.danger }]} hitSlop={6}>
            <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600' }}>重试</Text>
          </Pressable>
          <Pressable onPress={onRestore} style={[styles.failedBtn, { borderColor: colors.danger }]} hitSlop={6}>
            <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600' }}>放回输入框</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

type NodeViewProps = {
  node: TimelineNode;
  mdStyle: Record<string, object>;
  onOpenFile: (path: string) => void;
  onReuse?: (text: string) => void;
};

// 流式更新会整体重建 nodes 数组，node 对象引用每次都变，
// 因此按内容（id/kind/text/patch）判断能否跳过重渲染。
function nodeViewPropsEqual(a: NodeViewProps, b: NodeViewProps): boolean {
  if (a.onOpenFile !== b.onOpenFile || a.onReuse !== b.onReuse || a.mdStyle !== b.mdStyle) return false;
  const x = a.node;
  const y = b.node;
  if (x === y) return true;
  return x.id === y.id
    && x.kind === y.kind
    && x.text === y.text
    && x.patch === y.patch
    && x.path === y.path
    && x.add === y.add
    && x.del === y.del;
}

// 按 kind 分发到子组件，保证每个子组件的 hooks 无条件调用。
const NodeView = memo(function NodeView({ node, mdStyle, onOpenFile, onReuse }: NodeViewProps) {
  switch (node.kind) {
    case 'reasoning':
      return <ReasoningNodeView node={node} />;
    case 'user':
      return <UserNodeView node={node} onReuse={onReuse} />;
    case 'assistant':
      return <AssistantNodeView node={node} mdStyle={mdStyle} onOpenFile={onOpenFile} />;
    case 'command':
      return <CommandNodeView node={node} />;
    case 'diff':
      return <DiffNodeView node={node} onOpenFile={onOpenFile} />;
    case 'system':
      return <SystemNodeView node={node} />;
    default:
      return null;
  }
}, nodeViewPropsEqual);

function ReasoningNodeView({ node }: { node: TimelineNode }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const preview = (node.text || '').split('\n').map((line) => line.trim()).find(Boolean) || '思考过程';
  return (
    <Pressable onPress={() => setOpen((v) => !v)} style={styles.systemWrap}>
      <Text style={[styles.cmdLine, { color: colors.muted }]} numberOfLines={open ? undefined : 1}>
        ⌥ {open ? '思考过程 ▴' : `思考过程 ▾  ${preview}`}
      </Text>
      {open ? (
        <Text selectable style={[styles.cmdDetail, { color: colors.muted }]}>{node.text}</Text>
      ) : null}
    </Pressable>
  );
}

function UserNodeView({ node, onReuse }: { node: TimelineNode; onReuse?: (text: string) => void }) {
  const { colors } = useTheme();
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
      {onReuse && text ? (
        <Pressable onPress={() => onReuse(text)} hitSlop={6} style={{ alignSelf: 'flex-end', paddingVertical: 4 }}>
          <Text style={{ color: colors.muted, fontSize: 11 }}>填入输入框</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function AssistantNodeView({
  node,
  mdStyle,
  onOpenFile,
}: {
  node: TimelineNode;
  mdStyle: Record<string, object>;
  onOpenFile: (path: string) => void;
}) {
  const { colors } = useTheme();
  const [assistantExpanded, setAssistantExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
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
      </Pressable>
      <View style={styles.assistantActionBar}>
        {isVeryLong ? (
          <Pressable
            onPress={() => setAssistantExpanded((v) => !v)}
            style={[styles.assistantActionChip, { backgroundColor: colors.shell, borderColor: colors.line }]}
            hitSlop={6}
          >
            <Text style={{ color: colors.muted, fontSize: 11.5, fontWeight: '500' }}>
              {assistantExpanded ? '˄ 收起长文' : '˅ 展开全文'}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[
            styles.assistantActionChip,
            { backgroundColor: colors.shell, borderColor: colors.line },
            copied && { backgroundColor: 'rgba(16, 185, 129, 0.1)', borderColor: 'rgba(16, 185, 129, 0.3)' },
          ]}
          onPress={() => {
            void Clipboard.setStringAsync(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          hitSlop={6}
        >
          <Text style={{ fontSize: 11.5, fontWeight: '500', color: copied ? '#10b981' : colors.muted }}>
            {copied ? '✓ 已复制' : '⎘ 复制'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function CommandNodeView({ node }: { node: TimelineNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.cmdGroup}>
      <Text style={[styles.cmdLine, { color: colors.muted }]} numberOfLines={1}>🔲  {node.text}</Text>
    </View>
  );
}

function SystemNodeView({ node }: { node: TimelineNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.systemWrap}>
      <Text style={{ color: colors.muted, fontSize: 12, textAlign: 'left' }}>{node.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, position: 'relative' },
  mainWrap: { flex: 1, width: '100%' },
  header: {
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    gap: 8,
  },
  headerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  headerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    flexShrink: 0,
  },
  headerIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadMoreBar: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    marginVertical: 6,
  },
  round: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
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
  dropdownWrap: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  dropdownBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  dropdownMenu: {
    position: 'absolute',
    top: 48,
    right: 12,
    width: 170,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  dropdownItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  dropdownDivider: {
    height: 1,
    marginVertical: 4,
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
  failedBubble: { borderWidth: 1 },
  failedMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  failedBtn: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
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
  assistantActionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 5,
    alignSelf: 'flex-start',
  },
  assistantActionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
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
    paddingHorizontal: 4,
    paddingTop: 2,
    gap: 4,
  },
  composerLeftScroll: { flex: 1, minWidth: 0 },
  composerLeft: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingRight: 4 },
  composerRight: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  toolBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  chipBtn: { paddingHorizontal: 5, paddingVertical: 4, borderRadius: 6 },
  modelPill: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 7, paddingVertical: 4, maxWidth: 120 },
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
