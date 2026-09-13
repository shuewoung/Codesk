import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform } from 'react-native';
import { decodedBase64Size, forceClearThreadWriterLock, logoutLan, loginLan as postLanLogin, pairWithCode, revokeDevice, uploadLan, WS_UPLOAD_LIMIT } from './api';
import { REQUEST_REPLIES, requestKey, matchesRequest, legacyHistoryRequest, safeConnectionDiagnostic, type RequestState } from './request-state';
import { removeFailedSend, retryPayload } from './failed-sends';
import { createLocalMessage, reconcileLocalMessages, type LocalMessage } from './local-messages';
import type { CommandState, ExecutionState, QueuedMessage, DraftSyncState, RemoteDraft, UserInputRequest, UserInputAnswers } from './types';
import type { ComposerPending } from './composer-draft';
import { receiveDraft, validRemoteDraft } from './draft-sync';
import { loadComposerDraft, saveComposerDraft, migrateComposerDraftNamespace, loadPendingCommands, savePendingCommand, removePendingCommand } from './storage';
import { draftNamespace, legacyDraftNamespace, scopedDraftKey, writerLockErrorCode } from './composer-draft';
import { createSocketMaintenance, drainPending, transportIdentity, type PendingApp } from './session-transport';
import { canLanProbe, findColocatedHub, isLoopbackHost, normalizeHubUrl, pageHubUrl, probeHub } from './discover';
import { buildHandshake, handshakeHint, type HandshakePhase, type HandshakeView } from './handshake';
import { isQuotaExhausted, isQuotaError, quotaExhaustedMessage } from './quota';
import { anonymousBox, anonymousOpen, boxOpen, generateKeyPair, secretOpen, secretSeal } from './e2e';
import { getJpushRegistrationId } from './push';
import {
  approvalFromHistory,
  approvalFromMessage,
  collectApprovalIds,
  emptyHistory,
  mergeHistory,
  parseThreadList,
} from './history';
import {
  extractPairFromInput,
  nextBackoffMs,
  normalizeRelayUrl,
  toWsUrl,
  unwrapIncoming,
  wrapPing,
  wrapPong,
  type AppMessage,
  type Envelope,
} from './protocol';
import { removeComposerAttachment, appendComposerAttachment, clearComposerDraftIfSending, clearSession, loadDeviceKeys, loadIdSet, loadSession, saveDeviceKeys, saveIdSet, saveSession } from './storage';
import {
  applyConfigPatch,
  type UploadTask,
  type ArtifactRecord,
  type Approval,
  type ConnKind,
  type Decision,
  type FailedSend,
  type FileData,
  type HubConfig,
  type McpServerInfo,
  type PluginInfo,
  type ModelInfo,
  type Project,
  type SkillInfo,
  type Thread,
  type ThreadHistory,
  type TokenUsage,
  type TreeNode,
} from './types';

type OutgoingSend = Omit<FailedSend, 'error' | 'code'>;

