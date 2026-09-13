import { UnifiedDiffView } from '../components/UnifiedDiffView';
import { ThreadContinuity } from '../components/ThreadContinuity';
import { UserInputBar } from '../components/UserInputBar';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
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
import { TimelineContext, TimelineImage } from '../components/TimelineImage';
import { ApprovalBar } from '../components/ApprovalBar';
import { EmptyState, ErrorBanner, FeedbackBanner, FolderOutlineIcon } from '../components/ui';
import { approvalFromHistory, resultSummary, flattenItems, lockBannerKind, type FeedNode } from '../history';
import { localMessageItems } from '../local-messages';
import { turnAwareFeed, questionEntries, stepStatus } from '../utils/thread-ui';
import { HandshakePanel } from '../components/HandshakePanel';
import { isQuotaError, isQuotaExhausted, quotaExhaustedMessage, formatContextUsage, formatQuotaLine } from '../quota';
import { FilePanel } from './FilePanel';
import { FileIcon } from '../components/FileIcon';
import { WorkspaceSheet } from './WorkspaceSheet';
import { useHistories, useSession, useTools, useWorkspace } from '../session';
import { radius } from '../theme';
import { useTheme } from '../theme-context';
import { scopedDraftKey, canSubmitComposer, pendingFromComposerInput, writerLockErrorCode, type ComposerPending } from '../composer-draft';
import { FORCE_CLEAR_UNAVAILABLE } from '../api';
import { FORCE_CLEAR_WARNING, holderAliveConfirmText, planForceClearRetry } from '../force-clear-lock';
import { claimLegacyComposerDraft, removeComposerAttachment, loadCustomPrompts, saveCustomPrompts, loadComposerDraft, saveComposerDraft } from '../storage';
import { ACCESS_MODES, accessMeta, type FailedSend, type TimelineNode } from '../types';
import { triggerHaptic } from '../utils/haptics';
import { hubRawFileUrl, isLocalDiskRef, pathFromHref, stripFileUrl } from '../utils/localFileUrl';

