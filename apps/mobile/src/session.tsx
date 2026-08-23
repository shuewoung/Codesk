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
import { loginLan as postLanLogin, pairWithCode, revokeDevice } from './api';
import { canLanProbe, findColocatedHub, isLoopbackHost, normalizeHubUrl, pageHubUrl, probeHub } from './discover';
import { buildHandshake, handshakeHint, type HandshakePhase, type HandshakeView } from './handshake';
import { isQuotaError, quotaExhaustedMessage } from './quota';
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
import { clearSession, loadDeviceKeys, loadIdSet, loadSession, saveDeviceKeys, saveIdSet, saveSession } from './storage';
import {
  applyConfigPatch,
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

type OutgoingSend = Omit<FailedSend, 'error'>;

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
  const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
  if (threadId && threadId !== last.threadId) return false;
  const action = typeof msg.action === 'string' ? msg.action : '';
  if (action === 'send' || action === 'steer') return last.kind === 'message';
  if (action === 'command') return last.kind === 'command';
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
  logout: () => Promise<void>;
  sendApp: (msg: AppMessage) => boolean;
  refreshThreads: () => void;
  createThread: (targetCwd?: string, title?: string) => void;
  sendComposer: (threadId: string, text: string, working: boolean, input?: unknown[], mode?: 'plan' | 'review') => boolean;
  failedSends: FailedSend[];
  retryFailedSend: (id: string) => boolean;
  dismissFailedSend: (id: string) => void;
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
  clearError: () => void;
  clearFeedback: () => void;
};

type HistoriesValue = {
  histories: Record<string, ThreadHistory>;
  approvals: Record<string, Approval>;
  loadingOlder: Record<string, boolean>;
  openThread: (threadId: string) => void;
  loadOlderHistory: (threadId: string) => void;
  sendApproval: (threadId: string, decision: Decision) => void;
};

type ToolsValue = {
  commandOut: string;
  commandHist: { command: string; exitCode?: number | null }[];
  git: { cwd?: string; status?: string; diff?: string; log?: string; error?: string | null; files?: { path: string; status?: string; add?: number; del?: number }[] } | null;
  searchHits: { index: number; type: string; snippet: string }[];
  runCommand: (threadId: string, command: string) => boolean;
  stopCommand: (threadId: string) => void;
  gitStatus: (threadId: string) => void;
  searchThread: (threadId: string, q: string) => void;
};

type WorkspaceValue = {
  tree: { cwd: string; rootName: string; tree: TreeNode[] };
  files: Record<string, FileData>;
  workspaceHits: { name: string; path: string; dir?: string }[];
  artifacts: { name: string; path: string; ext?: string; mtimeMs?: number; size?: number }[];
  lastUpload: { path: string; name: string; error?: string | null } | null;
  requestTree: (threadId: string, cwd?: string, dirPath?: string) => void;
  requestFile: (threadId: string, path: string) => void;
  uploadFile: (threadId: string, name: string, base64: string, mime?: string) => void;
  searchWorkspace: (threadId: string, cwd: string, q: string) => void;
  listArtifacts: (threadId: string, cwd?: string) => void;
  clearUpload: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);
