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
import { normalizeHubUrl, probeHub } from './discover';
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
  type FileData,
  type HubConfig,
  type ModelInfo,
  type Project,
  type Thread,
  type ThreadHistory,
  type TokenUsage,
  type TreeNode,
} from './types';

type RNWebSocketOptions = { headers?: Record<string, string> };

function openSocket(url: string, token: string): WebSocket {
  const Ctor = WebSocket as unknown as {
    new (wsUrl: string, protocols?: string | string[], options?: RNWebSocketOptions): WebSocket;
  };
  return new Ctor(url, undefined, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

type SessionValue = {
  hydrated: boolean;
  paired: boolean;
  relayUrl: string;
  hubId: string;
  lanUrl: string;
  mode: '' | 'relay' | 'lan';
  conn: ConnKind;
  connText: string;
  error: string;
  threads: Thread[];
  projects: Project[];
  histories: Record<string, ThreadHistory>;
  approvals: Record<string, Approval>;
  feedback: string;
  models: ModelInfo[];
  config: HubConfig;
  files: Record<string, FileData>;
  lastCreatedId: string;
  hostName: string;
  quota: TokenUsage;
  tree: { cwd: string; rootName: string; tree: TreeNode[] };
  lastUpload: { path: string; name: string; error?: string | null } | null;
  searchHits: { index: number; type: string; snippet: string }[];
  searchThread: (threadId: string, q: string) => void;
  git: { cwd?: string; status?: string; diff?: string; log?: string; error?: string | null } | null;
  commandOut: string;
  pinnedIds: string[];
  archivedIds: string[];
  setRelayUrl: (url: string) => Promise<void>;
  pair: (codeOrUrl: string, relayOverride?: string) => Promise<void>;
  loginLan: (url: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  sendApp: (msg: AppMessage) => boolean;
  refreshThreads: () => void;
  runCommand: (threadId: string, command: string) => void;
  gitStatus: (threadId: string) => void;
  openThread: (threadId: string) => void;
  loadOlderHistory: (threadId: string) => void;
  createThread: (targetCwd?: string) => void;
  sendComposer: (threadId: string, text: string, working: boolean, input?: unknown[]) => void;
  sendStop: (threadId: string) => void;
  sendApproval: (threadId: string, decision: Decision) => void;
  requestFile: (threadId: string, path: string) => void;
  requestTree: (threadId: string, cwd?: string) => void;
  uploadFile: (threadId: string, name: string, base64: string, mime?: string) => void;
  updateConfig: (key: string, value: string) => void;
  goal: { threadId: string; objective: string } | null;
  getGoal: (threadId: string) => void;
  setGoal: (threadId: string, objective: string) => void;
  renameThread: (threadId: string, title: string) => void;
  togglePin: (threadId: string) => void;
  archiveThread: (threadId: string) => void;
  clearUpload: () => void;
  clearError: () => void;
  clearFeedback: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [relayUrl, setRelayUrlState] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const [hubId, setHubId] = useState('');
  const [conn, setConn] = useState<ConnKind>('idle');
  const [error, setError] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [histories, setHistories] = useState<Record<string, ThreadHistory>>({});
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const [feedback, setFeedback] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [config, setConfig] = useState<HubConfig>({});
  const [files, setFiles] = useState<Record<string, FileData>>({});
  const [lastCreatedId, setLastCreatedId] = useState('');
  const [hostName, setHostName] = useState('');
  const [quota, setQuota] = useState<TokenUsage>({});
  const [tree, setTree] = useState<{ cwd: string; rootName: string; tree: TreeNode[] }>({
    cwd: '',
    rootName: '',
    tree: [],
  });
  const [lastUpload, setLastUpload] = useState<{ path: string; name: string; error?: string | null } | null>(null);
  const [goal, setGoalState] = useState<{ threadId: string; objective: string } | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [git, setGit] = useState<SessionValue['git']>(null);
  const [commandOut, setCommandOut] = useState('');
  const [searchHits, setSearchHits] = useState<{ index: number; type: string; snippet: string }[]>([]);
  const [mode, setMode] = useState<'' | 'relay' | 'lan'>('');
  const [lanUrl, setLanUrl] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);
  const failsRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
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
    mode: '' as '' | 'relay' | 'lan',
  });
  const deviceKeysRef = useRef<{ publicKey: string; secretKey: string } | null>(null);
  const pendingAppRef = useRef<AppMessage[]>([]);
  const currentThreadRef = useRef('');
  const loadingOlderRef = useRef(new Set<string>());
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

  const paired = mode === 'lan' ? Boolean(lanUrl && credsRef.current.lanPassword) : Boolean(deviceToken && hubId && relayUrl);

  const connText =
    conn === 'connected'
      ? (mode === 'lan' ? '直连' : '中继')
      : conn === 'hub_offline'
        ? '离线'
        : conn === 'reconnecting'
          ? '重连中'
          : conn === 'connecting'
            ? '连接中'
            : paired
              ? '未连接'
              : '未配对';

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
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(msg));
        return true;
      }
      const { hubId: id, contentKey, keyId } = creds;
      if (!id) return false;
      if (!contentKey) {
        pendingAppRef.current.push(msg);
        return false;
      }
      return sendRaw({
        v: 1,
        type: 'fwd',
        hubId: id,
        enc: secretSeal(msg, contentKey, keyId),
      });
    },
    [sendRaw],
  );

  const handleApp = useCallback((msg: AppMessage) => {
    if (msg.type === 'ping') return;
    if (msg.type === 'thread_list') {
      const parsed = parseThreadList(msg.data);
      const gone = dismissedThreads.current;
      setThreads(parsed.threads.map((t) => (gone.has(t.id) ? { ...t, needsApproval: false } : t)));
      setProjects(
        parsed.projects.map((p) => ({
          ...p,
          threads: p.threads.map((t) => (gone.has(t.id) ? { ...t, needsApproval: false } : t)),
        })),
      );
      if (msg.config && typeof msg.config === 'object') setConfig(msg.config as HubConfig);
      if (msg.quota && typeof msg.quota === 'object') setQuota(msg.quota as TokenUsage);
      if (typeof msg.hostName === 'string' && msg.hostName.trim()) setHostName(msg.hostName.trim());
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
    if (msg.type === 'workspace_tree') {
      setTree({
        cwd: typeof msg.cwd === 'string' ? msg.cwd : '',
        rootName: typeof msg.rootName === 'string' ? msg.rootName : '',
        tree: Array.isArray(msg.tree) ? (msg.tree as TreeNode[]) : [],
      });
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
      });
      return;
    }
    if (msg.type === 'command_output') {
      const chunk = typeof msg.chunk === 'string' ? msg.chunk : '';
      const stream = typeof msg.stream === 'string' ? msg.stream : '';
      if (stream === 'exit') {
        setCommandOut((prev) => `${prev}\n[exit ${String(msg.exitCode ?? '')}]\n`);
      } else if (chunk) {
        setCommandOut((prev) => prev + chunk);
      }
      return;
    }
    if (msg.type === 'file_data' && typeof msg.path === 'string') {
      setFiles((prev) => ({
        ...prev,
        [msg.path as string]: {
          path: msg.path as string,
          fileName: typeof msg.fileName === 'string' ? msg.fileName : '',
          ext: typeof msg.ext === 'string' ? msg.ext : '',
          encoding: msg.encoding === 'base64' ? 'base64' : 'utf8',
          content: typeof msg.content === 'string' ? msg.content : '',
          truncated: Boolean(msg.truncated),
          error: typeof msg.error === 'string' ? msg.error : null,
        },
      }));
      return;
    }
    if (msg.type === 'thread_history' || msg.type === 'thread_update') {
      const threadId = typeof msg.threadId === 'string' ? msg.threadId : '';
      if (!threadId) return;
      if (msg.type === 'thread_history') loadingOlderRef.current.delete(threadId);
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
      if (status === 'error') setError(message || '操作失败');
      else if (message) setFeedback(message);
    }
  }, []);

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
      if (!creds.lanUrl || !creds.lanPassword) return;
    } else if (!creds.relayUrl || !creds.deviceToken || !creds.hubId) {
      return;
    }
    disconnect();
    setConn((prev) => (prev === 'connected' ? 'reconnecting' : 'connecting'));
    const wsUrl = lan ? toWsUrl(creds.lanUrl, creds.lanPassword) : toWsUrl(creds.relayUrl, creds.deviceToken);
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
          setError(/prng/i.test(raw) ? '当前安装包缺随机数，请安装新版 APK 后再配对' : (raw || '无法生成本地密钥'));
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
      setConn(lan || credsRef.current.contentKey ? 'connected' : 'connecting');
      setError('');
      startHello();
      if (!lan && !credsRef.current.contentKey) {
        setTimeout(() => {
          if (!credsRef.current.contentKey && wsRef.current === ws) startHello();
        }, 1500);
        setTimeout(() => {
          if (credsRef.current.contentKey || wsRef.current !== ws) return;
          setError('已连上中继，但加密握手没完成。请安装新版 APK，退出后再扫主机台右边的出门码。');
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
            setError('握手失败，请再配对一次');
            return;
          }
          credsRef.current.contentKey = opened.contentKey;
          credsRef.current.keyId = opened.keyId || '';
          if (opened.hubPub) credsRef.current.hubE2ePub = opened.hubPub;
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
            setError('请重新扫码配对');
          }
          if (incoming.code === 'revoked' || incoming.code === 'unauthorized') {
            stoppedRef.current = true;
            disconnect();
            setDeviceToken('');
            setHubId('');
            void saveSession({ deviceToken: '', hubId: '' });
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
        setConn('idle');
        return;
      }
      failsRef.current += 1;
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
    if ((mode === 'lan' && lanUrl && credsRef.current.lanPassword) || (deviceToken && hubId && relayUrl)) {
      stoppedRef.current = false;
      connect();
    } else {
      stoppedRef.current = true;
      disconnect();
      setConn('idle');
    }
    return () => {
      stoppedRef.current = true;
      disconnect();
    };
  }, [hydrated, deviceToken, hubId, relayUrl, mode, lanUrl, connect, disconnect]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const bg = next !== 'active';
      backgroundRef.current = bg;
      if (bg) {
        clearTimers();
        return;
      }
      if (!hydrated) return;
      const ready = (mode === 'lan' && lanUrl && credsRef.current.lanPassword)
        || Boolean(deviceToken && hubId && relayUrl);
      if (!ready) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    });
    return () => sub.remove();
  }, [hydrated, deviceToken, hubId, relayUrl, mode, lanUrl, connect, clearTimers]);

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
    if (lanHint && credsRef.current.lanPassword) {
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
    credsRef.current.hubId = result.hubId || credsRef.current.hubId;
    credsRef.current.mode = 'lan';
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
    credsRef.current.lanUrl = '';
    credsRef.current.lanPassword = '';
    credsRef.current.mode = '';
    setThreads([]);
    setProjects([]);
    setHistories({});
    setApprovals({});
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
      sendApp({ type: 'get_thread_history', threadId, all: true });
    },
    [sendApp],
  );

  const createThread = useCallback(
    (targetCwd?: string) => {
      sendApp({ type: 'create_thread', targetCwd: targetCwd || '', title: '新聊天' });
    },
    [sendApp],
  );

  const sendComposer = useCallback(
    (threadId: string, text: string, working: boolean, input?: unknown[]) => {
      const trimmed = text.trim();
      if (!trimmed && !input?.length) return;
      sendApp({
        type: working ? 'send_steer' : 'send_message',
        threadId,
        text: trimmed,
        input: input || undefined,
      });
    },
    [sendApp],
  );

  const requestTree = useCallback(
    (threadId: string, cwd?: string) => {
      sendApp({ type: 'get_workspace_tree', threadId, cwd: cwd || '' });
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

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev];
      void saveIdSet('pins', next);
      return next;
    });
  }, []);

  const archiveThread = useCallback((id: string) => {
    setArchivedIds((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      void saveIdSet('archived', next);
      return next;
    });
  }, []);

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
      sendApp({ type: 'run_command', threadId, command });
    },
    [sendApp],
  );

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
      setFeedback('审批已发出，正在看电脑有没有接住…');
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
      error,
      refreshThreads,
      threads,
      projects,
      histories,
      approvals,
      feedback,
      models,
      config,
      files,
      lastCreatedId,
      hostName,
      quota,
      tree,
      lastUpload,
      searchHits,
      git,
      commandOut,
      pinnedIds,
      archivedIds,
      setRelayUrl,
      pair,
      loginLan,
      logout,
      sendApp,
      searchThread,
      openThread,
      loadOlderHistory,
      createThread,
      sendComposer,
      runCommand,
      gitStatus,
      sendStop,
      sendApproval,
      requestFile,
      requestTree,
      uploadFile,
      updateConfig,
      goal,
      getGoal,
      setGoal,
      renameThread,
      togglePin,
      archiveThread,
      clearUpload: () => setLastUpload(null),
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
      error,
      threads,
      projects,
      histories,
      approvals,
      feedback,
      models,
      config,
      files,
      lastCreatedId,
      hostName,
      quota,
      tree,
      lastUpload,
      searchHits,
      git,
      commandOut,
      pinnedIds,
      archivedIds,
      setRelayUrl,
      pair,
      loginLan,
      logout,
      sendApp,
      searchThread,
      refreshThreads,
      openThread,
      loadOlderHistory,
      createThread,
      sendComposer,
      runCommand,
      gitStatus,
      sendStop,
      sendApproval,
      requestFile,
      requestTree,
      uploadFile,
      updateConfig,
      goal,
      getGoal,
      setGoal,
      renameThread,
      togglePin,
      archiveThread,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider missing');
  return ctx;
}