const SHOW_REPLY_SUMMARY = false;

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
  pendingCreate,
  onBack,
  onOpenLeft,
  onOpenRight,
  onOpenFile,
  onScan,
  onOpenThread,
  hideSideButtons = false,
  showHandshake = true,
}: {
  threadId?: string;
  /** 正在创建中的新会话信息：新会话视图显示目标项目，发送首条消息时也落到该目录 */
  pendingCreate?: { cwd: string; projectName: string } | null;
  onBack?: () => void;
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onOpenFile: (path: string) => void;
  onScan: () => void;
  onOpenThread?: (id: string) => void;
  hideSideButtons?: boolean;
  showHandshake?: boolean;
}) {
  const session = useSession();
  const identityRef = useRef(session.connectionIdentity);
  identityRef.current = session.connectionIdentity;
  const [draftReady, setDraftReady] = useState(false);
  const {
    histories: historiesMap,
    approvals,
    loadingHistory: loadingHistoryMap,
    loadingOlder: loadingOlderMap,
    openThread,
    loadOlderHistory,
    sendApproval,
  } = useHistories();
  const tools = useTools();
  const workspace = useWorkspace();
  const { searchWorkspace, uploadTasks, removeUpload } = workspace;
  const { colors, showProcess } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const phone = screenW < 700;
  const draftKey = scopedDraftKey(threadId || '', session.draftNamespace);
  const activeDraftKeyRef = useRef(draftKey); activeDraftKeyRef.current = draftKey;
  const [legacyDraftAvailable, setLegacyDraftAvailable] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<ComposerPending[]>([]);
  const [unconfirmedDraft, setUnconfirmedDraft] = useState(false);
  const [kb, setKb] = useState(0);
  const [imeOpen, setImeOpen] = useState(false);
  const restHRef = useRef(screenH);
  const screenHRef = useRef(screenH);
  screenHRef.current = screenH;
  const [showHostPicker, setShowHostPicker] = useState(false);
  const [customPrompts, setCustomPrompts] = useState<string[]>([]);
  const [showPrompts, setShowPrompts] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const composingRef = useRef(false);
  useEffect(() => { void loadCustomPrompts().then(setCustomPrompts); }, []);
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

  function chooseSlash(item: typeof SLASH_ITEMS[number]) {
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
                  setDraft('/aux ');
                } else {
                  setDraft(item.cmd + ' ');
                }

  }
  useEffect(() => setSlashIndex(0), [slashQuery]);

  // 提取工作区文件扁平列表用于 @ 联想
  const allWorkspaceFiles = useMemo(() => {
    const list: string[] = [];
    function walk(nodes?: any[]) {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.type === 'file' && n.path) list.push(n.path);
        if (n.children) walk(n.children);
      }
    }
    if (workspace.tree?.tree) walk(workspace.tree.tree);
    return list;
  }, [workspace.tree?.tree]);

  const atMatch = draft.match(/(?:^|\s)@([^\s@]*)$/);
  const showAtMenu = Boolean(atMatch && threadId && !showSlash);
  const atQuery = atMatch ? atMatch[1].toLowerCase() : '';
  const filteredAtFiles = useMemo(() => {
    if (!showAtMenu) return [];
    const fromHits = (workspace.workspaceHits || []).map((hit) => hit.path).filter(Boolean);
    const merged = [...fromHits, ...allWorkspaceFiles.filter((f) => !atQuery || f.toLowerCase().includes(atQuery))];
    return [...new Set(merged)].slice(0, 12);
  }, [showAtMenu, allWorkspaceFiles, atQuery, workspace.workspaceHits]);

  const insertAtFile = (filePath: string) => {
    const replaced = draft.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
      const leading = match.startsWith(' ') ? ' ' : '';
      return `${leading}@${filePath} `;
    });
    setDraft(replaced);
  };
  const [searchQ, setSearchQ] = useState('');
  const [searched, setSearched] = useState(false);
  const [jumpNeedle, setJumpNeedle] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  const thread = session.threads.find((t) => t.id === threadId);
  const history = threadId ? historiesMap[threadId] : undefined;
  const loadingHistory = Boolean(threadId && loadingHistoryMap[threadId]);
  const loadingOlder = Boolean(threadId && loadingOlderMap[threadId]);
  const approval = threadId ? approvals[threadId] || approvalFromHistory(threadId, history) : null;

  const queuedMention = session.mention;
  const clearMention = session.clearMention;
  const sending = Boolean(threadId && session.outgoing?.threadId === threadId && session.outgoing.kind === 'message');
  const loadedDraftForRef = useRef<string | null>(null);
  const skipDraftPersistRef = useRef(false);
  const restoredFailRef = useRef('');
  const pendingCreateSendRef = useRef<{ text: string; pending: ComposerPending[]; input: unknown[] } | null>(null);
  const composerRef = useRef({ threadId, draftKey, draft, pending, sending: unconfirmedDraft });

  useEffect(() => {
    if (!queuedMention) return;
    const next = queuedMention;
    setPending((prev) => (prev.some((p) => p.path === next.path) ? prev : [...prev, { name: next.name, path: next.path, image: false }]));
    setDraft((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@${next.name} `);
    clearMention();
  }, [queuedMention, clearMention]);

  useEffect(() => {
    const id = threadId || '';
    const key = draftKey;
    setLegacyDraftAvailable(false);
    let cancelled = false;
    loadedDraftForRef.current = null; setDraftReady(false);
    skipDraftPersistRef.current = true;
    if (pendingCreateSendRef.current) {
      loadedDraftForRef.current = id; setDraftReady(true);
      skipDraftPersistRef.current = false;
      return undefined;
    }
    setDraft('');
    setPending([]);
    setUnconfirmedDraft(false);
    if (!id || !key) return undefined;
    void loadComposerDraft(key).then(async (saved) => {
      if (cancelled) return;
      if (saved) {
        setDraft(saved.text || '');
        setPending(saved.pending || []);
        setUnconfirmedDraft(Boolean(saved.sending));
      }
      if (!saved) {
        const legacy = await loadComposerDraft(id);
        if (cancelled) return;
        setLegacyDraftAvailable(Boolean(legacy));
      }
      loadedDraftForRef.current = id; setDraftReady(true);
      skipDraftPersistRef.current = false;
    });
    return () => {
      cancelled = true;
      const cur = composerRef.current;
      if (cur.threadId === id && loadedDraftForRef.current === id && !skipDraftPersistRef.current) {
        const text = cur.draft;
        const files = cur.pending;
        void saveComposerDraft(cur.draftKey, (text.trim() || files.length)
          ? { text, pending: files, sending: cur.sending, updatedAt: Date.now() }
          : null);
      }
    };
  }, [threadId, draftKey]);

  useEffect(() => {
    if (!threadId || !draftKey || loadedDraftForRef.current !== threadId || skipDraftPersistRef.current) return;
    // Commit the snapshot after the previous thread's cleanup, never during render.
    composerRef.current = { threadId, draftKey, draft, pending, sending: unconfirmedDraft };
    const timer = setTimeout(() => {
      void saveComposerDraft(draftKey, (draft.trim() || pending.length)
        ? { text: draft, pending, sending: unconfirmedDraft, updatedAt: Date.now() }
        : null);
    }, 250);
    return () => clearTimeout(timer);
  }, [threadId, draftKey, draft, pending, unconfirmedDraft]);

  const dismissComposerPopups = () => {
    const trimmed = draft.trim();
    if (trimmed === '/' || trimmed === '/mcp' || trimmed === '/compact' || trimmed === '/plan' || trimmed === '/review' || trimmed === '$') {
      setDraft('');
    }
    if (plus) setPlus(false);
    if (sheet === 'access' || sheet === 'model') setSheet('none');
  };

  const nodes = useMemo(
    () => flattenItems(localMessageItems(history, session.localMessages, threadId || '')).filter((n) => {
      if (n.important || ['user', 'assistant', 'diff', 'system', 'generated-image', 'image-view', 'search', 'compaction'].includes(n.kind)) return true;
      if (!showProcess) return false;
      return n.kind === 'command' || n.kind === 'agent' || n.kind === 'reasoning';
    }),
    [history, session.localMessages, threadId, showProcess],
  );
  const feed = useMemo(() => turnAwareFeed([...nodes, ...(history?.subagents || []).map(agent => ({ id: `agent-${agent.id}`, kind: 'agent' as const, text: agent.title || agent.id, threadId: agent.id, status: agent.status || 'unknown', model: agent.model }))]), [nodes, history?.subagents]);
  const summary = useMemo(() => resultSummary(history), [history]);
  const threadUploads = workspace.uploadTasks.filter(t => t.threadId === threadId);
  const uploadsPending = threadUploads.some(t => t.status !== 'success');
  const working = history?.status === 'working';
  const executionLocation = (threadId ? session.executionStates[threadId]?.location : undefined) || history?.executionLocation;
  const executionLabel = executionLocation === 'desktop' ? '桌面' : executionLocation === 'hub' ? 'Hub' : '未确认';
  const lockBanner = lockBannerKind(history?.lockHolder);
  const project = session.projects.find((p) => p.threads.some((t) => t.id === threadId));
  const failedForThread = useMemo(
    () => (threadId ? session.failedSends.filter((item) => item.threadId === threadId) : []),
    [session.failedSends, threadId],
  );

  const [elapsedSec, setElapsedSec] = useState(0);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const startTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (working) {
      if (startTsRef.current === null) {
        startTsRef.current = Date.now();
        setElapsedSec(0);
        setLastDuration(null);
      }
      const timer = setInterval(() => {
        if (startTsRef.current) {
          setElapsedSec(Math.max(1, Math.floor((Date.now() - startTsRef.current) / 1000)));
        }
      }, 1000);
      return () => clearInterval(timer);
    } else {
      if (startTsRef.current) {
        const dur = Math.max(1, Math.round((Date.now() - startTsRef.current) / 1000));
        setLastDuration(dur);
        startTsRef.current = null;
      }
    }
  }, [working]);

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  useEffect(() => {
    if (!threadId) return;
    const fail = failedForThread[failedForThread.length - 1];
    if (!fail || restoredFailRef.current === fail.id) return;
    if (draft.trim() || pending.length) return;
    restoredFailRef.current = fail.id;
    setDraft(fail.text || '');
    setPending(pendingFromComposerInput(fail.input));
  }, [failedForThread, draft, pending, threadId]);

  useEffect(() => {
    if (threadId) openThread(threadId);
  }, [threadId, openThread]);

  useEffect(() => {
    const pendingSend = pendingCreateSendRef.current;
    if (!pendingSend || !threadId || session.lastCreatedId !== threadId) return;
    pendingCreateSendRef.current = null;
    setDraft(pendingSend.text); setPending(pendingSend.pending);
    setUnconfirmedDraft(false); // Creating/reconnecting never executes a saved draft.
  }, [threadId, session.lastCreatedId, session.sendComposer]);

  useEffect(() => {
    if (!showAtMenu || !threadId || atQuery.length < 1) return;
    const cwd = history?.cwd || project?.cwd || '';
    const timer = setTimeout(() => searchWorkspace(threadId, cwd, atQuery), 180);
    return () => clearTimeout(timer);
  }, [showAtMenu, atQuery, threadId, history?.cwd, project?.cwd, searchWorkspace]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const keyboardEvent = e as unknown as globalThis.KeyboardEvent;
      if (keyboardEvent.key === 'Escape') {
        if (sheet !== 'none') setSheet('none');
        if (plus) setPlus(false);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown as any);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown as any);
  }, [sheet, plus]);

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
    if (!threadId || loadedDraftForRef.current !== threadId) return;
    for (const task of uploadTasks) {
      if (task.threadId !== threadId || task.status !== 'success' || !task.path) continue;
      const path = task.path;
      setPending(prev => prev.some(p => p.path === path) ? prev : [...prev, { name: task.name, path, image: task.image, source: 'device', taskId: task.taskId }]);
      removeUpload(task.taskId);
    }
  }, [uploadTasks, removeUpload, threadId, draftReady]);

  async function readAndUpload(id: string, asset: { name: string; uri: string; mime?: string; base64?: string | null }) {
    const taskId = workspace.beginUpload(id, asset.name, (asset.mime || '').startsWith('image/'));
    try {
      const b64 = asset.base64 || await new File(asset.uri).base64();
      if (!b64) throw new Error('文件内容为空');
      workspace.uploadFile(id, asset.name, b64, asset.mime, taskId);
    } catch (err) { workspace.failUpload(taskId, err instanceof Error ? err.message : '读取失败，请重新选择'); }
  }
  async function pickPhoto(fromCamera: boolean) {
    const id = threadId; const identity = identityRef.current; if (!id) return;
    try {
      const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('无法附加图片', '请在系统设置中允许相机或相册权限'); return; }
      const res = fromCamera ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true }) : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true, allowsMultipleSelection: true });
      if (res.canceled || identityRef.current !== identity) return;
      setPlus(false);
      await Promise.all(res.assets.map(asset => readAndUpload(id, { name: asset.fileName || `photo-${Date.now()}.jpg`, uri: asset.uri, mime: asset.mimeType || 'image/jpeg', base64: asset.base64 })));
    } catch (err) { Alert.alert('选择失败', err instanceof Error ? err.message : '无法打开图片选择器'); }
  }
  async function pickFile() {
    const id = threadId; const identity = identityRef.current; if (!id) return;
    try {
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
      if (res.canceled || identityRef.current !== identity) return;
      setPlus(false);
      await Promise.all(res.assets.map(asset => readAndUpload(id, { name: asset.name || 'file', uri: asset.uri, mime: asset.mimeType })));
    } catch (err) { Alert.alert('选择失败', err instanceof Error ? err.message : '无法打开文件选择器'); }
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

  function persistSendingThenClear() {
    // Automatic failure recovery leaves its card available. A deliberate resend
    // of that exact restored draft replaces it; equal text alone is not identity.
    const restored = failedForThread.find(row => row.id === restoredFailRef.current);
    if (restored?.deliveryStatus === 'failed' && restored.text === draft.trim()
      && JSON.stringify(pendingFromComposerInput(restored.input)) === JSON.stringify(pending)) {
      session.dismissFailedSend(restored.id);
      restoredFailRef.current = '';
    }
    skipDraftPersistRef.current = true;
    if (threadId) {
      void saveComposerDraft(draftKey, (draft.trim() || pending.length)
        ? { text: draft, pending, sending: true, updatedAt: Date.now() }
        : null);
    }
    setDraft('');
    setPending([]);
    setUnconfirmedDraft(false);
    setTimeout(() => { skipDraftPersistRef.current = false; }, 0);
  }

  function send() {
    if (!canSubmitComposer({ connected: session.conn === 'connected', composing: composingRef.current, sending, uploading: uploadsPending, approval: Boolean(approval), quotaExhausted: isQuotaExhausted(session.quota) })) return;
    const text = draft.trim();
    if (!text && !pending.length) return;
    if (!threadId) {
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
      pendingCreateSendRef.current = { text, pending, input };
      persistSendingThenClear();
      // 新会话视图的首条消息要落到正在创建的项目目录，而不是列表里的第一个项目
      session.createThread(pendingCreate?.cwd ?? session.projects[0]?.cwd);
      return;
    }
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
      if (tools.runCommand(threadId, text.slice(2))) persistSendingThenClear();
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
      if (session.sendComposer(threadId, text, false)) persistSendingThenClear();
      return;
    }
    if (isQuotaExhausted(session.quota)) return;
    if (approval) {
      session.clearError();
      Alert.alert('请先处理审批', '输入框可以先打下一句，批准或拒绝后再发送。');
      return;
    }
    if (working) {
      setSheet('steer');
      return;
    }
    if (session.sendComposer(threadId, text, false, input)) {
      triggerHaptic('light');
      persistSendingThenClear();
    }
  }

  function confirmSteer() {
    if (!threadId || session.conn !== 'connected' || uploadsPending || sending || approval) return;
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
      persistSendingThenClear();
      setSheet('none');
    }
  }

  function discardSteer() {
    skipDraftPersistRef.current = true;
    setDraft('');
    setPending([]);
    if (threadId) void saveComposerDraft(draftKey, null);
    setSheet('none');
    setTimeout(() => { skipDraftPersistRef.current = false; }, 0);
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
    setPending(pendingFromComposerInput(item.input));
    dismissFailedSend(item.id);
  }, [dismissFailedSend]);
  // 直接删除失败卡片：仅移除记录，不重试、不恢复草稿、无确认弹窗。
  const handleDismissFailed = useCallback((id: string) => dismissFailedSend(id), [dismissFailedSend]);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingBottom: kb > 0 ? kb : insets.bottom + 8 }]}>
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
                {session.conn === 'connected' ? (working ? `运行中 · ${formatTimer(elapsedSec)}` : (lastDuration ? `已就绪 (${lastDuration}s)` : '已就绪')) : '离线'}
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

      <Pressable accessibilityRole="button" accessibilityLabel="查看项目与执行状态" onPress={() => setSheet('status')} style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 12 }}>{project?.name || pendingCreate?.projectName || thread?.projectName || '未分组项目'} · 分支：{(tools.git?.threadId === threadId ? tools.git?.branch : undefined) || history?.branch || '未提供'} · 执行：{executionLabel}</Text>
        <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 11 }}>{history?.cwd || project?.cwd || thread?.cwd || pendingCreate?.cwd || '工作目录未提供'} · 宿主机：{session.hostName || '未知'}</Text>
      </Pressable>
      {showHandshake && session.handshake.active ? (
        <HandshakePanel
          handshake={session.handshake}
          onRetry={session.conn === 'idle' && session.mode === 'relay' ? onScan : session.reconnect}
          retryLabel={session.handshake.phase === 'offline' ? '再试一次' : (session.conn === 'idle' && session.mode === 'relay' ? (Platform.OS === 'web' ? '重新配对' : '扫出门码') : '重新连接')}
        />
      ) : null}
      {lockBanner === 'desktop' ? (
        <Text style={{ marginHorizontal: 16, marginBottom: 8, color: '#92400e', fontSize: 12 }}>
          桌面在线持锁：发送将转交桌面；正在生成时可发送纠偏消息或等待。
        </Text>
      ) : lockBanner === 'desktop-stale' ? (
        <Text style={{ marginHorizontal: 16, marginBottom: 8, color: '#b45309', fontSize: 12 }}>
          桌面持锁疑似过期或不可达：发送将由 Hub 尝试接管；若仍失败，可在发送失败消息上用「强制删锁」兜底。
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
      <ErrorBanner text={session.error} onClose={session.clearError} />
      <FeedbackBanner text={session.feedback} onClose={session.clearFeedback} />
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

      {SHOW_REPLY_SUMMARY && (summary.reply || summary.status === '执行异常') ? (
        <View style={{ marginHorizontal: 16, padding: 10, backgroundColor: colors.shell, borderRadius: 8 }}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>{summary.status}</Text>
          {summary.reply ? <Text selectable numberOfLines={3} style={{ color: colors.text, fontSize: 13 }}>{summary.reply}</Text> : null}
          <Text style={{ color: colors.muted, fontSize: 11 }}>文件变更或产物请在工作区核对；未验证执行成功。</Text>
        </View>
      ) : null}
      {session.requestState('get_thread_history', threadId)?.error ? <Pressable onPress={() => { if (threadId) openThread(threadId); }} style={{ padding: 12 }}><Text style={{ color: colors.danger }}>{session.requestState('get_thread_history', threadId)?.error} · 点击重试</Text></Pressable> : null}
      <TimelineContext.Provider value={{ threadId: threadId || '', cwd: history?.cwd || '', onOpenThread }}>
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
        onDeleteFailed={handleDismissFailed}
        jumpNeedle={jumpNeedle}
        loading={loadingHistory}
        emptyTitle={loadingHistory ? '正在加载消息' : threadId ? '还没有消息' : pendingCreate ? `新对话 · ${pendingCreate.projectName || '默认目录'}（创建中）` : '选择或新建会话'}
        emptyDetail={loadingHistory ? '内容较多时可能要等几秒' : threadId ? `在「${project?.name || '当前项目'}」发第一句` : pendingCreate ? `正在「${pendingCreate.projectName || '默认目录'}」创建会话，建好自动进入；现在就能输入，首条消息保留为草稿，请确认后发送` : undefined}
      />

      </TimelineContext.Provider>
      {history?.subagents?.length ? <ScrollView horizontal style={{ maxHeight: 48 }} contentContainerStyle={{ padding: 8, gap: 12 }}>{history.subagents.map(agent => <Pressable key={agent.id} disabled={!onOpenThread} onPress={() => onOpenThread?.(agent.id)}><Text style={{ color: colors.muted }}>{agent.title || agent.id} · {agent.status || 'unknown'}{agent.model ? ` · ${agent.model}` : ''}</Text></Pressable>)}</ScrollView> : null}
      {Object.values(session.userInputs).filter(request => request.threadId === threadId).map(request => <UserInputBar key={`${session.connectionIdentity}:${request.threadId}:${request.requestId}`} request={request} />)}
      {approval && threadId ? (
        <View style={styles.pad}>
          <ApprovalBar approval={approval} lockHolder={history?.lockHolder} onDecide={(d) => sendApproval(threadId, d)} />
        </View>
      ) : null}

      {threadId ? <ThreadContinuity key={`${session.connectionIdentity}:${threadId}`} threadId={threadId} text={draft} attachments={pending} canQueue={!sending && !uploadsPending && !approval && !isQuotaExhausted(session.quota)} onAdopt={(text, attachments) => { setDraft(text); setPending(attachments); setUnconfirmedDraft(false); }} /> : null}

      {/* Floating Active Action / Working Capsule */}
      {working ? (
        <View style={styles.floatingCapsuleWrap}>
          <View style={[styles.capsuleInner, { backgroundColor: colors.shell, borderColor: colors.line }]}>
            <ActivityIndicator size="small" color={colors.text} style={{ transform: [{ scale: 0.75 }] }} />
            <Text style={[styles.capsuleText, { color: colors.text }]} numberOfLines={1}>
              {history?.activeActionText ? `正在执行: ${history.activeActionText}` : 'Codex 正在运行…'} · {formatTimer(elapsedSec)}
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
              onChangeText={(v) => { setSearchQ(v); setSearched(false); }}
              placeholder="关键词"
              placeholderTextColor={colors.muted}
              style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, color: colors.text }}
              onSubmitEditing={() => tools.searchThread(threadId, searchQ)}
            />
            <Pressable style={{ marginTop: 10, alignSelf: 'flex-end' }} onPress={() => { setSearched(true); tools.searchThread(threadId, searchQ); }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>搜索</Text>
            </Pressable>
            {session.requestState('search_thread', threadId)?.status === 'loading' ? <Text style={{ color: colors.muted }}>搜索中…</Text> : null}
            {session.requestState('search_thread', threadId)?.error ? <Text style={{ color: colors.danger }}>{session.requestState('search_thread', threadId)?.error}</Text> : null}
            {searched && session.requestState('search_thread', threadId)?.status === 'success' && searchQ.trim() && !tools.searchHits.length ? (
              <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>没有匹配</Text>
            ) : null}
            {tools.searchHits.map((hit, i) => (
              <Pressable
                key={`${hit.index}-${i}`}
                onPress={() => {
                  if (history?.hasMore) loadOlderHistory(threadId);
                  setJumpNeedle(hit.snippet.replace(/^…/, '').replace(/…$/, '').slice(0, 48));
                  setSheet('none');
                }}
              >
                <Text selectable style={{ color: colors.text, fontSize: 12, marginTop: 8, lineHeight: 18 }}>
                  {hit.type ? `${hit.type} · ` : ''}{hit.snippet}
                </Text>
              </Pressable>
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
          <Pressable style={styles.plusItem} onPress={() => { setShowHostPicker(true); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>从宿主机选择文件</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { setShowPrompts(true); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>常用 / 自定义提示词（仅填入）</Text>
          </Pressable>
          {Platform.OS === 'web' ? null : (
            <Pressable style={styles.plusItem} onPress={() => { void pickPhoto(true); }}>
              <Text style={{ color: colors.text, fontSize: 15 }}>📷 拍照附加</Text>
            </Pressable>
          )}
          <Pressable style={styles.plusItem} onPress={() => { void pickPhoto(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🖼️ 上传图片</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { void pickFile(); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>从当前设备上传文件</Text>
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
              <Text style={{ color: colors.text, fontSize: 15 }}>{phone ? '🌿 工作区 / Git / 终端' : '🌿 查看 Git 状态'}</Text>
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
                const on = session.config.accessMode === id;
            const desc = meta.hint;
            return (
              <Pressable
                key={id}
                unstable_pressDelay={0}
                style={[styles.plusItem, on && { backgroundColor: colors.shell }]}
                disabled={session.conn !== 'connected'}
                accessibilityState={{ selected: on, disabled: session.conn !== 'connected' }}
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
          <Text style={{ color: colors.muted, fontSize: 11, paddingHorizontal: 14 }}>服务端回执仅确认已保存 Hub 全局配置；Hub 新轮次按支持字段提交，桌面接续 / 当前轮次由执行端决定。速度保存不代表 serviceTier 已生效。</Text>
          <ScrollView style={{ maxHeight: Math.round(Dimensions.get('window').height * 0.35) }}>
            {session.models.map((m) => {
              const on = modelId === m.id;
              return (
                <Pressable
                  key={m.id}
                  unstable_pressDelay={0}
                  style={[styles.plusItem, on && { backgroundColor: colors.shell }]}
                  disabled={session.conn !== 'connected'}
                  accessibilityState={{ selected: on, disabled: session.conn !== 'connected' }}
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
                      disabled={session.conn !== 'connected'}
                      accessibilityState={{ selected: on, disabled: session.conn !== 'connected' }}
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
                    disabled={session.conn !== 'connected'}
                    accessibilityState={{ selected: on, disabled: session.conn !== 'connected' }}
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

      {/* Slash command menu (live filter when typing /) - 与 Codex 保持一致 */}
      {showSlash && filteredSlash.length > 0 ? (
        <View style={[styles.slashMenu, { backgroundColor: colors.bg, borderColor: colors.line, maxHeight: phone ? Math.round(screenH * 0.36) : 240 }]}>
          <ScrollView keyboardShouldPersistTaps="handled">
          {filteredSlash.map((item, idx) => (
            <Pressable
              key={idx}
              style={[styles.plusItem, idx === slashIndex && { backgroundColor: colors.shell }]}
              onPress={() => chooseSlash(item)}
            >
              <Text style={{ color: colors.text, fontSize: 15 }}>
                {item.cmd} <Text style={{ color: colors.muted }}>{item.desc}</Text>
              </Text>
            </Pressable>
          ))}
          </ScrollView>
        </View>
      ) : null}

      {/* @ File Mention Menu (Live fuzzy search when typing @) */}
      {showAtMenu && filteredAtFiles.length > 0 ? (
        <View style={[styles.slashMenu, { backgroundColor: colors.bg, borderColor: colors.line, maxHeight: phone ? Math.round(screenH * 0.36) : 240 }]}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }}>
              <Text style={{ fontSize: 11, color: colors.muted, fontWeight: '600' }}>提及文件上下文 (@)</Text>
            </View>
            {filteredAtFiles.map((filePath, idx) => {
              const fileName = filePath.split(/[\\/]/).pop() || filePath;
              return (
                <Pressable
                  key={idx}
                  style={styles.plusItem}
                  onPress={() => insertAtFile(filePath)}
                >
                  <Text style={{ color: colors.text, fontSize: 14 }}>
                    📄 {fileName} <Text style={{ color: colors.muted, fontSize: 11 }}>{filePath}</Text>
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {showHostPicker && threadId ? (
        <View style={[StyleSheet.absoluteFillObject, { zIndex: 50, backgroundColor: colors.bg }]}>
          <Pressable onPress={() => setShowHostPicker(false)} style={{ padding: 16 }}><Text style={{ color: colors.text }}>取消选择</Text></Pressable>
          <FilePanel threadId={threadId} onOpenFile={onOpenFile}
            onSelectFiles={files => {
              setPending(prev => [...prev, ...files.filter(file => !file.isDir && !prev.some(p => p.path === file.path)).map(file => ({ name: file.name, path: file.path, image: false, source: 'host' as const }))]);
              setShowHostPicker(false);
            }} />
        </View>
      ) : null}
      {showPrompts ? (
        <View style={[styles.popoverMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <View style={styles.popoverHeader}>
            <Text style={{ color: colors.text }}>提示词 · 点击仅填入，不执行</Text>
            <Pressable onPress={() => setShowPrompts(false)}><Text style={{ color: colors.text }}>关闭</Text></Pressable>
          </View>
          <ScrollView style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
            {['请总结当前进度、已验证结果和未解决问题。', '先分析问题并提出计划，暂时不要修改文件。', '请审查当前改动，重点检查回归与安全问题。', ...customPrompts].map((prompt, i) => (
              <View key={`${i}-${prompt}`} style={styles.plusItem}>
                <Pressable onPress={() => { setDraft(prompt); setShowPrompts(false); }}><Text style={{ color: colors.text }}>{prompt}</Text></Pressable>
                {i >= 3 ? <Pressable onPress={() => { const next = customPrompts.filter((_, n) => n !== i - 3); setCustomPrompts(next); void saveCustomPrompts(next); }}><Text style={{ color: colors.muted }}>移除</Text></Pressable> : null}
              </View>
            ))}
            <Pressable style={styles.plusItem} onPress={() => { if (!draft.trim()) return; const next = [...new Set([...customPrompts, draft.trim()])].slice(0, 20); setCustomPrompts(next); void saveCustomPrompts(next); }}>
              <Text style={{ color: colors.text }}>将当前输入保存为自定义提示词</Text>
            </Pressable>
          </ScrollView>
        </View>
      ) : null}
      <View style={styles.composerWrap}>
        {legacyDraftAvailable && threadId && draftKey ? <Pressable onPress={() => {
          const identity = identityRef.current;
          void claimLegacyComposerDraft(threadId, draftKey).then(saved => {
            if (identity !== identityRef.current || activeDraftKeyRef.current !== draftKey) return;
            setLegacyDraftAvailable(false);
            if (saved) { setDraft(saved.text); setPending(saved.pending); setUnconfirmedDraft(Boolean(saved.sending)); }
          }).catch(() => Alert.alert('导入失败', '旧草稿仍保留，请重试'));
        }} style={{ padding: 8 }}><Text style={{ color: colors.text }}>发现未分宿主机的旧草稿 · 明确认领到当前宿主机（仅导入一次）</Text></Pressable> : null}

        {threadUploads.filter(t => t.status !== 'success').map(task => (
          <View key={task.taskId} style={{ padding: 8, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <FileIcon name={task.name} size={18} />
            <Text style={{ color: colors.text, flex: 1 }} numberOfLines={2}>{task.name} · 当前设备 · {task.status === 'reading' ? '读取中' : task.status === 'uploading' ? '上传中' : task.error}</Text>
            {task.status === 'error' ? <Pressable onPress={() => workspace.retryUpload(task.taskId)}><Text style={{ color: colors.text }}>重试</Text></Pressable> : <ActivityIndicator size="small" />}
            <Pressable onPress={() => workspace.removeUpload(task.taskId)}><Text style={{ color: colors.muted }}>移除</Text></Pressable>
          </View>
        ))}

        {sending ? (
          <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 4, paddingBottom: 6 }}>正在发送… 失败会把原文放回输入框</Text>
        ) : unconfirmedDraft ? (
          <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 4, paddingBottom: 6 }}>上次发送未确认，已放回输入框</Text>
        ) : null}
        <View style={[styles.inputCard, { backgroundColor: colors.bg, borderColor: isInputFocused ? colors.text : colors.line, borderWidth: 1 }]}>
          {pending.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingBar}>
              {pending.map((p, idx) => {
                const isImg = Boolean(p.image && p.path);
                const imgSrc = isImg ? (p.path.startsWith('file:') || p.path.startsWith('http') || p.path.startsWith('data:') ? p.path : `file://${p.path}`) : '';
                return (
                  <View key={`${p.path}-${idx}`} style={[styles.pendingChip, { backgroundColor: colors.card, borderColor: colors.line }]}>
                    {isImg ? (
                      <Image source={{ uri: imgSrc }} style={{ width: 28, height: 28, borderRadius: 4, marginRight: 4 }} />
                    ) : (
                      <FileIcon name={p.name} size={18} />
                    )}
                    <Text style={[styles.pendingName, { color: colors.text }]} numberOfLines={1}>{p.name} · {p.source === 'device' ? '当前设备' : p.skill ? 'Skill' : '宿主机'}</Text>
                    <Pressable
                      onPress={() => { if (p.taskId && threadId) void removeComposerAttachment(draftKey, p.taskId).catch(() => Alert.alert('保存失败', '附件移除未保存，请重试')); setPending((prev) => prev.filter((_, i) => i !== idx)); }}
                      hitSlop={8}
                      style={styles.pendingRemove}
                    >
                      <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '700' }}>✕</Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          ) : null}
          <TextInput
            value={draft}
            onChangeText={(text) => {
              setUnconfirmedDraft(false);
              setDraft(text);
            }}
            placeholder={
              session.conn === 'hub_offline'
                ? '电脑醒了才能发'
                : isQuotaExhausted(session.quota)
                  ? `额度用完，${resetText} 重置后再试`
                  : (session.hostName ? `在 ${session.hostName} 上…` : (threadId ? '随心输入' : '先开一个会话'))
            }
            placeholderTextColor={colors.muted}
            style={[
              styles.input,
              { color: colors.text, minHeight: 36, maxHeight: 110 },
              webNoOutline,
            ]}
            multiline
            editable={true}
            underlineColorAndroid="transparent"
            onPressIn={dismissComposerPopups}
            onFocus={() => {
              dismissComposerPopups();
              setIsInputFocused(true);
            }}
            onBlur={() => setIsInputFocused(false)}
            {...(Platform.OS === 'web' ? {
              onCompositionStart: () => { composingRef.current = true; },
              onCompositionEnd: () => { composingRef.current = false; },
              onKeyDown: (e: any) => {
                if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || composingRef.current) return;
                if (showSlash && filteredSlash.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
                  e.preventDefault?.();
                  if (e.key === 'ArrowDown') setSlashIndex(i => (i + 1) % filteredSlash.length);
                  else if (e.key === 'ArrowUp') setSlashIndex(i => (i - 1 + filteredSlash.length) % filteredSlash.length);
                  else chooseSlash(filteredSlash[Math.min(slashIndex, filteredSlash.length - 1)]);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault?.();
                  send();
                } else if (e.key === 'Escape') {
                  dismissComposerPopups();
                }
              }
            } as any : {})}
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
                  style={({ pressed }) => [styles.send, { backgroundColor: colors.danger }, pressed && { opacity: 0.75, transform: [{ scale: 0.94 }] }, webNoOutline]}
                  onPress={() => {
                    triggerHaptic('medium');
                    session.sendStop(threadId);
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>停</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={({ pressed }) => [
                  styles.send,
                  { backgroundColor: colors.send, opacity: (draft.trim() || pending.length) && session.conn === 'connected' && !isQuotaExhausted(session.quota) ? 1 : 0.35 },
                  pressed && { opacity: 0.75, transform: [{ scale: 0.94 }] },
                  webNoOutline,
                ]}
                disabled={session.conn !== 'connected' || sending || uploadsPending || Boolean(approval) || isQuotaExhausted(session.quota)}
                accessibilityLabel="发送消息"
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
          onOpenFile={(path) => onOpenFile(path)}
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
  onDeleteFailed,
  jumpNeedle,
  loading,
  emptyTitle,
  emptyDetail,
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
  onDeleteFailed: (id: string) => void;
  jumpNeedle?: string;
  loading?: boolean;
  emptyTitle: string;
  emptyDetail?: string;
}) {
  const { colors } = useTheme();
  const listRef = useRef<FlatList<FeedNode>>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [showQuestions, setShowQuestions] = useState(false);
  const [questionJump, setQuestionJump] = useState<{ id: string; nonce: number } | null>(null);
  const questions = useMemo(() => questionEntries(feed), [feed]);
  const pendingScrollIndex = useRef<number | null>(null);
  const appliedQuestionJump = useRef<object | null>(null);
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
    setShowQuestions(false);
    setQuestionJump(null);
    pendingScrollIndex.current = null;
  }, [threadId]);

  useEffect(() => {
    if (!questionJump || appliedQuestionJump.current === questionJump) return;
    const index = feed.findIndex(item => item.id === questionJump.id);
    if (index < 0) return;
    appliedQuestionJump.current = questionJump;
    skipStickToBottomRef.current = true;
    isNearBottomRef.current = false;
    setHiddenCount(0);
    pendingScrollIndex.current = index;
    requestAnimationFrame(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.1 }));
  }, [questionJump, feed]);

  useEffect(() => {
    const needle = String(jumpNeedle || '').trim();
    if (!needle || !feed.length) return;
    const idx = feed.findIndex((item) => {
      if ('text' in item && typeof item.text === 'string' && item.text.includes(needle)) return true;
      if (item.kind === 'cmd-group') return item.commands.some((c) => (c.text || c.command || '').includes(needle));
      return false;
    });
    if (idx < 0) return;
    skipStickToBottomRef.current = true;
    setHiddenCount(0);
    requestAnimationFrame(() => {
      try {
        listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.2 });
      } catch {
        /* ignore */
      }
    });
  }, [jumpNeedle, feed]);

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
    <View style={{ flex: 1 }}>
      {questions.length ? <View style={{ paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showQuestions }} onPress={() => setShowQuestions(value => !value)}><Text style={{ color: colors.text }}>问题导航 · {questions.length}{hasMore ? '（已加载）' : ''}</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => { setQuestionJump(null); isNearBottomRef.current = true; skipStickToBottomRef.current = false; listRef.current?.scrollToEnd({ animated: true }); }}><Text style={{ color: colors.muted }}>回到最新</Text></Pressable>
        </View>
        {showQuestions ? <ScrollView style={{ maxHeight: 190 }} keyboardShouldPersistTaps="handled">
          {questions.map((question, index) => <Pressable key={question.id} accessibilityRole="button" onPress={() => { setQuestionJump({ id: question.id, nonce: Date.now() }); setShowQuestions(false); }} style={{ paddingVertical: 8 }}><Text numberOfLines={2} style={{ color: colors.text, fontSize: 12 }}>{index + 1}. {question.title}</Text></Pressable>)}
          {hasMore && threadId ? <Pressable disabled={loadingOlder} onPress={() => onLoadOlder(threadId)} style={{ paddingVertical: 8 }}><Text style={{ color: colors.muted }}>{loadingOlder ? '加载中…' : '加载更早问题'}</Text></Pressable> : null}
        </ScrollView> : null}
      </View> : null}
    <FlatList
      ref={listRef}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
        pendingScrollIndex.current = index;
      }}
      data={visibleFeed}
      extraData={`${loading ? 1 : 0}:${loadingOlder}:${hiddenCount}:${hasMore ? 1 : 0}`}
      keyExtractor={feedKeyExtractor}
      contentContainerStyle={[styles.feed, { paddingBottom: 28 }]}
      initialNumToRender={25}
      maxToRenderPerBatch={25}
      windowSize={11}
      ListEmptyComponent={<EmptyState title={emptyTitle} detail={emptyDetail} busy={loading} />}
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
        if (pendingScrollIndex.current !== null) {
          const index = pendingScrollIndex.current;
          pendingScrollIndex.current = null;
          requestAnimationFrame(() => listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.1 }));
        }
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
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      renderItem={renderFeedItem}
      ListFooterComponent={
        failed.length ? (
          <View style={{ gap: 6, paddingTop: 4 }}>
            {failed.map((item) => (
              <FailedSendView
                key={item.id}
                item={item}
                threadId={threadId}
                onRetry={() => onRetryFailed(item.id)}
                onRestore={() => onRestoreFailed(item)}
                onDelete={() => onDeleteFailed(item.id)}
              />
            ))}
          </View>
        ) : null
      }
    />
    </View>
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
            <Pressable style={[styles.diffBtn, { backgroundColor: colors.card }]} onPress={() => setExpanded((v) => !v)} hitSlop={6}>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '500' }}>{expanded ? '收起差异' : '查看差异'}</Text>
            </Pressable>
          ) : null}
          {node.path ? (
            <Pressable style={[styles.diffBtn, { backgroundColor: colors.card }]} onPress={() => node.path && onOpenFile(node.path)} hitSlop={6}>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '500' }}>打开文件</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {expanded && node.patch ? (
        <UnifiedDiffView patch={node.patch} />
      ) : null}
    </View>
  );
}