const HistoriesContext = createContext<HistoriesValue | null>(null);
const ToolsContext = createContext<ToolsValue | null>(null);
const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
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
  const [git, setGit] = useState<ToolsValue['git']>(null);
  const [commandOut, setCommandOut] = useState('');
  const [commandHist, setCommandHist] = useState<{ command: string; exitCode?: number | null }[]>([]);
  const [workspaceHits, setWorkspaceHits] = useState<{ name: string; path: string; dir?: string }[]>([]);
  const [artifacts, setArtifacts] = useState<{ name: string; path: string; ext?: string; mtimeMs?: number; size?: number }[]>([]);
  const [mention, setMention] = useState<{ name: string; path: string } | null>(null);
  const lastCommandRef = useRef('');
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
  const [searchHits, setSearchHits] = useState<{ index: number; type: string; snippet: string }[]>([]);
  const [mode, setMode] = useState<'' | 'relay' | 'lan'>('');
  const [lanUrl, setLanUrl] = useState('');
  const [localTrusted, setLocalTrusted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);
  const failsRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const localPinsRef = useRef<string[]>([]);
  const pinMigratedRef = useRef(false);
  const localArchivedRef = useRef<string[]>([]);
  const archiveMigratedRef = useRef(false);
  const offlineRetry = useRef<ReturnType<typeof setInterval> | null>(null);
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
  const pendingAppRef = useRef<AppMessage[]>([]);
  const lastOutgoingRef = useRef<OutgoingSend | null>(null);
  const currentThreadRef = useRef('');
  const loadingOlderRef = useRef(new Set<string>());
  const loadingOlderTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [loadingOlder, setLoadingOlder] = useState<Record<string, boolean>>({});
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

  const paired = mode === 'lan'
    ? Boolean(lanUrl && (credsRef.current.lanPassword || localTrusted))
    : Boolean(deviceToken && hubId && relayUrl);

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
    if (pingTimer.current) {
      clearInterval(pingTimer.current);
      pingTimer.current = null;
    }
    if (offlineRetry.current) {
      clearInterval(offlineRetry.current);
      offlineRetry.current = null;
    }
  }, []);

  const sendRaw = useCallback((env: Envelope) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(env));
    return true;
  }, []);

  const sendApp = useCallback(
    (msg: AppMessage) => {
      const creds = credsRef.current;
      if (creds.mode === 'lan') {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          pendingAppRef.current.push(msg);
          return false;
        }
        ws.send(JSON.stringify(msg));
        return true;
      }
      const { hubId: id, contentKey, keyId } = creds;
      if (!id) return false;
      if (!contentKey) {
        pendingAppRef.current.push(msg);
        return false;
      }
      if (!sendRaw({
        v: 1,
        type: 'fwd',
        hubId: id,
        enc: secretSeal(msg, contentKey, keyId),
      })) {
        pendingAppRef.current.push(msg);
        return false;
      }
      return true;
    },
    [sendRaw],
  );

  const handleApp = useCallback((msg: AppMessage) => {
    if (msg.type === 'ping') return;
    if (msg.type === 'thread_list') {
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
      setConn('connected');
      return;
    }
    if (msg.type === 'thread_created') {
      const id = typeof msg.threadId === 'string' ? msg.threadId : '';
      if (id) setLastCreatedId(id);
      return;
    }
    if (msg.type === 'config_data' && msg.data && typeof msg.data === 'object') {
      setConfig(msg.data as HubConfig);
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
      setArtifacts(Array.isArray(msg.files) ? msg.files as WorkspaceValue['artifacts'] : []);
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
      setLastUpload({
        path: typeof msg.path === 'string' ? msg.path : '',
        name: typeof msg.name === 'string' ? msg.name : '',
        error: typeof msg.error === 'string' ? msg.error : null,
      });
      if (typeof msg.error === 'string' && msg.error) setError(msg.error);
      return;
    }
    if (msg.type === 'search_results') {
      const rows = Array.isArray(msg.results) ? msg.results : [];
      setSearchHits(rows as { index: number; type: string; snippet: string }[]);
      if (typeof msg.error === 'string' && msg.error) setError(msg.error);
      return;
    }
    if (msg.type === 'git_status') {
      setGit({
        cwd: typeof msg.cwd === 'string' ? msg.cwd : '',
        status: typeof msg.status === 'string' ? msg.status : '',
        diff: typeof msg.diff === 'string' ? msg.diff : '',
        log: typeof msg.log === 'string' ? msg.log : '',
        error: typeof msg.error === 'string' ? msg.error : null,
        files: Array.isArray(msg.files) ? msg.files as { path: string; status?: string; add?: number; del?: number }[] : [],
      });
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
      setFiles((prev) => {
        const next: Record<string, FileData> = { ...prev };
        delete next[p]; // 重置插入顺序，保证 LRU 淘汰最旧的
        next[p] = {
          path: p,
          fileName: typeof msg.fileName === 'string' ? msg.fileName : '',
          ext: typeof msg.ext === 'string' ? msg.ext : '',
          encoding: msg.encoding === 'base64' ? 'base64' : 'utf8',
          content: typeof msg.content === 'string' ? msg.content : '',
          truncated: Boolean(msg.truncated),
          error: typeof msg.error === 'string' ? msg.error : null,
        };
        // 文件内容（含 base64）常驻内存，超出上限时淘汰最早的条目。
        const keys = Object.keys(next);
        for (let i = 0; i < keys.length - MAX_CACHED_FILES; i += 1) delete next[keys[i]];
        return next;
      });
      return;
    }
    if (msg.type === 'thread_history' || msg.type === 'thread_update') {
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
      if (!threadId) return;
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
      setHistories((prev) => {
        let merged = mergeHistory(prev[threadId], msg.data);
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
      const gone = status === 'error' && /审批|timeout|超时|没有找到|未命中/i.test(message + code);
      if (gone && threadId) {
        dismissApprovalRef.current(threadId, collectApprovalIds({
          requestId: msg.requestId == null ? '' : String(msg.requestId),
          ids: Array.isArray(msg.ids) ? msg.ids.map((v) => String(v)) : [],
        }));
      }
      const last = lastOutgoingRef.current;
      if (status === 'error') {
        const quotaHit = code === 'quota' || isQuotaError(message);
        const shown = quotaHit ? quotaExhaustedMessage(quotaRef.current, message) : (message || '操作失败');
        if (isComposerFeedback(msg, last) && last) {
          lastOutgoingRef.current = null;
          setFailedSends((prev) => [
            ...prev.filter((item) => !(item.threadId === last.threadId && item.text === last.text)),
            { ...last, error: shown },
          ]);
        }
        setError(shown);
      } else {
        if (isFinalSendSuccess(msg, last)) lastOutgoingRef.current = null;
        if (/pending|空闲|sidecar|物化/i.test(message)) {
          setFeedback(message || '已记下，等电脑空闲再写入桌面。');
        } else if (message) setFeedback(message);
      }
    }
  }, [sendApp]);

  const disconnect = useCallback(() => {
    clearTimers();
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

  const connect = useCallback(() => {
    const creds = credsRef.current;
    const lan = creds.mode === 'lan';
    if (stoppedRef.current) return;
    if (lan) {
      if (!creds.lanUrl) return;
      if (!creds.lanPassword && !creds.localTrusted) return;
    } else if (!creds.relayUrl || !creds.deviceToken || !creds.hubId) {
      return;
    }
    disconnect();
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

    const flushHello = () => {
      sendApp({ type: 'get_threads' });
      sendApp({ type: 'get_config' });
      sendApp({ type: 'get_models' });
      void getJpushRegistrationId().then((rid) => {
        if (!rid) return;
        sendApp({ type: 'register_push', vendor: 'jpush', registrationId: rid });
      });
    };

    const startHello = () => {
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
      failsRef.current = 0;
      setError('');
      if (lan || credsRef.current.contentKey) {
        setHandshakePhase('sync');
        setConn('connected');
      } else {
        setHandshakePhase('e2e');
        setConn('connecting');
      }
      startHello();
      if (lan) {
        const queued = pendingAppRef.current.splice(0);
        for (const item of queued) sendApp(item);
      }
      if (!lan && !credsRef.current.contentKey) {
        setTimeout(() => {
          if (!credsRef.current.contentKey && wsRef.current === ws) startHello();
        }, 1500);
        setTimeout(() => {
          if (credsRef.current.contentKey || wsRef.current !== ws) return;
          setError('已连上中继，但加密握手没完成。请安装新版 APK，退出后再扫主机台右边带 hk= 的出门码。');
        }, 6000);
      }
      pingTimer.current = setInterval(() => {
        if (credsRef.current.mode === 'lan') {
          const sock = wsRef.current;
          if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }));
        } else {
          sendRaw(wrapPing());
        }
      }, 20000);
      offlineRetry.current = setInterval(() => {
        if (connRef.current === 'hub_offline') sendApp({ type: 'get_threads' });
      }, 8000);
    };

    ws.onmessage = (event) => {
      try {
        const incoming = unwrapIncoming(JSON.parse(String(event.data)));
        if (incoming.kind === 'ping') {
          sendRaw(wrapPong(credsRef.current.hubId));
          return;
        }
                if (incoming.kind === 'hub_offline') {
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
          setConn('connected');
          void saveSession({
            contentKey: opened.contentKey,
            keyId: opened.keyId || '',
            hubE2ePub: opened.hubPub || credsRef.current.hubE2ePub,
          });
          const queued = pendingAppRef.current.splice(0);
          flushHello();
          for (const item of queued) sendApp(item);
          return;
        }
        if (incoming.kind === 'enc') {
          const opened = secretOpen(incoming.enc, credsRef.current.contentKey);
          if (opened && typeof opened === 'object') handleApp(opened as AppMessage);
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
          if (incoming.code === 'revoked' || incoming.code === 'unauthorized') {
            stoppedRef.current = true;
            disconnect();
            setDeviceToken('');
            setHubId('');
            void saveSession({ deviceToken: '', hubId: '' });
            setHandshakePhase('idle');
            setConn('idle');
          }
          return;
        }
        if (incoming.kind === 'app') handleApp(incoming.message);
      } catch {
        /* ignore bad frames */
      }
    };

    ws.onerror = () => {
      /* onclose handles retry */
    };

    ws.onclose = (ev) => {
      if (wsRef.current === ws) wsRef.current = null;
      clearTimers();
      if (stoppedRef.current) return;
      if (backgroundRef.current) return;
      if (ev.code === 4403 || ev.code === 4401) {
        setError('设备已失效，请重新配对');
        setDeviceToken('');
        setHubId('');
        void saveSession({ deviceToken: '', hubId: '' });
        setHandshakePhase('idle');
        setConn('idle');
        return;
      }
      failsRef.current += 1;
      setHandshakePhase('reconnecting');
      setConn('reconnecting');
      reconnectTimer.current = setTimeout(() => {
        connect();
      }, nextBackoffMs(failsRef.current));
    };
  }, [clearTimers, disconnect, handleApp, sendApp, sendRaw]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stored = await loadSession();
        if (!alive) return;
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
      if (!trusted) return;
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
  }, [hydrated, deviceToken, hubId, relayUrl, mode, lanUrl, localTrusted, connect, disconnect]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const bg = next !== 'active';
      backgroundRef.current = bg;
      if (bg) {
        clearTimers();
        return;
      }
      if (!hydrated) return;
      const ready = (mode === 'lan' && lanUrl && (credsRef.current.lanPassword || credsRef.current.localTrusted))
        || Boolean(deviceToken && hubId && relayUrl);
      if (!ready) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    });
    return () => sub.remove();
  }, [hydrated, deviceToken, hubId, relayUrl, mode, lanUrl, localTrusted, connect, clearTimers]);

  const setRelayUrl = useCallback(async (url: string) => {
    const next = normalizeRelayUrl(url);
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
          stoppedRef.current = false;
          setLanUrl(hit.url);
          setMode('lan');
          credsRef.current.lanUrl = hit.url;
          credsRef.current.lanPassword = lan.token;
          credsRef.current.hubId = lan.hubId || credsRef.current.hubId;
          credsRef.current.mode = 'lan';
          await saveSession({ lanUrl: hit.url, lanPassword: lan.token, mode: 'lan' });
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
    });
  }, []);

  const loginLan = useCallback(async (url: string, password: string) => {
    const next = normalizeHubUrl(url);
    const result = await postLanLogin(next, password);
    stoppedRef.current = false;
    setLanUrl(next);
    setMode('lan');
    credsRef.current.lanUrl = next;
    credsRef.current.lanPassword = result.token;
    credsRef.current.localTrusted = false;
    credsRef.current.hubId = result.hubId || credsRef.current.hubId;
    credsRef.current.mode = 'lan';
    setLocalTrusted(false);
    await saveSession({ lanUrl: next, lanPassword: result.token, mode: 'lan' });
  }, []);

  const logout = useCallback(async () => {
    stoppedRef.current = true;
    const { relayUrl: url, deviceToken: token } = credsRef.current;
    disconnect();
    try {
      await revokeDevice(url, token);
    } catch {
      /* still clear local */
    }
    setDeviceToken('');
    setHubId('');
    setLanUrl('');
    setMode('');
    setLocalTrusted(false);
    credsRef.current.lanUrl = '';
    credsRef.current.lanPassword = '';
    credsRef.current.localTrusted = false;
    credsRef.current.mode = '';
    setThreads([]);
    setProjects([]);
    setHistories({});
    setApprovals({});
    setLoadingOlder({});
    loadingOlderRef.current.clear();
    for (const timer of loadingOlderTimers.current.values()) clearTimeout(timer);
    loadingOlderTimers.current.clear();
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

  const openThread = useCallback(
    (threadId: string) => {
      currentThreadRef.current = threadId;
      setHistories((prev) => (prev[threadId] ? prev : { ...prev, [threadId]: emptyHistory() }));
      sendApp({ type: 'get_thread_history', threadId });
    },
    [sendApp],
  );

  const loadOlderHistory = useCallback(
    (threadId: string) => {
      if (!threadId || loadingOlderRef.current.has(threadId)) return;
      loadingOlderRef.current.add(threadId);
      setLoadingOlder((prev) => (prev[threadId] ? prev : { ...prev, [threadId]: true }));
      const sent = sendApp({ type: 'get_thread_history', threadId, all: true });
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
    [sendApp],
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

  const acceptApp = useCallback(
    (msg: AppMessage) => {
      const before = pendingAppRef.current.length;
      if (sendApp(msg)) return true;
      return pendingAppRef.current.length > before;
    },
    [sendApp],
  );

  const sendComposer = useCallback(
    (threadId: string, text: string, working: boolean, input?: unknown[], mode?: 'plan' | 'review') => {
      const trimmed = text.trim();
      if (!trimmed && !input?.length) return false;
      if (connRef.current === 'hub_offline') {
        setError('电脑休眠或 Hub 没开。电脑醒了才能发。');
        return false;
      }
      if (!acceptApp({
        type: working ? 'send_steer' : 'send_message',
        threadId,
        text: trimmed,
        input: input || undefined,
        mode: mode || undefined,
      })) {
        setError('未连接，没发出去');
        return false;
      }
      lastOutgoingRef.current = {
        id: nextFailedId(),
        threadId,
        text: trimmed,
        input,
        working,
        kind: 'message',
      };
      return true;
    },
    [acceptApp],
  );

  const requestTree = useCallback(
    (threadId: string, cwd?: string, dirPath?: string) => {
      sendApp({ type: 'get_workspace_tree', threadId, cwd: cwd || '', path: dirPath || cwd || '' });
    },
    [sendApp],
  );

  const uploadFile = useCallback(
    (threadId: string, name: string, base64: string, mime?: string) => {
      setLastUpload(null);
      sendApp({
        type: 'upload_file',
        threadId,
        name,
        mime: mime || '',
        encoding: 'base64',
        content: base64,
      });
    },
    [sendApp],
  );

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
      setConfig((prev) => applyConfigPatch(prev, key, next));
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
    setArchivedIds((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      void saveIdSet('archived', next);
      return next;
    });
    setThreads((prev) => prev.filter((t) => t.id !== id));
    setProjects((prev) => prev.map((p) => ({
      ...p,
      threads: p.threads.filter((t) => t.id !== id),
    })));
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
      if (!acceptApp({ type: 'run_command', threadId, command })) {
        setError('未连接，命令没发出去');
        return false;
      }
      lastOutgoingRef.current = {
        id: nextFailedId(),
        threadId,
        text: command,
        working: false,
        kind: 'command',
      };
      return true;
    },
    [acceptApp],
  );

  const retryFailedSend = useCallback(
    (id: string) => {
      const item = failedSends.find((row) => row.id === id);
      if (!item) return false;
      setFailedSends((prev) => prev.filter((row) => row.id !== id));
      const ok = item.kind === 'command'
        ? runCommand(item.threadId, item.text)
        : sendComposer(item.threadId, item.text, item.working, item.input);
      if (!ok) {
        setFailedSends((prev) => [...prev, { ...item, error: '未连接，没发出去' }]);
      }
      return ok;
    },
    [failedSends, runCommand, sendComposer],
  );

  const dismissFailedSend = useCallback((id: string) => {
    setFailedSends((prev) => prev.filter((row) => row.id !== id));
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
      setGit(null);
      sendApp({ type: 'git_status', threadId, action: 'all' });
    },
    [sendApp],
  );

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
      dismissApprovalLocal(threadId, ids);
      const lock = (histories[threadId]?.lockHolder) || '';
      if (lock === 'desktop') {
        setFeedback('已交给电脑继续跑。若桌面还弹窗，请在电脑上再确认一次。');
      } else if (lock === 'hub') {
        setFeedback('Hub 已代批，不必开桌面。');
      } else {
        setFeedback('审批已发出。桌面开着时由电脑继续；没开桌面则 Hub 代批。');
      }
    },
    [approvals, histories, sendApp, dismissApprovalLocal],
  );

  const value = useMemo<SessionValue>(
    () => ({
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
      failedSends,
      retryFailedSend,
      dismissFailedSend,
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
      clearError: () => setError(''),
      clearFeedback: () => setFeedback(''),
    }),
    [
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
      failedSends,
      retryFailedSend,
      dismissFailedSend,
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
    ],
  );

  const historiesValue = useMemo<HistoriesValue>(
    () => ({
      histories,
      approvals,
      loadingOlder,
      openThread,
      loadOlderHistory,
      sendApproval,
    }),
    [histories, approvals, loadingOlder, openThread, loadOlderHistory, sendApproval],
  );

  const toolsValue = useMemo<ToolsValue>(
    () => ({
      commandOut,
      commandHist,
      git,
      searchHits,
      runCommand,
      stopCommand,
      gitStatus,
      searchThread,
    }),
    [commandOut, commandHist, git, searchHits, runCommand, stopCommand, gitStatus, searchThread],
  );

  const workspaceValue = useMemo<WorkspaceValue>(
    () => ({
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
    [tree, files, workspaceHits, artifacts, lastUpload, requestTree, requestFile, uploadFile, searchWorkspace, listArtifacts, clearUpload],
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