function nextFailedId() {
  return `fail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function mergeTreeChildren(nodes: TreeNode[], dirPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === dirPath) return { ...node, children, hasChildren: children.length > 0 || node.hasChildren };
    if (node.children?.length) return { ...node, children: mergeTreeChildren(node.children, dirPath, children) };
    return node;
  });
}

function isComposerFeedback(msg: AppMessage, last: OutgoingSend | null) {
  if (!last) return false;
  if (msg.requestId && msg.requestId !== last.id) return false;
  const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
  if (threadId && threadId !== last.threadId) return false;
  const action = typeof msg.action === 'string' ? msg.action : '';
  if (action === 'send' || action === 'steer') return last.kind === 'message';
  if (action === 'command') return last.kind === 'command';
  if (!action && writerLockErrorCode(last.threadId, { threadId: msg.threadId, code: msg.code })) return last.kind === 'message';
  const text = String(msg.message || '');
  if (/审批|重命名|目标|停止|打断|requestId|新建会话/.test(text)) return false;
  if (last.kind === 'command') return /命令失败|没有工作目录/.test(text);
  return /^(Send|Steer) |写入锁|桌面还在跑|桌面仍在运行|该会话正由 Codex/.test(text);
}

function isInterimSendFeedback(msg: AppMessage) {
  return msg.interim === true || /桌面还在跑/.test(String(msg.message || ''));
}

function isFinalSendSuccess(msg: AppMessage, last: OutgoingSend | null) {
  if (msg.status !== 'success' || isInterimSendFeedback(msg)) return false;
  return isComposerFeedback(msg, last);
}

type RNWebSocketOptions = { headers?: Record<string, string> };

// 文件内容缓存条数上限（含 base64 图片，超出后淘汰最早的）。
const MAX_CACHED_FILES = 24;

function openSocket(url: string, token: string): WebSocket {
  const Ctor = WebSocket as unknown as {
    new (wsUrl: string, protocols?: string | string[], options?: RNWebSocketOptions): WebSocket;
  };
  return new Ctor(url, undefined, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// 会话状态拆成四个 context，避免高频更新（命令输出逐 chunk、历史流式合并、
// 文件树展开）触发所有消费方整体重渲染：
// - SessionContext：连接/配对/线程列表/配置等核心状态
// - HistoriesContext：各线程历史与审批（流式合并高频变化）
// - ToolsContext：终端命令输出与 git 状态（逐 chunk 高频变化）
// - WorkspaceContext：文件树、文件内容、工作区搜索
type SessionValue = {
  capabilities: Record<string, boolean>;
  executionStates: Record<string, ExecutionState>;
  queues: Record<string, QueuedMessage[]>;
  commands: Record<string, CommandState>;
  draftSync: Record<string, DraftSyncState>;
  userInputs: Record<string, UserInputRequest>;
  getExecutionState: (threadId: string) => boolean;
  handoffThread: (threadId: string) => boolean;
  queueMessage: (threadId: string, text: string, input?: unknown[]) => boolean;
  listQueue: (threadId: string) => boolean;
  cancelQueuedMessage: (threadId: string, queueId: string) => boolean;
  getDraft: (threadId: string) => boolean;
  saveDraft: (threadId: string, text: string, attachments: ComposerPending[]) => boolean;
  resolveDraftConflict: (threadId: string, choice: 'local' | 'remote') => Promise<boolean>;
  queryCommand: (requestId: string) => boolean;
  respondUserInput: (requestId: string, answers: UserInputAnswers) => boolean;
  hydrated: boolean;
  paired: boolean;
  relayUrl: string;
  hubId: string;
  lanUrl: string;
  mode: '' | 'relay' | 'lan';
  conn: ConnKind;
  connText: string;
  handshake: HandshakeView;
  error: string;
  threads: Thread[];
  projects: Project[];
  feedback: string;
  models: ModelInfo[];
  skills: SkillInfo[];
  mcpServers: McpServerInfo[];
  config: HubConfig;
  lastCreatedId: string;
  hostName: string;
  quota: TokenUsage;
  mention: { name: string; path: string } | null;
  queueMention: (path: string) => void;
  clearMention: () => void;
  pinnedIds: string[];
  archivedIds: string[];
  setRelayUrl: (url: string) => Promise<void>;
  pair: (codeOrUrl: string, relayOverride?: string) => Promise<void>;
  loginLan: (url: string, password: string) => Promise<void>;
  logout: (options?: { localOnly?: boolean }) => Promise<void>;
  subscribeApp: (listener: (msg: AppMessage) => void) => () => void;
  requestState: (type: string, threadId?: string, path?: string) => RequestState | undefined;
  requests: Record<string, RequestState>;
  diagnostics: ReturnType<typeof safeConnectionDiagnostic>;
  connectionIdentity: string;
  draftNamespace: string;
  sendMessage: (msg: AppMessage) => boolean;
  subscribeMessages: (listener: (msg: AppMessage) => void) => () => void;
  sendApp: (msg: AppMessage) => boolean;
  refreshThreads: () => void;
  createThread: (targetCwd?: string, title?: string) => void;
  sendComposer: (threadId: string, text: string, working: boolean, input?: unknown[], mode?: 'plan' | 'review') => boolean;
  localMessages: LocalMessage[];
  outgoing: OutgoingSend | null;
  failedSends: FailedSend[];
  retryFailedSend: (id: string) => boolean;
  dismissFailedSend: (id: string) => void;
  forceClearFailedSendLock: (id: string, threadId: string, options?: { acknowledgeHolderAlive?: boolean }) => Promise<boolean>;
  sendStop: (threadId: string) => void;
  requestSkills: (cwd?: string) => void;
  setSkillEnabled: (skill: { path?: string; name?: string; enabled: boolean }, cwd?: string) => void;
  requestMcp: () => void;
  reloadMcp: () => void;
  plugins: PluginInfo[];
  requestPlugins: () => void;
  setPluginEnabled: (id: string, enabled: boolean) => void;
  updateConfig: (key: string, value: string) => void;
  goal: { threadId: string; objective: string } | null;
  getGoal: (threadId: string) => void;
  setGoal: (threadId: string, objective: string) => void;
  renameThread: (threadId: string, title: string) => void;
  togglePin: (id: string, kind?: 'thread' | 'project') => void;
  archiveThread: (threadId: string) => void;
  unarchiveThread: (threadId: string) => void;
  archivedThreads: Thread[];
  reconnect: () => void;
  clearError: () => void;
  clearFeedback: () => void;
};

type HistoriesValue = {
  histories: Record<string, ThreadHistory>;
  approvals: Record<string, Approval>;
  loadingHistory: Record<string, boolean>;
  loadingOlder: Record<string, boolean>;
  openThread: (threadId: string) => void;
  loadOlderHistory: (threadId: string) => void;
  sendApproval: (threadId: string, decision: Decision) => void;
};

type ToolsValue = {
  commandOut: string;
  commandHist: { command: string; exitCode?: number | null }[];
  git: { branch?: string; truncated?: boolean; threadId?: string; cwd?: string; status?: string; diff?: string; log?: string; commits?: { hash: string; author: string; date: string; subject: string; refs?: string }[]; error?: string | null; files?: { path: string; status?: string; add?: number; del?: number; patch?: string; binary?: boolean }[] } | null;
  searchHits: { index: number; type: string; snippet: string }[];
  ptyChunk: { threadId: string; data: string; n: number } | null;
  ptyAlive: Record<string, boolean>;
  ptyError: string;
  runCommand: (threadId: string, command: string) => boolean;
  stopCommand: (threadId: string) => void;
  gitStatus: (threadId: string) => void;
  gitDiff: (threadId: string) => void;
  searchThread: (threadId: string, q: string) => void;
  openPty: (threadId: string, cols?: number, rows?: number) => void;
  writePty: (threadId: string, data: string) => void;
  resizePty: (threadId: string, cols: number, rows: number) => void;
  closePty: (threadId: string) => void;
};

type WorkspaceValue = {
  tree: { cwd: string; rootName: string; tree: TreeNode[] };
  files: Record<string, FileData>;
  workspaceHits: { name: string; path: string; dir?: string }[];
  artifacts: ArtifactRecord[];
  artifactsScope: 'latest_turn' | 'session_confirmed' | '';
  artifactsTurnId: string;
  artifactsCoverage: { truncated?: boolean; bytesRead?: number; totalBytes?: number } | null;
  recentDocuments: ArtifactRecord[];
  uploadTasks: UploadTask[];
  beginUpload: (threadId: string, name: string, image?: boolean) => string;
  failUpload: (taskId: string, error: string) => void;
  removeUpload: (taskId: string) => void;
  retryUpload: (taskId: string) => void;
  lastUpload: { path: string; name: string; error?: string | null } | null;
  requestTree: (threadId: string, cwd?: string, dirPath?: string) => void;
  requestFile: (threadId: string, path: string) => void;
  uploadFile: (threadId: string, name: string, base64: string, mime?: string, taskId?: string) => void;
  searchWorkspace: (threadId: string, cwd: string, q: string) => void;
  listArtifacts: (threadId: string, cwd?: string) => void;
  clearUpload: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);
const HistoriesContext = createContext<HistoriesValue | null>(null);
const ToolsContext = createContext<ToolsValue | null>(null);
const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
  const capabilitiesRef = useRef<Record<string, boolean>>({});
  const [executionStates, setExecutionStates] = useState<Record<string, ExecutionState>>({});
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [commands, setCommands] = useState<Record<string, CommandState>>({});
  const [draftSync, setDraftSync] = useState<Record<string, DraftSyncState>>({});
  const draftSyncRef = useRef<Record<string, DraftSyncState>>({});
  const [userInputs, setUserInputs] = useState<Record<string, UserInputRequest>>({});
  const historyRef = useRef<Record<string, ThreadHistory>>({});
  const reconcileRef = useRef<() => void>(() => {});
  const uncertainRef = useRef(new Map<string, OutgoingSend>());
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const forgetPending = useCallback((sent: OutgoingSend) => {
    if (sent.pendingNamespace) void removePendingCommand(sent.pendingNamespace, sent.id).catch(() => {
      if (mountedRef.current) setError('结果已确认，但本地请求记录清理失败；下次启动仍会只查询，不重发。');
    });
  }, []);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const uploadRef = useRef(new Map<string, UploadTask>());
  const uploadPayloads = useRef(new Map<string, { base64: string; mime?: string }>());
  const uploadTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [artifactsScope, setArtifactScope] = useState<WorkspaceValue['artifactsScope']>('');
  const [artifactsTurnId, setArtifactTurnId] = useState('');
  const [artifactsCoverage, setArtifactCoverage] = useState<WorkspaceValue['artifactsCoverage']>(null);
  const [recentDocuments, setRecentDocuments] = useState<ArtifactRecord[]>([]);
  const [requests, setRequests] = useState<Record<string, RequestState>>({});
  const requestsRef = useRef<Record<string, RequestState>>({});
  const requestTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const listeners = useRef(new Set<(msg: AppMessage) => void>());
  const subscribeMessages = useCallback((listener: (msg: AppMessage) => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; }, []);
  const [hydrated, setHydrated] = useState(false);
  const [relayUrl, setRelayUrlState] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const [hubId, setHubId] = useState('');
  const [conn, setConn] = useState<ConnKind>('idle');
  const [handshakePhase, setHandshakePhase] = useState<HandshakePhase>('idle');
  const [error, setError] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [histories, setHistories] = useState<Record<string, ThreadHistory>>({});
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const [feedback, setFeedback] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [config, setConfig] = useState<HubConfig>({});
  const [files, setFiles] = useState<Record<string, FileData>>({});
  const [lastCreatedId, setLastCreatedId] = useState('');
  const [hostName, setHostName] = useState('');
  const [quota, setQuota] = useState<TokenUsage>({});
  const quotaRef = useRef<TokenUsage>({});
  const [tree, setTree] = useState<{ cwd: string; rootName: string; tree: TreeNode[] }>({
    cwd: '',
    rootName: '',
    tree: [],
  });
  const [lastUpload, setLastUpload] = useState<{ path: string; name: string; error?: string | null } | null>(null);
  const [goal, setGoalState] = useState<{ threadId: string; objective: string } | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<Thread[]>([]);
  const [git, setGit] = useState<ToolsValue['git']>(null);
  const gitThreadRef = useRef('');
  const [commandOut, setCommandOut] = useState('');
  const [commandHist, setCommandHist] = useState<{ command: string; exitCode?: number | null }[]>([]);
  const [ptyChunk, setPtyChunk] = useState<{ threadId: string; data: string; n: number } | null>(null);
  const [ptyAlive, setPtyAlive] = useState<Record<string, boolean>>({});
  const [ptyError, setPtyError] = useState('');
  const ptyN = useRef(0);
  const [workspaceHits, setWorkspaceHits] = useState<{ name: string; path: string; dir?: string }[]>([]);
  const [artifacts, setArtifacts] = useState<{ name: string; path: string; ext?: string; mtimeMs?: number; size?: number }[]>([]);
  const [mention, setMention] = useState<{ name: string; path: string } | null>(null);
  const lastCommandRef = useRef('');
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingSend | null>(null);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
  useEffect(() => {
    setLocalMessages(prev => {
      let next = prev.map(row => {
        const failed = failedSends.find(f => f.id === row.id);
        return failed?.deliveryStatus && failed.deliveryStatus !== row.status
          ? { ...row, status: failed.deliveryStatus } : row;
      });
      for (const [threadId, history] of Object.entries(histories)) next = reconcileLocalMessages(next, threadId, history);
      return next.every((row, i) => row === prev[i]) ? prev : next;
    });
  }, [histories, failedSends]);
  const [searchHits, setSearchHits] = useState<{ index: number; type: string; snippet: string }[]>([]);
  const [mode, setMode] = useState<'' | 'relay' | 'lan'>('');
  const [lanUrl, setLanUrl] = useState('');
  const [localTrusted, setLocalTrusted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);
  const authBlockedRef = useRef(false);
  const [authBlocked, setAuthBlocked] = useState(false);
  const failsRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maintenanceRef = useRef<ReturnType<typeof createSocketMaintenance> | null>(null);
  const localPinsRef = useRef<string[]>([]);
  const pinMigratedRef = useRef(false);
  const localArchivedRef = useRef<string[]>([]);
  const archiveMigratedRef = useRef(false);
  const lastTrafficRef = useRef(0);
  const WATCHDOG_MS = 70000;
  const credsRef = useRef({
    relayUrl: '',
    deviceToken: '',
    hubId: '',
    hubE2ePub: '',
    contentKey: '',
    keyId: '',
    lanUrl: '',
    lanPassword: '',
    localTrusted: false,
    mode: '' as '' | 'relay' | 'lan',
  });
  const deviceKeysRef = useRef<{ publicKey: string; secretKey: string } | null>(null);
  const pendingAppRef = useRef<PendingApp<AppMessage>[]>([]);
  const socketIdentityRef = useRef('');
  const cacheIdentityRef = useRef('');
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const lastOutgoingRef = useRef<OutgoingSend | null>(null);
  useEffect(() => {
    if (!outgoing) return;
    const timer = setTimeout(() => {
      if (lastOutgoingRef.current?.id !== outgoing.id) return;
      lastOutgoingRef.current = null; setOutgoing(null);
      uncertainRef.current.set(outgoing.id, outgoing);
      setFailedSends(prev => [...prev.filter(row => row.id !== outgoing.id), { ...outgoing, deliveryStatus: 'uncertain', error: '发送结果未知，正在核对；不会自动重复发送。' }]);
      setCommands(prev => ({ ...prev, [outgoing.id]: { requestId: outgoing.id, threadId: outgoing.threadId, status: 'uncertain' } }));
      reconcileRef.current();
    }, 25000);
    return () => clearTimeout(timer);
  }, [outgoing]);
  const currentThreadRef = useRef('');
  const loadingOlderRef = useRef(new Set<string>());
  const loadingOlderTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [loadingOlder, setLoadingOlder] = useState<Record<string, boolean>>({});
  const loadingHistoryRef = useRef(new Set<string>());
  const loadingHistoryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [loadingHistory, setLoadingHistory] = useState<Record<string, boolean>>({});
  const connRef = useRef<ConnKind>('idle');
  const backgroundRef = useRef(false);
  const dismissedApprovalKeys = useRef(new Set<string>());
  const dismissedThreads = useRef(new Set<string>());

  const dismissApprovalLocal = useCallback((threadId: string, ids: string[] = []) => {
    if (!threadId) return;
    dismissedThreads.current.add(threadId);
    for (const id of ids) {
      if (id) dismissedApprovalKeys.current.add(`${threadId}:${id}`);
    }
    setApprovals((prev) => {
      const cur = prev[threadId];
      if (!cur) return prev;
      if (ids.length && !collectApprovalIds(cur).some((id) => ids.includes(id))) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
    setHistories((prev) => {
      const h = prev[threadId];
      if (!h?.pendingApproval) return prev;
      const pendingIds = collectApprovalIds(h.pendingApproval);
      if (ids.length && !pendingIds.some((id) => ids.includes(id))) return prev;
      return {
        ...prev,
        [threadId]: {
          ...h,
          pendingApproval: null,
          status: h.status === 'waiting_approval' ? 'idle' : h.status,
        },
      };
    });
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, needsApproval: false } : t)));
    setProjects((prev) =>
      prev.map((p) => ({
        ...p,
        threads: p.threads.map((t) => (t.id === threadId ? { ...t, needsApproval: false } : t)),
      })),
    );
  }, []);
  const dismissApprovalRef = useRef(dismissApprovalLocal);
  dismissApprovalRef.current = dismissApprovalLocal;

  useEffect(() => {
    credsRef.current.relayUrl = relayUrl;
    credsRef.current.deviceToken = deviceToken;
    credsRef.current.hubId = hubId;
  }, [relayUrl, deviceToken, hubId]);

  useEffect(() => {
    connRef.current = conn;
  }, [conn]);

  const paired = !authBlocked && (mode === 'lan'
    ? Boolean(lanUrl && (credsRef.current.lanPassword || localTrusted))
    : Boolean(deviceToken && hubId && relayUrl));

  const connText =
    conn === 'connected'
      ? (mode === 'lan' ? '直连' : '中继')
      : conn === 'hub_offline'
        ? '离线'
        : conn === 'reconnecting'
          ? '重连中'
          : conn === 'connecting'
            ? (handshakePhase === 'e2e' ? '握手中' : handshakePhase === 'sync' ? '同步中' : '连接中')
            : paired
              ? '未连接'
              : '未配对';

  const handshake = useMemo(
    () => buildHandshake({ mode, phase: handshakePhase, error }),
    [mode, handshakePhase, error],
  );

  const clearTimers = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    maintenanceRef.current?.stop();
  }, []);

  const sendRaw = useCallback((env: Envelope) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(env));
      return true;
    } catch { return false; }
  }, []);

  const trySendApp = useCallback((msg: AppMessage) => {
    const creds = credsRef.current;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || socketIdentityRef.current !== transportIdentity(creds)) return false;
    try {
      if (creds.mode === 'lan') {
        ws.send(JSON.stringify(msg));
        return true;
      }
      if (!creds.hubId || !creds.contentKey) return false;
      return sendRaw({ v: 1, type: 'fwd', hubId: creds.hubId,
        enc: secretSeal(msg, creds.contentKey, creds.keyId) });
    } catch { return false; }
  }, [sendRaw]);

  const sendApp = useCallback((msg: AppMessage) => {
    const creds = credsRef.current;
    const identity = transportIdentity(creds);
    const tracked = Boolean(REQUEST_REPLIES[msg.type]);
    const key = requestKey(msg.type, String(msg.threadId || ''), String(msg.type === 'query_command' ? msg.requestId || '' : msg.path || ''));
    const requestId = String(msg.requestId || (tracked ? nextFailedId() : ''));
    const payload = tracked ? { ...msg, requestId } : msg;
    const readOrHandshake = tracked && !['save_draft', 'handoff_thread', 'queue_message', 'cancel_queued_message', 'send_user_input'].includes(msg.type) || ['get_config', 'get_models', 'register_push'].includes(msg.type);
    const sent = !stoppedRef.current && (readOrHandshake || connRef.current === 'connected') && trySendApp(payload);
    if (tracked) {
      const old = requestTimers.current.get(key); if (old) clearTimeout(old);
      const state: RequestState = { type: msg.type, key, requestId, identity, legacyHistory: !requestsRef.current[key], reconciliation: msg.reconciliation === true, historyRev: historyRef.current[String(msg.threadId || '')]?.rev, all: Boolean(msg.all), threadId: String(msg.threadId || ''), status: sent ? 'loading' : 'error', error: sent ? undefined : '未连接，请重试', startedAt: Date.now() };
      requestsRef.current = { ...requestsRef.current, [key]: state }; setRequests(requestsRef.current);
      if (sent) requestTimers.current.set(key, setTimeout(() => {
        if (requestsRef.current[key]?.requestId !== requestId || requestsRef.current[key]?.status !== 'loading') return;
        requestsRef.current = { ...requestsRef.current, [key]: { ...state, status: 'timeout', error: '请求超时，请重试' } }; setRequests(requestsRef.current);
        setLoadingHistory(p => ({ ...p, [state.threadId]: false })); setLoadingOlder(p => ({ ...p, [state.threadId]: false }));
        if (state.type === 'save_draft' || state.type === 'get_draft') {
          draftSyncRef.current = { ...draftSyncRef.current, [state.threadId]: { ...draftSyncRef.current[state.threadId], status: 'error', error: '草稿确认超时；本地内容保留，请重新核对远端版本。' } };
          setDraftSync(draftSyncRef.current);
        }
      }, 25000));
    }
    return sent;
  }, [trySendApp]);

  const restorePending = useCallback(() => {
    const namespace = draftNamespace(credsRef.current);
    const identity = transportIdentity(credsRef.current);
    if (!credsRef.current.hubId) return;
    void loadPendingCommands(namespace).then(rows => {
      if (!mountedRef.current || identity !== transportIdentity(credsRef.current) || namespace !== draftNamespace(credsRef.current)) return;
      for (const row of rows) {
        if (uncertainRef.current.has(row.requestId) || lastOutgoingRef.current?.id === row.requestId) continue;
        const restored: OutgoingSend = { id: row.requestId, clientUserMessageId: row.clientUserMessageId, threadId: row.threadId,
          text: '', kind: 'message', working: false, restored: true, pendingNamespace: namespace, deliveryStatus: 'uncertain' };
        uncertainRef.current.set(restored.id, restored);
        setFailedSends(prev => [...removeFailedSend(prev, restored.id), { ...restored, error: '恢复了待确认请求（未保存消息正文）；正在核对原请求，不会重发。' }]);
        setCommands(prev => ({ ...prev, [restored.id]: { requestId: restored.id, threadId: restored.threadId, status: 'uncertain' } }));
        if (capabilitiesRef.current.query_command === true) sendApp({ type: 'query_command', requestId: restored.id });
      }
    }).catch(() => { if (mountedRef.current) setError('无法读取待确认请求；请检查本地存储，切勿重复提交。'); });
  }, [sendApp]);

  const reconcile = useCallback(() => {
    restorePending();
    const threadId = currentThreadRef.current;
    if (threadId) {
      const history = historyRef.current[threadId];
      sendApp({ type: 'get_thread_history', threadId, all: true, reconciliation: true, limit: Math.max(250, (history?.items.length || 0) + 250, history?.totalItems || 0) });
      for (const type of ['get_execution_state', 'list_queue', 'get_draft']) {
        if (capabilitiesRef.current[type] === true) sendApp({ type, threadId });
      }
    }
    for (const pending of uncertainRef.current.values()) sendApp({ type: 'query_command', requestId: pending.id });
    if (lastOutgoingRef.current) sendApp({ type: 'query_command', requestId: lastOutgoingRef.current.id });
  }, [sendApp, restorePending]);
  reconcileRef.current = reconcile;

  const flushPending = useCallback(() => {
    drainPending(pendingAppRef.current, transportIdentity(credsRef.current), trySendApp);
  }, [trySendApp]);

  const startMaintenance = useCallback(() => {
    if (backgroundRef.current || stoppedRef.current) return;
    maintenanceRef.current ??= createSocketMaintenance(() => {
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      if (lastTrafficRef.current && Date.now() - lastTrafficRef.current > WATCHDOG_MS) {
        try { sock.close(); } catch { /* reconnect via onclose */ }
        return;
      }
      if (credsRef.current.mode === 'lan') {
        try { sock.send(JSON.stringify({ type: 'ping' })); } catch { /* watchdog will reconnect */ }
      } else sendRaw(wrapPing());
    }, () => {
      if (connRef.current === 'hub_offline') sendApp({ type: 'get_threads' });
      flushPending();
      if (connRef.current === 'connected') {
        for (const pending of uncertainRef.current.values()) sendApp({ type: 'query_command', requestId: pending.id });
      }
    });
    maintenanceRef.current.start();
  }, [flushPending, sendApp, sendRaw]);

  const publishUploads = useCallback(() => setUploadTasks([...uploadRef.current.values()]), []);
  const failUpload = useCallback((taskId: string, error: string) => {
    const task = uploadRef.current.get(taskId); if (!task) return;
    uploadRef.current.set(taskId, { ...task, status: 'error', error }); publishUploads();
  }, [publishUploads]);
  const finishUpload = useCallback((taskId: string, path: string, error?: string) => {
    const task = uploadRef.current.get(taskId);
    if (!task || task.status !== 'uploading' || task.identity !== transportIdentity(credsRef.current)) return;
    const timer = uploadTimers.current.get(taskId); if (timer) clearTimeout(timer);
    if (error || !path) { failUpload(taskId, error || '上传未返回文件路径'); return; }
    uploadRef.current.set(taskId, { ...task, path });
    void appendComposerAttachment(task.draftKey || scopedDraftKey(task.threadId, draftNamespace(credsRef.current)), { name: task.name, path, image: task.image, source: 'device', taskId }).then(() => {
      const current = uploadRef.current.get(taskId);
      if (!current || current.identity !== transportIdentity(credsRef.current)) return;
      uploadRef.current.set(taskId, { ...current, status: 'success', path });
      uploadPayloads.current.delete(taskId); publishUploads();
    }).catch(() => failUpload(taskId, '上传已完成，但保存草稿失败；请重试保存'));
  }, [failUpload, publishUploads]);

  const handleApp = useCallback((msg: AppMessage) => {
    if (msg.type === 'ping') return;
    for (const listener of listeners.current) listener(msg);
    if (msg.type === 'thread_history' && !msg.requestId) {
      const legacy = legacyHistoryRequest(Object.values(requestsRef.current), msg, transportIdentity(credsRef.current));
      if (legacy) msg = { ...msg, requestId: legacy.requestId };
    }
    if (Object.values(REQUEST_REPLIES).includes(msg.type) && msg.type !== 'thread_list' && msg.type !== 'queue_list' && !msg.requestId) return;
    if (Object.values(REQUEST_REPLIES).includes(msg.type) && msg.requestId) {
      const state = Object.values(requestsRef.current).find(r => r.requestId === msg.requestId);
      if (!state || !matchesRequest(state, { requestId: msg.requestId, threadId: msg.threadId }, transportIdentity(credsRef.current))) return;
      if (['workspace_search', 'workspace_tree', 'artifacts_list', 'search_results', 'file_data'].includes(msg.type) && currentThreadRef.current && state.threadId !== currentThreadRef.current) return;
      const timer = requestTimers.current.get(state.key); if (timer) clearTimeout(timer);
      const inputResult = msg.type === 'user_input_result' ? msg.result as { ok?: boolean; code?: string } | undefined : undefined;
      const responseError = msg.error || (inputResult?.ok === false ? inputResult.code || '用户输入未被接受' : undefined);
      requestsRef.current = { ...requestsRef.current, [state.key]: { ...state, status: responseError ? 'error' : 'success', error: responseError ? String(responseError) : undefined } }; setRequests(requestsRef.current);
    }

    if (['hello', 'thread_list', 'config_data'].includes(msg.type)) {
      if (msg.capabilities && typeof msg.capabilities === 'object') {
        const caps = Object.fromEntries(Object.entries(msg.capabilities).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>;
        capabilitiesRef.current = caps; setCapabilities(caps);
      }
      if (typeof msg.hubId === 'string' && msg.hubId && credsRef.current.mode === 'lan') {
        const before = draftNamespace(credsRef.current);
        credsRef.current.hubId = msg.hubId;
        setHubId(msg.hubId);
        // LAN authentication identity excludes hubId; do not reconnect solely for this metadata.
        if (credsRef.current.mode === 'lan') {
          void saveSession({ hubId: msg.hubId });
          void migrateComposerDraftNamespace(before, draftNamespace(credsRef.current)).catch(() => setError('草稿迁移失败，旧草稿已保留'));
          if (before !== draftNamespace(credsRef.current)) setIdentityGeneration(n => n + 1);
        }
      }
      if (msg.type === 'hello') return;
    }
    if (msg.type === 'command_status') {
      const command = msg.command as CommandState | null;
      if (!command || command.requestId !== msg.requestId) return;
      setCommands(prev => ({ ...prev, [command.requestId]: command }));
      const sent = uncertainRef.current.get(command.requestId) || (lastOutgoingRef.current?.id === command.requestId ? lastOutgoingRef.current : null);
      if (!sent) return;
      if (command.threadId && command.threadId !== sent.threadId) return;
      if (command.status === 'succeeded') {
        setLocalMessages(prev => prev.map(row => row.id === sent.id ? { ...row, status: 'succeeded' } : row));
        uncertainRef.current.delete(sent.id);
        forgetPending(sent);
        setFailedSends(prev => removeFailedSend(prev, sent.id));
        if (lastOutgoingRef.current?.id === sent.id) { lastOutgoingRef.current = null; setOutgoing(null); }
        if (!sent.restored) void clearComposerDraftIfSending(sent.draftKey || scopedDraftKey(sent.threadId, draftNamespace(credsRef.current)), sent.text);
      } else if (command.status === 'failed') {
        uncertainRef.current.delete(sent.id);
        forgetPending(sent);
        if (lastOutgoingRef.current?.id === sent.id) { lastOutgoingRef.current = null; setOutgoing(null); }
        setFailedSends(prev => [...removeFailedSend(prev, sent.id), { ...sent, deliveryStatus: 'failed', error: (typeof command.error === 'string' ? command.error : command.error?.message) || '命令执行失败' }]);
      } else {
        setFailedSends(prev => prev.map(row => row.id === sent.id ? { ...row, deliveryStatus: command.status, error: command.status === 'uncertain' ? '结果仍未知；不会重复发送。' : '命令已收到，等待完成。' } : row));
      }
      return;
    }
    if (msg.type === 'execution_state' || msg.type === 'handoff_result') {
      const state = msg.executionState as ExecutionState | undefined;
      if (state && state.threadId === msg.threadId) {
        setExecutionStates(prev => ({ ...prev, [state.threadId]: state }));
        if (Array.isArray(state.pendingUserInputs)) setUserInputs(prev => ({
          ...Object.fromEntries(Object.entries(prev).filter(([, request]) => request.threadId !== state.threadId)),
          ...Object.fromEntries(state.pendingUserInputs!.filter(request => request.threadId === state.threadId).map(request => [request.requestId, request])),
        }));
      }
      if (msg.error) setError(String(msg.error));
      return;
    }
    if (msg.type === 'queue_list') {
      const queue = msg.queue as { items?: QueuedMessage[] } | undefined;
      if (typeof msg.threadId === 'string' && Array.isArray(queue?.items)) setQueues(prev => ({ ...prev, [String(msg.threadId)]: queue.items! }));
      const request = Object.values(requestsRef.current).find(row => row.requestId === msg.requestId);
      const mutation = request?.type === 'queue_message' || request?.type === 'cancel_queued_message';
      if (mutation && msg.error) setError(String(msg.error));
      else if (mutation) setFeedback('队列状态已由 Hub 确认；入队或送达不代表任务完成。');
      return;
    }
    if (msg.type === 'draft_data') {
      const threadId = String(msg.threadId || '');
      const remote = msg.draft;
      if (!threadId) return;
      if (!validRemoteDraft(remote)) {
        draftSyncRef.current = { ...draftSyncRef.current, [threadId]: { ...draftSyncRef.current[threadId], status: 'error', error: String(msg.error || '草稿响应无效') } };
        setDraftSync(draftSyncRef.current); return;
      }
      const identity = transportIdentity(credsRef.current);
      const key = scopedDraftKey(threadId, draftNamespace(credsRef.current));
      void loadComposerDraft(key).then(local => {
        if (identity !== transportIdentity(credsRef.current)) return;
        const previous = draftSyncRef.current[threadId];
        const baseline = previous?.local ? previous : { ...previous, status: 'loading' as const, local: local ? { text: local.text, attachments: local.pending } : undefined };
        const next = receiveDraft(baseline, remote, msg.code === 'CAS_CONFLICT');
        draftSyncRef.current = { ...draftSyncRef.current, [threadId]: next }; setDraftSync(draftSyncRef.current);
      }).catch(() => setError('读取本地草稿失败；未覆盖本地内容'));
      return;
    }
    if (msg.type === 'thread_list') {
      const wasReady = connRef.current === 'connected';
      const parsed = parseThreadList(msg.data);
      const gone = dismissedThreads.current;
      const serverPinned = parsed.threads.filter((t) => t.isPinned).map((t) => t.id);
      if (!pinMigratedRef.current) {
        pinMigratedRef.current = true;
        const serverSet = new Set(serverPinned);
        for (const id of localPinsRef.current) {
          if (id && !serverSet.has(id)) sendApp({ type: 'pin_item', kind: 'thread', id, pinned: true });
        }
        setPinnedIds(Array.from(new Set([...serverPinned, ...localPinsRef.current])));
      } else {
        setPinnedIds(serverPinned);
      }
      void saveIdSet('pins', serverPinned);
      if (!archiveMigratedRef.current) {
        archiveMigratedRef.current = true;
        const visible = new Set(parsed.threads.map((t) => t.id));
        const leftover = localArchivedRef.current.filter((id) => id && visible.has(id));
        for (const id of leftover) sendApp({ type: 'archive_item', id, archived: true });
        setArchivedIds(leftover);
        void saveIdSet('archived', leftover);
      } else {
        setArchivedIds((prev) => prev.filter((id) => !parsed.threads.some((t) => t.id === id)));
      }
      setThreads(parsed.threads.map((t) => (gone.has(t.id) ? { ...t, needsApproval: false } : t)));
      setProjects(
        parsed.projects.map((p) => ({
          ...p,
          threads: p.threads.map((t) => (gone.has(t.id) ? { ...t, needsApproval: false } : t)),
        })),
      );
      if (msg.config && typeof msg.config === 'object') setConfig(msg.config as HubConfig);
      if (msg.quota && typeof msg.quota === 'object') {
        quotaRef.current = msg.quota as TokenUsage;
        setQuota(msg.quota as TokenUsage);
      }
      if (typeof msg.hostName === 'string' && msg.hostName.trim()) setHostName(msg.hostName.trim());
      setHandshakePhase('ready');
      connRef.current = 'connected'; setConn('connected');
      if (!wasReady) reconcileRef.current();
      return;
    }
    if (msg.type === 'thread_created') {
      const id = typeof msg.threadId === 'string' ? msg.threadId : '';
      if (id) {
        setLastCreatedId(id);
        if (!historyRef.current[id]) {
          const initial = { ...emptyHistory(), full: true, totalItems: 0 };
          historyRef.current = { ...historyRef.current, [id]: initial };
          setHistories(prev => ({ ...prev, [id]: initial }));
        }
      }
      return;
    }
    if (msg.type === 'config_data' && msg.data && typeof msg.data === 'object') {
      setConfig(msg.data as HubConfig);
      if (msg.quota && typeof msg.quota === 'object') {
        quotaRef.current = msg.quota as TokenUsage;
        setQuota(msg.quota as TokenUsage);
      }
      if (typeof msg.hostName === 'string' && msg.hostName.trim()) setHostName(msg.hostName.trim());
      return;
    }
    if (msg.type === 'goal_data') {
      const id = typeof msg.threadId === 'string' ? msg.threadId : '';
      const raw = msg.goal && typeof msg.goal === 'object' ? (msg.goal as { objective?: string }) : null;
      setGoalState(id ? { threadId: id, objective: String(raw?.objective || '') } : null);
      return;
    }
    if (msg.type === 'models_list' && Array.isArray(msg.models)) {
      setModels(msg.models as ModelInfo[]);
      return;
    }
    if (msg.type === 'skills_list') {
      setSkills(Array.isArray(msg.skills) ? (msg.skills as SkillInfo[]) : []);
      if (typeof msg.error === 'string' && msg.error) setError(msg.error);
      return;
    }
    if (msg.type === 'mcp_list') {
      setMcpServers(Array.isArray(msg.servers) ? (msg.servers as McpServerInfo[]) : []);
      if (typeof msg.error === 'string' && msg.error) setError(msg.error);
      return;
    }
    if (msg.type === 'workspace_search') {
      setWorkspaceHits(Array.isArray(msg.hits) ? msg.hits as WorkspaceValue['workspaceHits'] : []);
      return;
    }
    if (msg.type === 'artifacts_list') {
      setArtifactScope(msg.scope === 'latest_turn' || msg.scope === 'session_confirmed' ? msg.scope : '');
      setArtifactTurnId(String(msg.turnId || ''));
      setArtifactCoverage(msg.coverage && typeof msg.coverage === 'object' ? msg.coverage as WorkspaceValue['artifactsCoverage'] : null);
      setArtifacts(Array.isArray(msg.artifacts) ? msg.artifacts as WorkspaceValue['artifacts'] : []);
      setRecentDocuments(Array.isArray(msg.recentDocuments) ? msg.recentDocuments as ArtifactRecord[] : Array.isArray(msg.files) ? msg.files as ArtifactRecord[] : []);
      return;
    }
    if (msg.type === 'workspace_tree') {
      const incoming = Array.isArray(msg.tree) ? (msg.tree as TreeNode[]) : [];
      const cwd = typeof msg.cwd === 'string' ? msg.cwd : '';
      const dirPath = typeof msg.path === 'string' && msg.path ? msg.path : cwd;
      setTree((prev) => {
        if (!dirPath || dirPath === cwd || dirPath === prev.cwd || !prev.tree.length) {
          return {
            cwd: cwd || prev.cwd,
            rootName: typeof msg.rootName === 'string' ? msg.rootName : prev.rootName,
            tree: incoming,
          };
        }
        return {
          ...prev,
          tree: mergeTreeChildren(prev.tree, dirPath, incoming),
        };
      });
      if (typeof msg.error === 'string' && msg.error) setError(msg.error);
      return;
    }
    if (msg.type === 'plugins_list') {
      setPlugins(Array.isArray(msg.plugins) ? (msg.plugins as PluginInfo[]) : []);
      if (typeof msg.error === 'string' && msg.error) setError(msg.error);
      return;
    }
    if (msg.type === 'upload_result') {
      const taskId = String(msg.taskId || msg.requestId || '');
      const task = uploadRef.current.get(taskId);
      if (!task || msg.threadId !== task.threadId) return;
      finishUpload(taskId, String(msg.path || ''), msg.error ? String(msg.error) : undefined);
      return;
    }
    if (msg.type === 'search_results') {
      const rows = Array.isArray(msg.results) ? msg.results : [];
      setSearchHits(rows as { index: number; type: string; snippet: string }[]);
      if (typeof msg.error === 'string' && msg.error) setError(msg.error);
      return;
    }
    if ((msg.type === 'git_status' || msg.type === 'git_diff') && gitThreadRef.current && msg.threadId !== gitThreadRef.current) return;
    if ((msg.type === 'git_status' || msg.type === 'git_diff') && msg.error) {
      const threadId = String(msg.threadId || '');
      setGit(prev => ({ ...(prev?.threadId === threadId ? prev : {}), threadId, error: String(msg.error) })); return;
    }
    if ((msg.type === 'git_status' || msg.type === 'git_diff') && msg.git && typeof msg.git === 'object') {
      const data = msg.git as { branch?: string; statusText?: string; diff?: string; truncated?: boolean; error?: string };
      const threadId = String(msg.threadId || '');
      setGit(prev => ({ ...(prev?.threadId === threadId ? prev : {}), threadId,
        ...(typeof data.branch === 'string' ? { branch: data.branch } : {}),
        ...(typeof data.statusText === 'string' ? { status: data.statusText } : {}),
        ...(typeof data.diff === 'string' ? { diff: data.diff } : {}),
        ...(typeof data.truncated === 'boolean' ? { truncated: data.truncated } : {}),
        error: data.error || null }));
      return;
    }
    if (msg.type === 'git_status') {
      setGit({
        threadId: typeof msg.threadId === 'string' ? msg.threadId : '',
        commits: Array.isArray(msg.commits) ? msg.commits as NonNullable<ToolsValue['git']>['commits'] : [],
        cwd: typeof msg.cwd === 'string' ? msg.cwd : '',
        status: typeof msg.status === 'string' ? msg.status : '',
        diff: typeof msg.diff === 'string' ? msg.diff : '',
        log: typeof msg.log === 'string' ? msg.log : '',
        error: typeof msg.error === 'string' ? msg.error : null,
        files: Array.isArray(msg.files) ? msg.files as { path: string; status?: string; add?: number; del?: number }[] : [],
      });
      return;
    }
    if (msg.type === 'pty_data') {
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
      const data = typeof msg.data === 'string' ? msg.data : '';
      if (!threadId || !data) return;
      ptyN.current += 1;
      setPtyChunk({ threadId, data, n: ptyN.current });
      setPtyAlive((prev) => (prev[threadId] ? prev : { ...prev, [threadId]: true }));
      return;
    }
    if (msg.type === 'pty_exit') {
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
      if (threadId) setPtyAlive((prev) => ({ ...prev, [threadId]: false }));
      return;
    }
    if (msg.type === 'command_output') {
      const chunk = typeof msg.chunk === 'string' ? msg.chunk : '';
      const stream = typeof msg.stream === 'string' ? msg.stream : '';
      if (stream === 'exit') {
        const code = msg.exitCode == null ? null : Number(msg.exitCode);
        setCommandOut((prev) => `${prev}\n[exit ${String(msg.exitCode ?? '')}]\n`);
        const cmd = lastCommandRef.current;
        if (cmd) {
          setCommandHist((prev) => [{ command: cmd, exitCode: code }, ...prev.filter((row) => row.command !== cmd)].slice(0, 8));
        }
      } else if (chunk) {
        setCommandOut((prev) => prev + chunk);
      }
      return;
    }
    if (msg.type === 'file_data' && typeof msg.path === 'string') {
      const p = msg.path as string;
      const requested = typeof msg.requestPath === 'string' ? msg.requestPath : '';
      const data: FileData = {
        path: p,
        requestPath: requested || undefined,
        fileName: typeof msg.fileName === 'string' ? msg.fileName : '',
        ext: typeof msg.ext === 'string' ? msg.ext : '',
        encoding: msg.encoding === 'base64' ? 'base64' : 'utf8',
        content: typeof msg.content === 'string' ? msg.content : '',
        truncated: Boolean(msg.truncated),
        error: typeof msg.error === 'string' ? msg.error : null,
      };
      setFiles((prev) => {
        const next: Record<string, FileData> = { ...prev };
        delete next[p];
        next[p] = data;
        if (requested && requested !== p) {
          delete next[requested];
          next[requested] = data;
        }
        const keys = Object.keys(next);
        for (let i = 0; i < keys.length - MAX_CACHED_FILES; i += 1) delete next[keys[i]];
        let bytes = 0;
        for (const key of Object.keys(next).reverse()) {
          bytes += next[key].content.length * 2;
          if (bytes > 32 * 1024 * 1024) delete next[key];
        }
        return next;
      });
      return;
    }
    if (msg.type === 'thread_history' || msg.type === 'thread_update') {
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
      if (!threadId) return;
      if (msg.type === 'thread_history') {
      loadingHistoryRef.current.delete(threadId);
      const historyTimer = loadingHistoryTimers.current.get(threadId);
      if (historyTimer) {
        clearTimeout(historyTimer);
        loadingHistoryTimers.current.delete(threadId);
      }
      setLoadingHistory((prev) => {
        if (!prev[threadId]) return prev;
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
      }
      if (msg.type === 'thread_history') {
        loadingOlderRef.current.delete(threadId);
        const timer = loadingOlderTimers.current.get(threadId);
        if (timer) {
          clearTimeout(timer);
          loadingOlderTimers.current.delete(threadId);
        }
        setLoadingOlder((prev) => {
          if (!prev[threadId]) return prev;
          const next = { ...prev };
          delete next[threadId];
          return next;
        });
      }
      const historyRequest = requestsRef.current[requestKey('get_thread_history', threadId)];
      // Only a correlated explicit reconciliation with no intervening live revision
      // may reset a revision or replace a shorter authoritative snapshot.
      const authoritative = msg.type === 'thread_history' && historyRequest?.requestId === msg.requestId
        && historyRequest.reconciliation === true && historyRequest.historyRev === historyRef.current[threadId]?.rev;
      const snapshot = mergeHistory(historyRef.current[threadId], msg.data, { authoritative });
      historyRef.current = { ...historyRef.current, [threadId]: snapshot };
      if (snapshot.needsReconcile) {
        const pending = requestsRef.current[requestKey('get_thread_history', threadId)];
        if (pending?.status !== 'loading' && !authoritative) sendApp({ type: 'get_thread_history', threadId, all: true, reconciliation: true, limit: Math.max(2000, snapshot.items.length + 250) });
      }
      setHistories((prev) => {
        let merged = snapshot;
        const pending = merged.pendingApproval;
        const ids = collectApprovalIds(pending);
        const dismissed = ids.some((id) => dismissedApprovalKeys.current.has(`${threadId}:${id}`));
        if (pending && dismissed) {
          merged = {
            ...merged,
            pendingApproval: null,
            status: merged.status === 'waiting_approval' ? 'idle' : merged.status,
          };
        }
        if (merged.pendingApproval?.id) {
          dismissedThreads.current.delete(threadId);
          const approval = approvalFromHistory(threadId, merged);
          if (approval) setApprovals((p) => ({ ...p, [threadId]: approval }));
        } else {
          setApprovals((p) => {
            const cur = p[threadId];
            if (!cur || cur.source === 'live') return p;
            const next = { ...p };
            delete next[threadId];
            return next;
          });
        }
        return { ...prev, [threadId]: merged };
      });
      return;
    }
    if (msg.type === 'user_input_request') {
      if (typeof msg.requestId === 'string' && typeof msg.threadId === 'string' && msg.payload && typeof msg.payload === 'object') {
        const pending = msg as unknown as UserInputRequest;
        setUserInputs(prev => ({ ...prev, [pending.requestId]: pending }));
      }
      return;
    }
    if (msg.type === 'user_input_resolved') {
      setUserInputs(prev => {
        const requestId = String(msg.requestId || '');
        if (prev[requestId]?.threadId !== msg.threadId) return prev;
        const next = { ...prev }; delete next[requestId]; return next;
      });
      return;
    }
    if (msg.type === 'user_input_result') {
      const result = msg.result as { ok?: boolean; code?: string } | undefined;
      if (!result?.ok) setError(String(msg.error || result?.code || '用户输入未被接受；请在执行端处理'));
      return;
    }
    if (msg.type === 'approval_request') {
      const approval = approvalFromMessage(msg);
      if (!approval) return;
      const ids = collectApprovalIds(approval);
      if (ids.some((id) => dismissedApprovalKeys.current.has(`${approval.threadId}:${id}`))) return;
      dismissedThreads.current.delete(approval.threadId);
      setApprovals((prev) => ({ ...prev, [approval.threadId]: approval }));
      setThreads((prev) => prev.map((t) => (t.id === approval.threadId ? { ...t, needsApproval: true } : t)));
      return;
    }
    if (msg.type === 'approval_resolved') {
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
      const ids = collectApprovalIds({
        requestId: msg.requestId == null ? '' : String(msg.requestId),
        ids: Array.isArray(msg.ids) ? msg.ids.map((v) => String(v)) : [],
      });
      if (threadId) dismissApprovalRef.current(threadId, ids);
      return;
    }
    if (msg.type === 'action_feedback') {
      const status = typeof msg.status === 'string' ? msg.status : '';
      const message = typeof msg.message === 'string' ? msg.message : '';
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
      const code = typeof msg.code === 'string' ? msg.code : '';
      const action = typeof msg.action === 'string' ? msg.action : '';
      if (action === 'pty') {
        if (status === 'error') setPtyError(message || '终端失败');
        else {
          setPtyError('');
          if (threadId) setPtyAlive((prev) => ({ ...prev, [threadId]: true }));
        }
        return;
      }
      const gone = status === 'error' && action === 'approval' && code === 'approval_already_resolved';
      if (gone && threadId) {
        dismissApprovalRef.current(threadId, collectApprovalIds({
          requestId: msg.requestId == null ? '' : String(msg.requestId),
          ids: Array.isArray(msg.ids) ? msg.ids.map((v) => String(v)) : [],
        }));
      }
      const last = (typeof msg.requestId === 'string' ? uncertainRef.current.get(msg.requestId) : undefined) || lastOutgoingRef.current;
      if (last && msg.requestId === last.id && msg.commandStatus === 'uncertain') {
        uncertainRef.current.set(last.id, last);
        if (lastOutgoingRef.current?.id === last.id) { lastOutgoingRef.current = null; setOutgoing(null); }
        setFailedSends(prev => [...removeFailedSend(prev, last.id), { ...last, deliveryStatus: 'uncertain', error: message || '发送结果未知，正在核对。' }]);
        setCommands(prev => ({ ...prev, [last.id]: { requestId: last.id, threadId: last.threadId, status: 'uncertain' } }));
        reconcileRef.current(); return;
      }
      if (status === 'error') {
        const quotaHit = code === 'quota' || isQuotaError(message);
        const shown = quotaHit ? quotaExhaustedMessage(quotaRef.current, message) : (message || '操作失败');
        if (isComposerFeedback(msg, last) && last) {
          uncertainRef.current.delete(last.id);
          forgetPending(last);
          if (lastOutgoingRef.current?.id === last.id) { lastOutgoingRef.current = null; setOutgoing(null); }
          setFailedSends((prev) => [
            ...removeFailedSend(prev, last.id),
            { ...last, deliveryStatus: 'failed', error: shown, code: writerLockErrorCode(last.threadId, { threadId: msg.threadId, code: msg.code }) },
          ]);
        }
        setError(shown);
      } else {
        if (isFinalSendSuccess(msg, last) && last) {
          setLocalMessages(prev => prev.map(row => row.id === last.id ? { ...row, status: 'succeeded' } : row));
          uncertainRef.current.delete(last.id);
          forgetPending(last);
          setFailedSends(prev => removeFailedSend(prev, last.id));
          if (lastOutgoingRef.current?.id === last.id) { lastOutgoingRef.current = null; setOutgoing(null); }
          if (!last.restored) void clearComposerDraftIfSending(last.draftKey || scopedDraftKey(last.threadId, draftNamespace(credsRef.current)), last.text);
        }
        if (/pending|空闲|sidecar|物化/i.test(message)) {
          setFeedback(message || '已记下，等电脑空闲再写入桌面。');
        } else if (message) setFeedback(message);
      }
    }
  }, [sendApp, finishUpload, forgetPending]);

  const disconnect = useCallback(() => {
    clearTimers();
    for (const listener of listeners.current) listener({ type: 'transport_closed' });
    for (const timer of requestTimers.current.values()) clearTimeout(timer);
    requestTimers.current.clear();
    requestsRef.current = Object.fromEntries(Object.entries(requestsRef.current).map(([k,r]) => [k, r.status === 'loading' ? { ...r, status: 'error' as const, error: '连接已关闭，请重试' } : r]));
    setRequests(requestsRef.current);
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }, [clearTimers]);

  const invalidateAuthentication = useCallback(() => {
    authBlockedRef.current = true; setAuthBlocked(true);
    stoppedRef.current = true;
    pendingAppRef.current.length = 0;
    const creds = credsRef.current;
    // Invalidate only the failing transport. Keep stable Hub identity, drafts and
    // pending command journal intact; an auth failure is not command failure.
    if (creds.mode === 'lan') {
      creds.lanPassword = ''; creds.localTrusted = false; setLocalTrusted(false);
      void saveSession({ lanPassword: '', authRequired: true }).catch(() => setError('认证已失效，清理登录凭据失败；请重新认证。'));
    } else {
      creds.deviceToken = ''; creds.contentKey = ''; creds.keyId = ''; setDeviceToken('');
      void saveSession({ deviceToken: '', contentKey: '', keyId: '', authRequired: true }).catch(() => setError('认证已失效，清理登录凭据失败；请重新认证。'));
    }
    disconnect();
    connRef.current = 'idle'; setConn('idle'); setHandshakePhase('idle');
    setError('认证已失效，请重新配对；已停止自动连接。');
  }, [disconnect]);

  const connect = useCallback(() => {
    const creds = credsRef.current;
    const lan = creds.mode === 'lan';
    if (stoppedRef.current || authBlockedRef.current) return;
    if (lan) {
      if (!creds.lanUrl) return;
      if (!creds.lanPassword && !creds.localTrusted) return;
    } else if (!creds.relayUrl || !creds.deviceToken || !creds.hubId) {
      return;
    }
    disconnect();
    capabilitiesRef.current = {}; setCapabilities({});
    connRef.current = 'connecting';
    const nextIdentity = transportIdentity(creds);
    if (cacheIdentityRef.current !== nextIdentity) {
      cacheIdentityRef.current = nextIdentity; setIdentityGeneration(n => n + 1);
      historyRef.current = {}; uncertainRef.current.clear();
      setExecutionStates({}); setQueues({}); setCommands({}); setUserInputs({}); draftSyncRef.current = {}; setDraftSync({});
      setHistories({}); setApprovals({}); setThreads([]); setProjects([]); setFiles({});
      setTree({ cwd: '', rootName: '', tree: [] }); setArtifacts([]); setRecentDocuments([]); setWorkspaceHits([]); setSearchHits([]);
      setFailedSends([]); setOutgoing(null); setLocalMessages([]); lastOutgoingRef.current = null;
      uploadRef.current.clear(); uploadPayloads.current.clear(); setUploadTasks([]);
      requestsRef.current = {}; setRequests({});
    }
    setHandshakePhase((prev) => (prev === 'ready' || prev === 'sync' ? 'reconnecting' : 'socket'));
    setConn((prev) => (prev === 'connected' ? 'reconnecting' : 'connecting'));
    const wsUrl = lan
      ? toWsUrl(creds.lanUrl, creds.lanPassword, '/api/ws')
      : toWsUrl(creds.relayUrl, creds.deviceToken);
    let ws: WebSocket;
    try {
      ws = openSocket(wsUrl, lan ? creds.lanPassword : creds.deviceToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法建立连接');
      setConn('reconnecting');
      return;
    }
    wsRef.current = ws;
    const identity = transportIdentity(creds);
    socketIdentityRef.current = identity;
    const isCurrent = () => wsRef.current === ws && transportIdentity(credsRef.current) === identity;
    const dispatchApp = (message: AppMessage) => {
      if (message.type === 'error' && (message.code === 'unauthorized' || message.code === 'revoked')) invalidateAuthentication();
      else handleApp(message);
    };

    const flushHello = () => {
      sendApp({ type: 'get_threads' });
      sendApp({ type: 'get_config' });
      sendApp({ type: 'get_models' });
      void getJpushRegistrationId().then((rid) => {
        if (!rid || !isCurrent()) return;
        sendApp({ type: 'register_push', vendor: 'jpush', registrationId: rid });
      });
    };

    const startHello = () => {
      if (!isCurrent()) return;
      if (lan || credsRef.current.contentKey) {
        flushHello();
        return;
      }
      if (!deviceKeysRef.current) {
        try {
          deviceKeysRef.current = generateKeyPair();
          void saveDeviceKeys(deviceKeysRef.current);
        } catch (err) {
          const raw = err instanceof Error ? err.message : '';
          setError(handshakeHint(/prng/i.test(raw) ? raw : (raw || '无法生成本地密钥')) || '无法生成本地密钥');
          return;
        }
      }
      const keys = deviceKeysRef.current;
      const hubPub = credsRef.current.hubE2ePub;
      const inner = { v: 1, devicePub: keys.publicKey, ts: Date.now() };
      const boxed = hubPub ? anonymousBox(inner, hubPub) : null;
      sendRaw({
        v: 1,
        type: 'e2e_hello',
        hubId: credsRef.current.hubId,
        payload: boxed ? { ...boxed, devicePub: keys.publicKey } : inner,
      });
    };

    ws.onopen = () => {
      if (!isCurrent()) return;
      failsRef.current = 0;
      lastTrafficRef.current = Date.now();
      setError('');
      if (lan || credsRef.current.contentKey) {
        setHandshakePhase('sync');
        connRef.current = 'connecting'; setConn('connecting');
      } else {
        setHandshakePhase('e2e');
        setConn('connecting');
      }
      startHello();
      if (lan || credsRef.current.contentKey) flushPending();
      if (!lan && !credsRef.current.contentKey) {
        setTimeout(() => {
          if (!credsRef.current.contentKey && wsRef.current === ws) startHello();
        }, 1500);
        setTimeout(() => {
          if (credsRef.current.contentKey || !isCurrent()) return;
          setError('已连上中继，但加密握手没完成。请确认电脑 Hub 在线，再扫描主机台带 hk= 的中继配对码。');
        }, 6000);
      }
      startMaintenance();
    };

    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      lastTrafficRef.current = Date.now();
      try {
        const incoming = unwrapIncoming(JSON.parse(String(event.data)));
        if (incoming.kind === 'ping') {
          sendRaw(wrapPong(credsRef.current.hubId));
          return;
        }
                if (incoming.kind === 'hub_offline') {
          connRef.current = 'hub_offline';
          for (const listener of listeners.current) listener({ type: 'transport_closed' });
          setHandshakePhase('offline');
          setConn('hub_offline');
          return;
        }
        if (incoming.kind === 'e2e_welcome') {
          const keys = deviceKeysRef.current;
          const opened = keys
            ? ((anonymousOpen(incoming.payload, keys.secretKey)
              || (credsRef.current.hubE2ePub
                ? boxOpen(incoming.payload, credsRef.current.hubE2ePub, keys.secretKey)
                : null)) as { contentKey?: string; keyId?: string; hubPub?: string } | null)
            : null;
          if (!opened?.contentKey) {
            setError(handshakeHint('握手失败'));
            return;
          }
          credsRef.current.contentKey = opened.contentKey;
          credsRef.current.keyId = opened.keyId || '';
          if (opened.hubPub) credsRef.current.hubE2ePub = opened.hubPub;
          setHandshakePhase('sync');
          connRef.current = 'connecting'; setConn('connecting');
          void saveSession({
            contentKey: opened.contentKey,
            keyId: opened.keyId || '',
            hubE2ePub: opened.hubPub || credsRef.current.hubE2ePub,
          });
          flushHello();
          flushPending();
          return;
        }
        if (incoming.kind === 'enc') {
          const opened = secretOpen(incoming.enc, credsRef.current.contentKey);
          if (opened && typeof opened === 'object') dispatchApp(opened as AppMessage);
          else {
            credsRef.current.contentKey = '';
            startHello();
          }
          return;
        }
        if (incoming.kind === 'error') {
          setError(incoming.message);
          if (incoming.code === 'e2e_required' || incoming.code === 'e2e_hello_bad') {
            credsRef.current.contentKey = '';
            void saveSession({ contentKey: '', keyId: '' });
            setError(handshakeHint('请重新扫码配对'));
          }
          if (incoming.code === 'revoked' || incoming.code === 'unauthorized') invalidateAuthentication();
          return;
        }
        if (incoming.kind === 'app') dispatchApp(incoming.message);
      } catch {
        /* ignore bad frames */
      }
    };

    ws.onerror = () => {
      /* onclose handles retry */
    };

    ws.onclose = (ev) => {
      if (!isCurrent()) return;
      wsRef.current = null;
      connRef.current = 'reconnecting';
      for (const listener of listeners.current) listener({ type: 'transport_closed' });
      clearTimers();
      if (stoppedRef.current) return;
      if (ev.code === 4403 || ev.code === 4401) {
        invalidateAuthentication();
        return;
      }
      if (backgroundRef.current) return;
      failsRef.current += 1;
      setHandshakePhase('reconnecting');
      setConn('reconnecting');
      reconnectTimer.current = setTimeout(() => {
        connect();
      }, nextBackoffMs(failsRef.current));
    };
  }, [clearTimers, disconnect, flushPending, handleApp, sendApp, sendRaw, startMaintenance, invalidateAuthentication]);

  const reconnect = useCallback(() => {
    if (authBlockedRef.current) { setError('请先重新认证，不能继续使用失效凭据。'); return; }
    stoppedRef.current = false;
    failsRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stored = await loadSession();
        await migrateComposerDraftNamespace(legacyDraftNamespace(stored), draftNamespace(stored));
        if (!alive) return;
        authBlockedRef.current = stored.authRequired === true; setAuthBlocked(stored.authRequired === true);
        setRelayUrlState(stored.relayUrl);
        setDeviceToken(stored.deviceToken);
        setHubId(stored.hubId);
        setLanUrl(stored.lanUrl);
        setMode(stored.mode || (stored.deviceToken ? 'relay' : ''));
        credsRef.current = {
          relayUrl: stored.relayUrl,
          deviceToken: stored.deviceToken,
          hubId: stored.hubId,
          hubE2ePub: stored.hubE2ePub,
          contentKey: stored.contentKey,
          keyId: stored.keyId,
          lanUrl: stored.lanUrl,
          lanPassword: stored.lanPassword,
          localTrusted: false,
          mode: stored.mode || (stored.deviceToken ? 'relay' : ''),
        };
        try {
          deviceKeysRef.current = await loadDeviceKeys();
        } catch {
          deviceKeysRef.current = null;
        }
        if (!deviceKeysRef.current) {
          try {
            deviceKeysRef.current = generateKeyPair();
            await saveDeviceKeys(deviceKeysRef.current);
          } catch {
            deviceKeysRef.current = null;
          }
        }
        const [pins, archived] = await Promise.all([loadIdSet('pins'), loadIdSet('archived')]);
        if (!alive) return;
        localPinsRef.current = pins;
        localArchivedRef.current = archived;
        setPinnedIds(pins);
        setArchivedIds(archived);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : '启动失败');
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    void (async () => {
      const implied = pageHubUrl();
      const hit = await findColocatedHub();
      if (cancelled) return;
      const url = hit?.url || implied;
      if (url) {
        credsRef.current.lanUrl = url;
        setLanUrl(url);
      }
      if (!hit) return;
      let hostname = '';
      try { hostname = new URL(hit.url).hostname; } catch { /* ignore */ }
      const trusted = isLoopbackHost(hostname);
      if (!trusted || authBlockedRef.current) return;
      credsRef.current.mode = 'lan';
      credsRef.current.localTrusted = true;
      setMode('lan');
      setLocalTrusted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (authBlockedRef.current) {
      stoppedRef.current = true; disconnect(); connRef.current = 'idle'; setConn('idle'); setHandshakePhase('idle');
      return;
    }
    if ((mode === 'lan' && lanUrl && (credsRef.current.lanPassword || credsRef.current.localTrusted)) || (deviceToken && hubId && relayUrl)) {
      stoppedRef.current = false;
      connect();
    } else {
      stoppedRef.current = true;
      disconnect();
      setHandshakePhase('idle');
      setConn('idle');
    }
    return () => {
      stoppedRef.current = true;
      disconnect();
    };
  }, [hydrated, deviceToken, hubId, relayUrl, mode, lanUrl, localTrusted, authBlocked, connect, disconnect]);

  useEffect(() => {
    const update = (bg: boolean) => {
      backgroundRef.current = bg;
      if (bg) { clearTimers(); return; }
      if (!hydrated || stoppedRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connect();
      else if (ws.readyState === WebSocket.OPEN) {
        startMaintenance();
        flushPending();
        reconcileRef.current();
      }
    };
    // Web uses visibility only: RN Web AppState also emits visibility changes.
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVisibility = () => update(document.visibilityState === 'hidden');
      document.addEventListener('visibilitychange', onVisibility);
      onVisibility();
      return () => document.removeEventListener('visibilitychange', onVisibility);
    }
    const sub = AppState.addEventListener('change', (next) => update(next !== 'active'));
    update(AppState.currentState != null && AppState.currentState !== 'active');
    return () => sub.remove();
  }, [hydrated, connect, clearTimers, flushPending, startMaintenance]);

  const setRelayUrl = useCallback(async (url: string) => {
    const next = normalizeRelayUrl(url);
    if (next !== credsRef.current.relayUrl) pendingAppRef.current.length = 0;
    setRelayUrlState(next);
    credsRef.current.relayUrl = next;
    await saveSession({ relayUrl: next });
  }, []);

  const pair = useCallback(async (codeOrUrl: string, relayOverride?: string) => {
    const parsed = extractPairFromInput(codeOrUrl);
    if (!parsed.code) throw new Error('请对准右边的出门二维码，或手输入出门码。左边是家里地址，扫了没用。');
    const nextRelay = normalizeRelayUrl(relayOverride || parsed.relayUrl || credsRef.current.relayUrl);
    if (!nextRelay) throw new Error('请先填写中继地址');
    setError('');

    const lanHint = parsed.lanUrl || credsRef.current.lanUrl;
    if (canLanProbe() && lanHint && credsRef.current.lanPassword) {
      const hit = await probeHub(lanHint, 400);
      if (hit) {
        try {
          const lan = await postLanLogin(hit.url, credsRef.current.lanPassword);
          pendingAppRef.current.length = 0;
          stoppedRef.current = false;
          setLanUrl(hit.url);
          setMode('lan');
          credsRef.current.lanUrl = hit.url;
          credsRef.current.lanPassword = lan.token;
          credsRef.current.hubId = lan.hubId || credsRef.current.hubId;
          credsRef.current.mode = 'lan';
          await saveSession({ lanUrl: hit.url, lanPassword: lan.token, mode: 'lan', authRequired: false });
          authBlockedRef.current = false; setAuthBlocked(false);
          return;
        } catch {
          /* 家里口令失效就走出门中继 */
        }
      }
    }

    let result;
    try {
      result = await pairWithCode(nextRelay, parsed.code);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err || '');
      if (/too many|rate_limited|429/i.test(raw)) {
        throw new Error('尝试次数太多，请等两分钟再连，或先用手输码、先别扫。');
      }
      throw err;
    }
    const hubPub = parsed.hubE2ePub || result.hubE2ePub || credsRef.current.hubE2ePub;
    pendingAppRef.current.length = 0;
    stoppedRef.current = false;
    setRelayUrlState(nextRelay);
    setDeviceToken(result.deviceToken);
    setHubId(result.hubId);
    setMode('relay');
    credsRef.current = {
      ...credsRef.current,
      relayUrl: nextRelay,
      deviceToken: result.deviceToken,
      hubId: result.hubId,
      hubE2ePub: hubPub,
      contentKey: '',
      keyId: '',
      mode: 'relay',
    };
    if (!deviceKeysRef.current) {
      deviceKeysRef.current = generateKeyPair();
      await saveDeviceKeys(deviceKeysRef.current);
    }
    await saveSession({
      relayUrl: nextRelay,
      deviceToken: result.deviceToken,
      hubId: result.hubId,
      hubE2ePub: hubPub,
      contentKey: '',
      keyId: '',
      mode: 'relay',
      authRequired: false,
    });
    authBlockedRef.current = false; setAuthBlocked(false);
  }, []);

  const loginLan = useCallback(async (url: string, password: string) => {
    const next = normalizeHubUrl(url);
    const result = await postLanLogin(next, password);
    pendingAppRef.current.length = 0;
    stoppedRef.current = false;
    setLanUrl(next);
    setMode('lan');
    credsRef.current.lanUrl = next;
    credsRef.current.lanPassword = result.token;
    credsRef.current.localTrusted = false;
    credsRef.current.hubId = result.hubId || '';
    setHubId(result.hubId || '');
    credsRef.current.mode = 'lan';
    setLocalTrusted(false);
    await migrateComposerDraftNamespace(legacyDraftNamespace({ mode: 'lan', lanUrl: next }), draftNamespace(credsRef.current));
    await saveSession({ lanUrl: next, lanPassword: result.token, hubId: result.hubId || '', mode: 'lan', authRequired: false });
    authBlockedRef.current = false; setAuthBlocked(false);
  }, []);

  const logout = useCallback(async (options?: { localOnly?: boolean }) => {
    const creds = { ...credsRef.current };
    if (!options?.localOnly) {
      if (creds.mode === 'lan') await logoutLan(creds.lanUrl, creds.lanPassword);
      else await revokeDevice(creds.relayUrl, creds.deviceToken);
    }
    stoppedRef.current = true;
    pendingAppRef.current.length = 0;
    disconnect();
    setDeviceToken('');
    setHubId('');
    setLanUrl('');
    setMode('');
    setLocalTrusted(false);
    credsRef.current.lanUrl = '';
    credsRef.current.lanPassword = '';
    credsRef.current.localTrusted = false;
    credsRef.current.mode = '';
    setFiles({}); setTree({ cwd: '', rootName: '', tree: [] }); setArtifacts([]); setWorkspaceHits([]); setSearchHits([]); setFailedSends([]); setOutgoing(null); setLocalMessages([]); lastOutgoingRef.current = null;
    setThreads([]);
    setProjects([]);
    setHistories({});
    setApprovals({});
    setLoadingOlder({});
    loadingOlderRef.current.clear();
    for (const timer of loadingOlderTimers.current.values()) clearTimeout(timer);
    loadingOlderTimers.current.clear();
    setLoadingHistory({});
    loadingHistoryRef.current.clear();
    for (const timer of loadingHistoryTimers.current.values()) clearTimeout(timer);
    loadingHistoryTimers.current.clear();
    setHandshakePhase('idle');
    setConn('idle');
    credsRef.current.deviceToken = '';
    credsRef.current.hubId = '';
    await saveSession({ deviceToken: '', hubId: '' });
    const keepRelay = credsRef.current.relayUrl;
    await clearSession();
    if (keepRelay) {
      await saveSession({ relayUrl: keepRelay });
      setRelayUrlState(keepRelay);
    }
  }, [disconnect]);

  const openThread = useCallback((threadId: string) => {
    if (currentThreadRef.current !== threadId) {
      setSearchHits([]); setWorkspaceHits([]); setArtifacts([]); setRecentDocuments([]); setFiles({}); setTree({ cwd: '', rootName: '', tree: [] });
      setArtifactScope(''); setArtifactTurnId(''); setArtifactCoverage(null);
    }
    currentThreadRef.current = threadId;
    setHistories(prev => prev[threadId] ? prev : { ...prev, [threadId]: emptyHistory() });
    setLoadingHistory(prev => ({ ...prev, [threadId]: true }));
    if (!sendApp({ type: 'get_thread_history', threadId })) setLoadingHistory(prev => ({ ...prev, [threadId]: false }));
  }, [sendApp]);

  const loadOlderHistory = useCallback(
    (threadId: string) => {
      if (!threadId || loadingOlderRef.current.has(threadId)) return;
      loadingOlderRef.current.add(threadId);
      setLoadingOlder((prev) => (prev[threadId] ? prev : { ...prev, [threadId]: true }));
      const sent = sendApp({ type: 'get_thread_history', threadId, all: true, limit: Math.max(2000, (histories[threadId]?.items.length || 0) + 2000) });
      if (!sent) {
        loadingOlderRef.current.delete(threadId);
        setLoadingOlder((prev) => {
          if (!prev[threadId]) return prev;
          const next = { ...prev };
          delete next[threadId];
          return next;
        });
        setError('未连接，没法加载更早的历史');
        return;
      }
      const prevTimer = loadingOlderTimers.current.get(threadId);
      if (prevTimer) clearTimeout(prevTimer);
      loadingOlderTimers.current.set(
        threadId,
        setTimeout(() => {
          if (!loadingOlderRef.current.has(threadId)) return;
          loadingOlderRef.current.delete(threadId);
          loadingOlderTimers.current.delete(threadId);
          setLoadingOlder((prev) => {
            if (!prev[threadId]) return prev;
            const next = { ...prev };
            delete next[threadId];
            return next;
          });
          setError('加载更早历史超时，点一下再试');
        }, 25000),
      );
    },
    [sendApp, histories],
  );

  const createThread = useCallback(
    (targetCwd?: string, title = '新聊天') => {
      if (connRef.current === 'hub_offline') {
        setError('电脑休眠或 Hub 没开。电脑醒了才能新建会话。');
        return;
      }
      sendApp({ type: 'create_thread', targetCwd: targetCwd || '', title: title || '新聊天' });
    },
    [sendApp],
  );

  const acceptApp = useCallback((msg: AppMessage) => {
    if (connRef.current !== 'connected' || lastOutgoingRef.current) return false;
    return sendApp(msg);
  }, [sendApp]);

  const submitReliable = useCallback((outgoingSend: OutgoingSend) => {
    if (connRef.current !== 'connected' || lastOutgoingRef.current || !credsRef.current.hubId) { setError('连接尚未就绪，未发送'); return false; }
    const identity = transportIdentity(credsRef.current);
    const namespace = draftNamespace(credsRef.current);
    const pending = { ...outgoingSend, pendingNamespace: namespace, deliveryStatus: 'pending' as const };
    lastOutgoingRef.current = pending; setOutgoing(pending);
    if (pending.kind === 'message') setLocalMessages(prev => {
      const existing = prev.find(row => row.id === pending.id);
      return existing ? prev.map(row => row.id === pending.id ? { ...row, status: 'pending' } : row)
        : [...prev, createLocalMessage(pending, historyRef.current[pending.threadId])];
    });
    // Returning true means accepted locally, NOT dispatched or acknowledged.
    void savePendingCommand({ namespace, requestId: pending.id, clientUserMessageId: pending.clientUserMessageId || pending.id, threadId: pending.threadId, createdAt: Date.now() }).then(() => {
      if (!mountedRef.current) return;
      if (identity !== transportIdentity(credsRef.current) || namespace !== draftNamespace(credsRef.current)) return;
      // A deadline/teardown while storage was pending must never dispatch later.
      if (lastOutgoingRef.current?.id !== pending.id) return;
      if (!stoppedRef.current && connRef.current === 'connected' && sendApp(retryPayload(pending))) return;
      lastOutgoingRef.current = null; setOutgoing(null);
      uncertainRef.current.set(pending.id, pending);
      setFailedSends(prev => [...removeFailedSend(prev, pending.id), { ...pending, deliveryStatus: 'uncertain', error: '请求已保存在本地，但连接已变化；只核对原请求，不自动发送。' }]);
    }).catch(() => {
      if (!mountedRef.current || identity !== transportIdentity(credsRef.current)) return;
      if (lastOutgoingRef.current?.id === pending.id) { lastOutgoingRef.current = null; setOutgoing(null); }
      uncertainRef.current.delete(pending.id);
      setFailedSends(prev => [...removeFailedSend(prev, pending.id), { ...pending, deliveryStatus: 'failed', error: '无法持久保存发送记录，消息没有发送；请检查存储后重试。' }]);
      setError('发送记录保存失败，未发送消息。');
    });
    return true;
  }, [sendApp]);

  const sendComposer = useCallback(
    (threadId: string, text: string, working: boolean, input?: unknown[], mode?: 'plan' | 'review') => {
      const trimmed = text.trim();
      if (!trimmed && !input?.length) return false;
      if (approvals[threadId] || isQuotaExhausted(quotaRef.current)) { setError('请先处理审批或等待额度恢复'); return false; }
      if (connRef.current === 'hub_offline') {
        setError('电脑休眠或 Hub 没开。电脑醒了才能发。');
        return false;
      }
      const sendId = nextFailedId();
      const outgoingSend: OutgoingSend = {
        id: sendId,
        clientUserMessageId: sendId,
        mode,
        deliveryStatus: 'pending',
        draftKey: scopedDraftKey(threadId, draftNamespace(credsRef.current)),
        threadId,
        text: trimmed,
        input,
        working,
        kind: 'message',
      };
      return submitReliable(outgoingSend);
    },
    [submitReliable, approvals],
  );

  const requestTree = useCallback(
    (threadId: string, cwd?: string, dirPath?: string) => {
      sendApp({ type: 'get_workspace_tree', threadId, cwd: cwd || '', path: dirPath || cwd || '' });
    },
    [sendApp],
  );

  const beginUpload = useCallback((threadId: string, name: string, image = false) => {
    const taskId = nextFailedId();
    uploadRef.current.set(taskId, { taskId, threadId, draftKey: scopedDraftKey(threadId, draftNamespace(credsRef.current)), identity: transportIdentity(credsRef.current), name, image, status: 'reading' }); publishUploads(); return taskId;
  }, [publishUploads]);
  const removeUpload = useCallback((taskId: string) => {
    const task = uploadRef.current.get(taskId);
    if (task?.path && task.status !== 'success') void removeComposerAttachment(task.draftKey || scopedDraftKey(task.threadId, draftNamespace(credsRef.current)), taskId).catch(() => setError('附件移除未保存，请检查原草稿'));
    uploadRef.current.delete(taskId); uploadPayloads.current.delete(taskId);
    const timer = uploadTimers.current.get(taskId); if (timer) clearTimeout(timer); uploadTimers.current.delete(taskId); publishUploads();
  }, [publishUploads]);
  const uploadFile = useCallback((threadId: string, name: string, base64: string, mime?: string, existingId?: string) => {
    const taskId = existingId || beginUpload(threadId, name, (mime || '').startsWith('image/'));
    const task = uploadRef.current.get(taskId); if (!task || task.threadId !== threadId) return;
    if (task.identity !== transportIdentity(credsRef.current)) { failUpload(taskId, '连接身份已变化，请重新选择附件'); return; }
    uploadPayloads.current.set(taskId, { base64, mime });
    if (connRef.current !== 'connected') { failUpload(taskId, '未连接，请连接后手动重试'); return; }
    const size = decodedBase64Size(base64); const lan = credsRef.current.mode === 'lan';
    if (size > (lan ? 20 * 1024 * 1024 : WS_UPLOAD_LIMIT)) { failUpload(taskId, lan ? '文件超过 20MB' : '中继附件上限 4MB'); return; }
    uploadRef.current.set(taskId, { ...task, status: 'uploading', error: undefined }); publishUploads();
    uploadTimers.current.set(taskId, setTimeout(() => failUpload(taskId, '上传超时，请手动重试'), 60000));
    if (lan && size > 512 * 1024) {
      void uploadLan(credsRef.current.lanUrl, credsRef.current.lanPassword, name, base64, mime)
        .then(result => finishUpload(taskId, result.path)).catch(err => finishUpload(taskId, '', err instanceof Error ? err.message : '上传失败'));
    } else if (!sendApp({ type: 'upload_file', requestId: taskId, taskId, threadId, name, mime: mime || '', encoding: 'base64', content: base64 })) failUpload(taskId, '未连接，请手动重试');
  }, [beginUpload, failUpload, finishUpload, publishUploads, sendApp]);
  const retryUpload = useCallback((taskId: string) => {
    const task = uploadRef.current.get(taskId); const payload = uploadPayloads.current.get(taskId);
    if (!task || task.status !== 'error') return;
    if (task.path && task.identity === transportIdentity(credsRef.current)) { uploadRef.current.set(taskId, { ...task, status: 'uploading' }); finishUpload(taskId, task.path); return; }
    if (!payload) { failUpload(taskId, '读取未完成，请移除后重新选择文件'); return; }
    if (task.identity !== transportIdentity(credsRef.current)) { failUpload(taskId, '身份已变化，请重新选择附件'); return; }
    removeUpload(taskId); const nextId = beginUpload(task.threadId, task.name, task.image);
    uploadFile(task.threadId, task.name, payload.base64, payload.mime, nextId);
  }, [beginUpload, failUpload, finishUpload, removeUpload, uploadFile]);

  const requestFile = useCallback(
    (threadId: string, filePath: string) => {
      sendApp({ type: 'get_file', threadId, path: filePath });
    },
    [sendApp],
  );

  const requestSkills = useCallback((cwd?: string) => {
    sendApp({ type: 'get_skills', cwd: cwd || '' });
  }, [sendApp]);

  const setSkillEnabled = useCallback((skill: { path?: string; name?: string; enabled: boolean }, cwd?: string) => {
    sendApp({
      type: 'set_skill',
      path: skill.path || '',
      name: skill.name || '',
      enabled: skill.enabled,
      cwd: cwd || '',
    });
  }, [sendApp]);

  const requestMcp = useCallback(() => {
    sendApp({ type: 'get_mcp' });
  }, [sendApp]);

  const reloadMcp = useCallback(() => {
    sendApp({ type: 'reload_mcp' });
  }, [sendApp]);

  const requestPlugins = useCallback(() => {
    sendApp({ type: 'get_plugins' });
  }, [sendApp]);

  const setPluginEnabled = useCallback((id: string, enabled: boolean) => {
    sendApp({ type: 'set_plugin', id, enabled });
  }, [sendApp]);

  const getGoal = useCallback((id: string) => {
    if (!id) return;
    sendApp({ type: 'get_goal', threadId: id });
  }, [sendApp]);

  const setGoal = useCallback((id: string, objective: string) => {
    if (!id) return;
    setGoalState({ threadId: id, objective: String(objective || '') });
    sendApp({ type: 'set_goal', threadId: id, objective });
  }, [sendApp]);

  const updateConfig = useCallback(
    (key: string, value: string) => {
      const next = String(value || '').trim();
      if (!key || !next) return;
      // Hub-global configuration; only config_data acknowledges the applied value.
      if (!sendApp({ type: 'update_config', key, value: next })) {
        setError('未连接，改不了设置');
      }
    },
    [sendApp],
  );

  const renameThread = useCallback(
    (id: string, title: string) => {
      const next = title.trim();
      if (!id || !next) return;
      sendApp({ type: 'rename_thread', threadId: id, title: next });
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title: next } : t)));
    },
    [sendApp],
  );

  const togglePin = useCallback((id: string, kind: 'thread' | 'project' = 'thread') => {
    if (!id) return;
    if (kind === 'project') {
      setProjects((prev) => {
        const current = prev.find((p) => p.id === id || p.name === id);
        const nextPinned = !current?.isPinned;
        sendApp({ type: 'pin_item', kind: 'project', id: current?.id || id, pinned: nextPinned });
        setFeedback(nextPinned ? '已记下置顶，电脑空闲时写入桌面。' : '已记下取消置顶，电脑空闲时写入桌面。');
        return prev.map((p) => ((p.id === id || p.name === id) ? { ...p, isPinned: nextPinned } : p));
      });
      return;
    }
    setPinnedIds((ids) => {
      const nextPinned = !ids.includes(id);
      sendApp({ type: 'pin_item', kind: 'thread', id, pinned: nextPinned });
      setFeedback(nextPinned ? '已记下置顶，电脑空闲时写入桌面。' : '已记下取消置顶，电脑空闲时写入桌面。');
      const next = nextPinned ? [id, ...ids.filter((x) => x !== id)] : ids.filter((x) => x !== id);
      void saveIdSet('pins', next);
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, isPinned: nextPinned } : t)));
      setProjects((prev) => prev.map((p) => ({
        ...p,
        threads: p.threads.map((t) => (t.id === id ? { ...t, isPinned: nextPinned } : t)),
      })));
      return next;
    });
  }, [sendApp]);

  const archiveThread = useCallback((id: string) => {
    if (!id) return;
    sendApp({ type: 'archive_item', id, archived: true });
    setFeedback('已记下归档，电脑空闲时写入桌面。');
    setThreads((prev) => {
      const hit = prev.find((t) => t.id === id);
      if (hit) {
        setArchivedThreads((rows) => (rows.some((t) => t.id === id) ? rows : [hit, ...rows]).slice(0, 40));
      }
      return prev.filter((t) => t.id !== id);
    });
    setArchivedIds((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      void saveIdSet('archived', next);
      return next;
    });
    setProjects((prev) => prev.map((p) => ({
      ...p,
      threads: p.threads.filter((t) => t.id !== id),
    })));
  }, [sendApp]);

  const unarchiveThread = useCallback((id: string) => {
    if (!id) return;
    sendApp({ type: 'archive_item', id, archived: false });
    setFeedback('已记下取消归档，电脑空闲时写入桌面。');
    setArchivedIds((prev) => {
      const next = prev.filter((x) => x !== id);
      void saveIdSet('archived', next);
      return next;
    });
    setArchivedThreads((prev) => {
      const hit = prev.find((t) => t.id === id);
      if (hit) {
        setThreads((rows) => (rows.some((t) => t.id === id) ? rows : [hit, ...rows]));
      }
      return prev.filter((t) => t.id !== id);
    });
  }, [sendApp]);

  const refreshThreads = useCallback(() => {
    sendApp({ type: 'get_threads' });
  }, [sendApp]);

  const searchThread = useCallback((threadId: string, q: string) => {
    setSearchHits([]);
    sendApp({ type: 'search_thread', threadId, q });
  }, [sendApp]);

  const runCommand = useCallback(
    (threadId: string, command: string) => {
      setCommandOut('');
      lastCommandRef.current = command;
      const sendId = nextFailedId();
      if (!acceptApp({ type: 'run_command', requestId: sendId, threadId, command })) {
        setError('未连接，命令没发出去');
        return false;
      }
      const outgoingCmd: OutgoingSend = {
        id: sendId,
        draftKey: scopedDraftKey(threadId, draftNamespace(credsRef.current)),
        threadId,
        text: command,
        working: false,
        kind: 'command',
      };
      lastOutgoingRef.current = outgoingCmd;
      setOutgoing(outgoingCmd);
      return true;
    },
    [acceptApp],
  );

  const retryFailedSend = useCallback(
    (id: string) => {
      const item = failedSends.find((row) => row.id === id);
      if (!item) return false;
      // Unknown receipt can only be queried. A new requestId could execute twice.
      if (item.deliveryStatus === 'uncertain' || item.deliveryStatus === 'pending' || item.deliveryStatus === 'running') {
        sendApp({ type: 'query_command', requestId: item.id });
        setFeedback('正在核对原请求，没有重复发送。'); return false;
      }
      if (item.restored || item.kind === 'command' || capabilitiesRef.current.query_command !== true) {
        setError('当前命令不支持安全去重重试，请先核对结果。'); return false;
      }
      const ok = submitReliable(item);
      if (ok) setFailedSends(prev => removeFailedSend(prev, id));
      return ok;
    },
    [failedSends, submitReliable, sendApp],
  );

  const clearingWriterLocks = useRef(new Set<string>());
  const forceClearFailedSendLock = useCallback(async (id: string, threadId: string, options?: { acknowledgeHolderAlive?: boolean }) => {
    const item = failedSends.find((row) => row.id === id);
    if (!item || !writerLockErrorCode(threadId, item)) throw new Error('当前会话没有匹配的写入锁错误');
    if (clearingWriterLocks.current.has(threadId)) throw new Error('当前会话正在删锁，请勿重复操作');
    clearingWriterLocks.current.add(threadId);
    try {
      const creds = credsRef.current;
      const result = await forceClearThreadWriterLock(creds.mode, creds.lanUrl, creds.lanPassword, threadId, true, options);
      // Keep failed sends and global errors intact: clearing a file is not send success or writer release.
      return result.cleared;
    } finally {
      clearingWriterLocks.current.delete(threadId);
    }
  }, [failedSends]);

  // 手动删除失败卡片：只移除记录，不重试、不恢复草稿；failedSends 无持久化，删除后不会复活。
  const dismissFailedSend = useCallback((id: string) => {
    setFailedSends((prev) => removeFailedSend(prev, id));
    setLocalMessages(prev => prev.filter(row => row.id !== id || row.status === 'succeeded'));
  }, []);

  const searchWorkspace = useCallback((threadId: string, cwd: string, q: string) => {
    sendApp({ type: 'search_workspace', threadId, cwd, q });
  }, [sendApp]);

  const stopCommand = useCallback((threadId: string) => {
    sendApp({ type: 'stop_command', threadId });
  }, [sendApp]);

  const listArtifacts = useCallback((threadId: string, cwd?: string) => {
    sendApp({ type: 'list_artifacts', threadId, cwd: cwd || '' });
  }, [sendApp]);

  const queueMention = useCallback((filePath: string) => {
    const next = String(filePath || '').trim();
    if (!next) return;
    setMention({ name: next.split(/[\\/]/).pop() || 'file', path: next });
  }, []);

  const clearMention = useCallback(() => setMention(null), []);

  const clearUpload = useCallback(() => setLastUpload(null), []);

  const gitStatus = useCallback(
    (threadId: string) => {
      gitThreadRef.current = threadId;
      setGit(prev => prev?.threadId === threadId ? prev : null);
      if (capabilitiesRef.current.get_git_status === true) sendApp({ type: 'get_git_status', threadId });
      else setError('当前 Hub 不支持只读 Git 状态接口');
    },
    [sendApp],
  );

  const gitDiff = useCallback((threadId: string) => {
    gitThreadRef.current = threadId;
    setGit(prev => prev?.threadId === threadId ? prev : null);
    if (capabilitiesRef.current.get_git_diff === true) sendApp({ type: 'get_git_diff', threadId });
    else setError('当前 Hub 不支持只读 Git 差异接口');
  }, [sendApp]);

  const openPty = useCallback((threadId: string, cols = 80, rows = 24) => {
    setPtyError('');
    sendApp({ type: 'pty_open', threadId, cols, rows });
  }, [sendApp]);

  const writePty = useCallback((threadId: string, data: string) => {
    sendApp({ type: 'pty_input', threadId, data });
  }, [sendApp]);

  const resizePty = useCallback((threadId: string, cols: number, rows: number) => {
    sendApp({ type: 'pty_resize', threadId, cols, rows });
  }, [sendApp]);

  const closePty = useCallback((threadId: string) => {
    sendApp({ type: 'pty_close', threadId });
  }, [sendApp]);

  const sendStop = useCallback(
    (threadId: string) => {
      sendApp({ type: 'send_stop', threadId });
    },
    [sendApp],
  );

  const sendApproval = useCallback(
    (threadId: string, decision: Decision) => {
      const approval = approvals[threadId] || approvalFromHistory(threadId, histories[threadId]);
      if (!approval?.requestId) {
        setError('没有可提交的审批，请点刷新后再试');
        return;
      }
      const ids = collectApprovalIds(approval);
      const payload: AppMessage = {
        type: 'send_approval',
        threadId,
        requestId: approval.requestId,
        decision,
      };
      if (approval.kind) payload.kind = approval.kind;
      if (approval.ids?.length) payload.ids = approval.ids;
      if (!sendApp(payload)) {
        setError('未连接，审批没发出去');
        return;
      }
      // Sending is not resolution: keep the request visible until server confirmation.
      const lock = (histories[threadId]?.lockHolder) || '';
      if (lock === 'desktop') {
        setFeedback('审批已发出，等待桌面执行端确认。');
      } else if (lock === 'desktop-stale') {
        setFeedback('审批已发出；写锁状态尚未确认，不能保证接管。');
      } else if (lock === 'hub') {
        setFeedback('审批已发出，将由 Hub 处理。');
      } else {
        setFeedback('审批已发出，等待执行端确认。');
      }
    },
    [approvals, histories, sendApp, dismissApprovalLocal],
  );

  const feature = useCallback((msg: AppMessage) => {
    if (capabilitiesRef.current[msg.type] !== true) { setError(`当前 Hub 不支持 ${msg.type}`); return false; }
    return sendApp(msg);
  }, [sendApp]);
  const getExecutionState = useCallback((threadId: string) => feature({ type: 'get_execution_state', threadId }), [feature]);
  const handoffThread = useCallback((threadId: string) => feature({ type: 'handoff_thread', threadId, requestId: nextFailedId() }), [feature]);
  const listQueue = useCallback((threadId: string) => feature({ type: 'list_queue', threadId }), [feature]);
  const queueMessage = useCallback((threadId: string, text: string, input?: unknown[]) => {
    const requestId = nextFailedId();
    return feature({ type: 'queue_message', threadId, text, input, requestId, clientUserMessageId: requestId });
  }, [feature]);
  const cancelQueuedMessage = useCallback((threadId: string, queueId: string) => feature({ type: 'cancel_queued_message', threadId, queueId }), [feature]);
  const queryCommand = useCallback((requestId: string) => feature({ type: 'query_command', requestId }), [feature]);
  const getDraft = useCallback((threadId: string) => {
    const ok = feature({ type: 'get_draft', threadId });
    draftSyncRef.current = { ...draftSyncRef.current, [threadId]: { ...draftSyncRef.current[threadId], status: ok ? 'loading' : 'error' } };
    setDraftSync(draftSyncRef.current); return ok;
  }, [feature]);
  const saveDraft = useCallback((threadId: string, text: string, attachments: ComposerPending[]) => {
    const previous = draftSyncRef.current[threadId];
    const local = { text, attachments };
    if (previous?.status === 'saving' || previous?.status === 'conflict' || !previous?.remote) {
      draftSyncRef.current = { ...draftSyncRef.current, [threadId]: { ...previous, local, status: previous?.status || 'loading' } };
      setDraftSync(draftSyncRef.current);
      if (!previous?.remote) feature({ type: 'get_draft', threadId });
      return false;
    }
    const ok = feature({ type: 'save_draft', threadId, expectedVersion: previous.remote.version, ...local });
    draftSyncRef.current = { ...draftSyncRef.current, [threadId]: { ...previous, local, status: ok ? 'saving' : 'error' } };
    setDraftSync(draftSyncRef.current); return ok;
  }, [feature]);
  const resolveDraftConflict = useCallback(async (threadId: string, choice: 'local' | 'remote') => {
    const state = draftSyncRef.current[threadId];
    if (!state?.remote) return false;
    if (choice === 'local') {
      if (!state.local) return false;
      draftSyncRef.current = { ...draftSyncRef.current, [threadId]: { ...state, status: 'synced' } };
      return saveDraft(threadId, state.local.text, state.local.attachments);
    }
    const identity = transportIdentity(credsRef.current);
    await saveComposerDraft(scopedDraftKey(threadId, draftNamespace(credsRef.current)), { text: state.remote.text, pending: state.remote.attachments, updatedAt: Date.now() });
    if (identity !== transportIdentity(credsRef.current)) return false;
    const next: DraftSyncState = { status: 'synced', remote: state.remote, local: { text: state.remote.text, attachments: state.remote.attachments } };
    draftSyncRef.current = { ...draftSyncRef.current, [threadId]: next }; setDraftSync(draftSyncRef.current);
    for (const listener of listeners.current) listener({ type: 'draft_applied', threadId, draft: state.remote });
    return true;
  }, [saveDraft]);
  const respondUserInput = useCallback((requestId: string, answers: UserInputAnswers) => {
    const pending = userInputs[requestId];
    if (!pending) return false;
    return feature({ type: 'send_user_input', requestId: nextFailedId(), threadId: pending.threadId, inputRequestId: requestId, answers: answers.answers });
  }, [feature, userInputs]);

  const value = useMemo<SessionValue>(
    () => ({
      capabilities, executionStates, queues, commands, draftSync, userInputs,
      getExecutionState, handoffThread, queueMessage, listQueue, cancelQueuedMessage, getDraft, saveDraft, resolveDraftConflict, queryCommand, respondUserInput,
      requests,
      requestState: (type, threadId, path) => requests[requestKey(type, threadId, path)],
      subscribeApp: subscribeMessages,
      diagnostics: safeConnectionDiagnostic(mode, conn, mode === 'lan' ? lanUrl : relayUrl, Object.values(requests).filter(r => r.status === 'loading').length),
      connectionIdentity: String(identityGeneration),
      draftNamespace: draftNamespace(credsRef.current),
      sendMessage: sendApp,
      subscribeMessages,
      hydrated,
      paired,
      relayUrl,
      hubId,
      lanUrl,
      mode,
      conn,
      connText,
      handshake,
      error,
      refreshThreads,
      threads,
      projects,
      feedback,
      models,
      skills,
      mcpServers,
      plugins,
      config,
      lastCreatedId,
      hostName,
      quota,
      mention,
      queueMention,
      clearMention,
      pinnedIds,
      archivedIds,
      setRelayUrl,
      pair,
      loginLan,
      logout,
      sendApp,
      createThread,
      sendComposer,
      localMessages,
      outgoing,
      failedSends,
      retryFailedSend,
      dismissFailedSend,
      forceClearFailedSendLock,
      sendStop,
      requestSkills,
      setSkillEnabled,
      requestMcp,
      reloadMcp,
      requestPlugins,
      setPluginEnabled,
      updateConfig,
      goal,
      getGoal,
      setGoal,
      renameThread,
      togglePin,
      archiveThread,
      unarchiveThread,
      archivedThreads,
      reconnect,
      clearError: () => setError(''),
      clearFeedback: () => setFeedback(''),
    }),
    [
      capabilities, executionStates, queues, commands, draftSync, userInputs,
      getExecutionState, handoffThread, queueMessage, listQueue, cancelQueuedMessage, getDraft, saveDraft, resolveDraftConflict, queryCommand, respondUserInput,
      requests, subscribeMessages, identityGeneration,
      hydrated,
      paired,
      relayUrl,
      hubId,
      lanUrl,
      mode,
      conn,
      connText,
      handshake,
      error,
      threads,
      projects,
      feedback,
      models,
      skills,
      mcpServers,
      plugins,
      config,
      lastCreatedId,
      hostName,
      quota,
      mention,
      queueMention,
      clearMention,
      pinnedIds,
      archivedIds,
      setRelayUrl,
      pair,
      loginLan,
      logout,
      sendApp,
      refreshThreads,
      createThread,
      sendComposer,
      localMessages,
      outgoing,
      failedSends,
      retryFailedSend,
      dismissFailedSend,
      forceClearFailedSendLock,
      sendStop,
      requestSkills,
      setSkillEnabled,
      requestMcp,
      reloadMcp,
      requestPlugins,
      setPluginEnabled,
      updateConfig,
      goal,
      getGoal,
      setGoal,
      renameThread,
      togglePin,
      archiveThread,
      unarchiveThread,
      archivedThreads,
      reconnect,
    ],
  );

  const historiesValue = useMemo<HistoriesValue>(
    () => ({
      histories,
      approvals,
      loadingHistory,
      loadingOlder,
      openThread,
      loadOlderHistory,
      sendApproval,
    }),
    [histories, approvals, loadingHistory, loadingOlder, openThread, loadOlderHistory, sendApproval],
  );

  const toolsValue = useMemo<ToolsValue>(
    () => ({
      commandOut,
      commandHist,
      git,
      searchHits,
      ptyChunk,
      ptyAlive,
      ptyError,
      runCommand,
      stopCommand,
      gitStatus,
      gitDiff,
      searchThread,
      openPty,
      writePty,
      resizePty,
      closePty,
    }),
    [commandOut, commandHist, git, searchHits, ptyChunk, ptyAlive, ptyError, runCommand, stopCommand, gitStatus, gitDiff, searchThread, openPty, writePty, resizePty, closePty],
  );

  const workspaceValue = useMemo<WorkspaceValue>(
    () => ({
      artifactsScope, artifactsTurnId, artifactsCoverage, uploadTasks, recentDocuments, beginUpload, failUpload, removeUpload, retryUpload,
      tree,
      files,
      workspaceHits,
      artifacts,
      lastUpload,
      requestTree,
      requestFile,
      uploadFile,
      searchWorkspace,
      listArtifacts,
      clearUpload,
    }),
    [artifactsScope, artifactsTurnId, artifactsCoverage, uploadTasks, recentDocuments, beginUpload, failUpload, removeUpload, retryUpload, tree, files, workspaceHits, artifacts, lastUpload, requestTree, requestFile, uploadFile, searchWorkspace, listArtifacts, clearUpload],
  );

  return (
    <SessionContext.Provider value={value}>
      <HistoriesContext.Provider value={historiesValue}>
        <ToolsContext.Provider value={toolsValue}>
          <WorkspaceContext.Provider value={workspaceValue}>
            {children}
          </WorkspaceContext.Provider>
        </ToolsContext.Provider>
      </HistoriesContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider missing');
  return ctx;
}

export function useHistories(): HistoriesValue {
  const ctx = useContext(HistoriesContext);
  if (!ctx) throw new Error('SessionProvider missing');
  return ctx;
}

export function useTools(): ToolsValue {
  const ctx = useContext(ToolsContext);
  if (!ctx) throw new Error('SessionProvider missing');
  return ctx;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('SessionProvider missing');
  return ctx;
}