function nodeTextsEqual(a: TimelineNode[], b: TimelineNode[]): boolean {
  return a.length === b.length && a.every((n, i) => n.id === b[i].id && n.text === b[i].text && n.output === b[i].output && n.status === b[i].status && n.model === b[i].model && n.threadId === b[i].threadId && n.turnId === b[i].turnId && n.command === b[i].command);
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const isMulti = commands.length > 1;
  const states = [...new Set(commands.map(command => stepStatus(command.status)))].join(' / ');
  const turn = commands.find(command => command.turnId)?.turnId;
  const summary = `${isMulti ? `${commands.length} 个工具步骤` : commands[0]?.text || '工具步骤'} · ${states} · ${expanded ? '收起' : '详情'}`;

  const copyCommand = (cmdNode: TimelineNode) => {
    triggerHaptic('light');
    const content = cmdNode.command || cmdNode.output || cmdNode.text;
    void Clipboard.setStringAsync(content).then(() => {
      setCopiedId(cmdNode.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  return (
    <View style={styles.cmdGroup}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => onToggle(groupId)} style={{ flexDirection: 'row', alignItems: 'center', opacity: 0.88 }}>
        <Text style={[styles.cmdLine, { color: colors.muted, flex: 1 }]} numberOfLines={1}>
          □  {summary}
        </Text>
      </Pressable>
      {expanded ? <Text selectable style={{ color: colors.muted, fontSize: 11 }}>轮次：{turn || '未提供'} · 输出为有界预览，不代表完整日志</Text> : null}
      {expanded
        ? commands.map((c) => (
            <View key={`${groupId}-${c.id}`} style={{ paddingVertical: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[styles.cmdDetail, { color: colors.muted, opacity: 0.88, flex: 1 }]} numberOfLines={2}>
                  {stepStatus(c.status)} · {c.command || c.text}
                </Text>
                <Pressable
                  onPress={() => copyCommand(c)}
                  hitSlop={6}
                  style={{ paddingHorizontal: 6, paddingVertical: 2 }}
                >
                  <Text style={{ fontSize: 10.5, color: copiedId === c.id ? '#16a34a' : colors.muted }}>
                    {copiedId === c.id ? '✓ 已复制' : '⎘ 复制'}
                  </Text>
                </Pressable>
              </View>
              {c.output ? (
                <Text selectable style={[styles.cmdDetail, { color: colors.muted, opacity: 0.8 }]}>{c.output.slice(0, 4000)}</Text>
              ) : null}
            </View>
          ))
        : null}
    </View>
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
  const { onOpenThread } = React.useContext(TimelineContext);
  if (agents.some(agent => agent.threadId)) return <View style={styles.cmdGroup}>
    <Pressable onPress={() => onToggle(groupId)}><Text style={{ color: colors.muted }}>子智能体 · {agents.length} · {expanded ? '收起' : '展开'}</Text></Pressable>
    {(expanded || agents.length === 1) && agents.map(agent => <Pressable key={agent.id} disabled={!agent.threadId || !onOpenThread} onPress={() => agent.threadId && onOpenThread?.(agent.threadId)}><Text style={{ color: colors.text }}>{agent.text} · {agent.status || 'unknown'}{agent.model ? ` · ${agent.model}` : ''}</Text></Pressable>)}
  </View>;
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
  threadId,
  onRetry,
  onRestore,
  onDelete,
}: {
  item: FailedSend;
  threadId?: string;
  onRetry: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { colors } = useTheme();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [lockResult, setLockResult] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const uncertain = item.deliveryStatus === 'uncertain' || item.deliveryStatus === 'pending' || item.deliveryStatus === 'running';
  const bodyInTimeline = session.localMessages.some(row => row.id === item.id && row.threadId === item.threadId);
  const eligible = !uncertain && Boolean(writerLockErrorCode(threadId, item));
  const unavailable = session.mode !== 'lan' || !session.lanUrl;
  // Re-check the rendered thread and connection after a native confirmation resolves.
  const current = useRef({ threadId, eligible, unavailable, session });
  current.current = { threadId, eligible, unavailable, session };
  const clearLock = async () => {
    if (busyRef.current || !eligible || unavailable || !threadId) return;
    busyRef.current = true;
    setBusy(true);
    const askConfirm = (title: string, message: string, confirmLabel: string) => (Platform.OS === 'web'
      ? window.confirm(`${title}\n\n${message}`)
      : new Promise<boolean>((resolve) => Alert.alert(title, message, [
        { text: '取消', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) })));
    // Native confirm resolves late: re-check the thread and connection before each request.
    const stillValid = () => live.current && current.current.threadId === threadId
      && current.current.eligible && !current.current.unavailable
      && current.current.session.lanUrl === session.lanUrl
      && current.current.session.hubId === session.hubId;
    try {
      const confirmed = await askConfirm('强制删锁', FORCE_CLEAR_WARNING, '强制删锁');
      if (!confirmed || !stillValid()) return;
      setLockResult('');
      let cleared: boolean;
      try {
        cleared = await current.current.session.forceClearFailedSendLock(item.id, threadId);
      } catch (err) {
        // 契约：持锁端仍存活时 Hub 返回 409 holder_alive；先升级为第二次更强确认，确认后才携带 acknowledgeHolderAlive 重试一次。
        if (planForceClearRetry(err, false) !== 'confirm-holder-alive') throw err;
        const confirmedAgain = await askConfirm('桌面进程仍在运行', holderAliveConfirmText(err instanceof Error ? err.message : ''), '仍要强制删锁');
        if (!confirmedAgain || !stillValid()) return;
        cleared = await current.current.session.forceClearFailedSendLock(item.id, threadId, { acknowledgeHolderAlive: true });
      }
      if (live.current) setLockResult(`${cleared ? '锁文件已删除' : '锁文件不存在'}。未停止桌面任务，也不代表 writer 已释放；请确认桌面已停止后手动重试发送。`);
    } catch (err) {
      if (live.current) setLockResult(err instanceof Error ? err.message : '删锁失败，请检查连接后手动重试');
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <View style={styles.userWrap}>
      <View style={[styles.userBubble, styles.failedBubble, { backgroundColor: colors.user, borderColor: colors.danger }]}>
        {!bodyInTimeline ? <Text selectable style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}>
          {item.text || '(附件)'}
        </Text> : null}
        <View style={styles.failedMeta}>
          <Text style={{ color: colors.danger, fontSize: 12 }}>{uncertain ? '发送结果待确认' : '发送失败'}</Text>
          {uncertain ? <Pressable accessibilityRole="button" disabled={session.conn !== 'connected' || session.capabilities.query_command !== true} onPress={() => session.queryCommand(item.id)} style={[styles.failedBtn, { borderColor: colors.danger }]}><Text style={{ color: colors.danger, fontSize: 12 }}>查询原请求状态</Text></Pressable> : null}
          <Pressable disabled={busy || uncertain} onPress={onRetry} style={[styles.failedBtn, { borderColor: colors.danger, opacity: busy || uncertain ? 0.5 : 1 }]} hitSlop={6}>
            <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600' }}>重试</Text>
          </Pressable>
          <Pressable disabled={busy} onPress={onRestore} style={[styles.failedBtn, { borderColor: colors.danger, opacity: busy ? 0.5 : 1 }]} hitSlop={6}>
            <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600' }}>放回输入框</Text>
          </Pressable>
          {eligible ? (
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || unavailable, busy }}
              disabled={busy || unavailable} onPress={() => { void clearLock(); }}
              style={[styles.failedBtn, { borderColor: colors.danger, opacity: busy || unavailable ? 0.5 : 1 }]} hitSlop={6}>
              <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600' }}>{busy ? '处理中…' : '强制删锁'}</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} accessibilityLabel="删除这条发送失败记录"
            disabled={busy} onPress={onDelete}
            style={[styles.failedBtn, { borderColor: colors.danger, opacity: busy ? 0.5 : 1 }]} hitSlop={6}>
            <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600' }}>删除</Text>
          </Pressable>
        </View>
        {uncertain ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>宿主机可能已经接收。请查询原请求或刷新历史确认，勿重复发送；删除本记录不会取消执行。</Text> : null}
        {item.error ? <Text selectable style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>{item.error}</Text> : null}
        {eligible && unavailable ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>{FORCE_CLEAR_UNAVAILABLE}</Text> : null}
        {lockResult ? <Text selectable accessibilityLiveRegion="polite" style={{ color: colors.text, fontSize: 12, marginTop: 6 }}>{lockResult}</Text> : null}
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
    && x.del === y.del
    && x.output === y.output
    && JSON.stringify(x.attachments) === JSON.stringify(y.attachments)
    && x.deliveryStatus === y.deliveryStatus
    && x.status === y.status
    && x.important === y.important
    && JSON.stringify(x.images || []) === JSON.stringify(y.images || []);
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
    case 'generated-image':
    case 'image-view':
      return <View><Text>{node.text}</Text>{node.images?.map((image, index) => <TimelineImage key={index} source={image.path || image.uri || ''} onOpenFile={onOpenFile} />)}{node.important ? <CommandNodeView node={node} /> : null}</View>;
    case 'search':
      return <View><CommandNodeView node={node} />{node.searchResults?.map((result, index) => <Pressable key={`${result.url}-${index}`} onPress={() => { void Linking.openURL(result.url); }}><Text style={mdStyle.link}>{result.title}</Text></Pressable>)}</View>;
    case 'command':
      return <CommandNodeView node={node} />;
    case 'compaction':
      return <SystemNodeView node={node} />;
    case 'diff':
      return <DiffNodeView node={node} onOpenFile={onOpenFile} />;
    case 'system':
      return <SystemNodeView node={node} />;
    default:
      return null;
  }
}, nodeViewPropsEqual);

function CodeBlockView({ content, language }: { content: string; language?: string }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const lang = (language || '').trim().toUpperCase();

  const handleCopy = async () => {
    triggerHaptic('light');
    await Clipboard.setStringAsync(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <View style={[styles.codeBlockWrapper, { backgroundColor: colors.shell, borderColor: colors.line }]}>
      <View style={[styles.codeBlockHeader, { borderBottomColor: colors.line }]}>
        <View style={styles.codeBlockLangBadge}>
          <Text style={[styles.codeBlockLangText, { color: colors.muted }]}>{lang || 'CODE'}</Text>
        </View>
        <Pressable
          onPress={handleCopy}
          style={({ pressed }) => [
            styles.codeBlockCopyBtn,
            { backgroundColor: colors.card, borderColor: colors.line },
            pressed && { opacity: 0.7 },
          ]}
          hitSlop={8}
        >
          <Text style={{ fontSize: 11, color: copied ? '#10b981' : colors.text, fontWeight: '600' }}>
            {copied ? '✓ 已复制' : '⎘ 复制'}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.codeBlockScroll}>
        <Text
          selectable
          style={[
            styles.codeBlockContent,
            { color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
          ]}
        >
          {content}
        </Text>
      </ScrollView>
    </View>
  );
}

function ReasoningNodeView({ node }: { node: TimelineNode }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const preview = (node.text || '').split('\n').map((line) => line.trim()).find(Boolean) || '思考过程';

  const handleToggle = () => {
    triggerHaptic('light');
    setOpen((v) => !v);
  };

  return (
    <View style={[styles.reasoningCard, { backgroundColor: `${colors.shell}90`, borderColor: colors.line }]}>
      <Pressable onPress={handleToggle} style={styles.reasoningHeader}>
        <View style={styles.reasoningHeaderLeft}>
          <View style={[styles.reasoningDot, { backgroundColor: '#38bdf8' }]} />
          <Text style={[styles.reasoningTitle, { color: colors.text }]} numberOfLines={1}>
            {open ? '思考过程' : `思考过程 · ${preview}`}
          </Text>
        </View>
        <Text style={[styles.reasoningToggleText, { color: colors.muted }]}>{open ? '收起 ▴' : '展开 ▾'}</Text>
      </Pressable>
      {open ? (
        <View style={[styles.reasoningBody, { borderTopColor: colors.line }]}>
          <Text selectable style={[styles.reasoningContent, { color: colors.muted }]}>
            {node.text}
          </Text>
        </View>
      ) : null}
    </View>
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
        triggerHaptic('light');
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
        onLongPress={() => {
          triggerHaptic('medium');
          void Clipboard.setStringAsync(text);
        }}
        style={[styles.userBubble, { backgroundColor: bg, borderWidth: 1, borderColor: border }]}
      >
        <View style={!userExpanded && isLong ? { maxHeight: 110, overflow: 'hidden' } : undefined}>
          {node.images?.length ? (
            <View style={{ gap: 6, marginBottom: text && text !== '[图片]' ? 8 : 0 }}>
              {node.images.map((img, i) => (
                img.uri && /^(data:|https?:)/i.test(img.uri) ? (
                  <Image key={`${img.path || img.uri}-${i}`} source={{ uri: img.uri }} style={{ width: 180, height: 120, borderRadius: 8 }} resizeMode="cover" />
                ) : (
                  <Text key={`${img.path || img.name || i}`} style={{ color: ink, fontSize: 13, fontWeight: '600' }}>
                    🖼 {img.name || img.path || '图片'}
                  </Text>
                )
              ))}
            </View>
          ) : null}
          {node.attachments?.map((attachment, i) => (
            <Text key={`${attachment.path}-${i}`} selectable style={{ color: ink, fontSize: 13, marginBottom: 4 }} accessibilityLabel={`附件 ${attachment.name} ${attachment.path}`}>
              附件：{attachment.name} · {attachment.path}
            </Text>
          ))}
          {text && text !== '[图片]' ? (
            <Text selectable style={{ color: ink, fontSize: 15, lineHeight: 22 }}>
              {text}
            </Text>
          ) : null}
        </View>
        {isLong ? (
          <Pressable
            onPress={() => {
              triggerHaptic('light');
              setUserExpanded((v) => !v);
            }}
            style={styles.btnTogglePrompt}
            hitSlop={6}
          >
            <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600' }}>
              {userExpanded ? '收起 ˄（双击亦可折叠）' : '展开全文 ˅'}
            </Text>
          </Pressable>
        ) : null}
      </Pressable>
      {node.deliveryStatus && node.deliveryStatus !== 'succeeded' ? (
        <Text accessibilityLiveRegion="polite" style={{ color: node.deliveryStatus === 'failed' ? colors.danger : colors.muted, fontSize: 12, marginTop: 4 }}>
          {node.deliveryStatus === 'failed' ? '发送失败' : node.deliveryStatus === 'uncertain' ? '发送结果未知，正在核对' : '正在发送'}
        </Text>
      ) : null}
      {onReuse && text ? (
        <Pressable
          onPress={() => {
            triggerHaptic('light');
            onReuse(text);
          }}
          hitSlop={6}
          style={{ alignSelf: 'flex-end', paddingVertical: 4 }}
        >
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
        triggerHaptic('light');
        setAssistantExpanded((v) => !v);
      }
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  };

  const handleLinkPress = (url: string) => {
    if (!url) return false;
    if (isLocalDiskRef(url) || url.startsWith('/api/file')) {
      onOpenFile(pathFromHref(url));
      return false;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void Linking.openURL(url);
      return false;
    }
    onOpenFile(stripFileUrl(url));
    return false;
  };

  const markdownRules = useMemo(() => ({
    image: (markdownNode: any) => <TimelineImage key={markdownNode.key} source={String(markdownNode.attributes?.src || '')} onOpenFile={onOpenFile} />,
    fence: (markdownNode: any) => {
      return <CodeBlockView key={markdownNode.key} content={markdownNode.content} language={markdownNode.sourceInfo} />;
    },
    code_block: (markdownNode: any) => {
      return <CodeBlockView key={markdownNode.key} content={markdownNode.content} />;
    },
    code_inline: (markdownNode: any) => {
      return (
        <Text
          key={markdownNode.key}
          style={{
            backgroundColor: colors.card,
            color: colors.text,
            paddingHorizontal: 5,
            paddingVertical: 1,
            borderRadius: 4,
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            fontSize: 13.5,
          }}
        >
          {markdownNode.content}
        </Text>
      );
    },
    link: (markdownNode: any, children: any) => {
      const href = String(markdownNode?.attributes?.href || '');
      const local = isLocalDiskRef(href);
      const target = local ? hubRawFileUrl(href) : href;
      if (Platform.OS === 'web') {
        return (
          <a
            key={markdownNode.key}
            href={target}
            onClick={(event) => {
              if (!local && !href.startsWith('/api/file')) return;
              event.preventDefault();
              triggerHaptic('light');
              onOpenFile(pathFromHref(href));
            }}
            style={{ color: colors.text, fontWeight: '600', textDecoration: 'underline' }}
          >
            {children}
          </a>
        );
      }
      return (
        <Text
          key={markdownNode.key}
          style={{ color: colors.text, fontWeight: '600', textDecorationLine: 'underline' }}
          onPress={() => {
            triggerHaptic('light');
            if (local) onOpenFile(stripFileUrl(href));
            else void Linking.openURL(href);
          }}
        >
          {children}
        </Text>
      );
    },
    table: (markdownNode: any, children: any) => (
      <ScrollView
        key={markdownNode.key}
        horizontal
        showsHorizontalScrollIndicator={true}
        style={{ marginVertical: 6 }}
        contentContainerStyle={{ minWidth: '100%' }}
      >
        <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 6, overflow: 'hidden' }}>
          {children}
        </View>
      </ScrollView>
    ),
    tr: (markdownNode: any, children: any) => (
      <View
        key={markdownNode.key}
        style={{ flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }}
      >
        {children}
      </View>
    ),
    th: (markdownNode: any, children: any) => (
      <View
        key={markdownNode.key}
        style={{ minWidth: 70, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: colors.shell }}
      >
        <Text style={{ fontWeight: '600', color: colors.text, fontSize: 13 }}>{children}</Text>
      </View>
    ),
    td: (markdownNode: any, children: any) => (
      <View
        key={markdownNode.key}
        style={{ minWidth: 70, paddingHorizontal: 8, paddingVertical: 6 }}
      >
        <Text style={{ color: colors.text, fontSize: 13 }}>{children}</Text>
      </View>
    ),
  }), [colors, onOpenFile]);

  return (
    <View style={styles.assistantWrap}>
      <Pressable
        style={styles.assistant}
        onPress={handlePress}
        onLongPress={() => {
          triggerHaptic('medium');
          void Clipboard.setStringAsync(text);
        }}
      >
        <View style={!assistantExpanded && isVeryLong ? { maxHeight: 220, overflow: 'hidden' } : undefined}>
          <Markdown style={mdStyle} rules={markdownRules} onLinkPress={handleLinkPress}>{text}</Markdown>
        </View>
      </Pressable>
      <View style={styles.assistantActionBar}>
        {isVeryLong ? (
          <Pressable
            onPress={() => {
              triggerHaptic('light');
              setAssistantExpanded((v) => !v);
            }}
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
            triggerHaptic('light');
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
  const [open, setOpen] = useState(false);
  const detail = node.output || node.command || '';
  return (
    <Pressable onPress={() => { if (detail) setOpen((v) => !v); }} style={styles.cmdGroup}>
      <Text style={[styles.cmdLine, { color: node.important ? colors.danger : colors.muted }]} numberOfLines={node.important ? 3 : 1}>{node.text}{node.status ? ` · ${node.status}` : ''}{detail ? (open ? ' ▴' : ' ▾') : ''}</Text>
      {(open || node.important) && detail ? (
        <Text selectable style={[styles.cmdDetail, { color: colors.muted }]}>{detail.slice(0, 4000)}</Text>
      ) : null}
    </Pressable>
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
  failedMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 },
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
  codeBlockWrapper: {
    borderRadius: 10,
    borderWidth: 1,
    marginVertical: 6,
    overflow: 'hidden',
  },
  codeBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  codeBlockLangBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  codeBlockLangText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  codeBlockCopyBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeBlockScroll: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  codeBlockContent: {
    fontSize: 13,
    lineHeight: 19,
  },
  reasoningCard: {
    borderRadius: 10,
    borderWidth: 1,
    marginVertical: 4,
    overflow: 'hidden',
    alignSelf: 'stretch',
  },
  reasoningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  reasoningHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    marginRight: 8,
  },
  reasoningDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  reasoningTitle: {
    fontSize: 12.5,
    fontWeight: '600',
  },
  reasoningToggleText: {
    fontSize: 11.5,
    fontWeight: '500',
  },
  reasoningBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  reasoningContent: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
