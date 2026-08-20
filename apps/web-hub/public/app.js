// Codex Remote Hub Client JS - Project Directory File Tree Explorer Engine
let ws = null;
let currentThreadId = null;
let currentCwd = '';
let currentPendingApproval = null;
const dismissedApprovalKeys = new Set();
let currentStatus = 'idle';

function approvalDismissKey(threadId, requestId) {
  return `${threadId || ''}:${requestId || ''}`;
}

function decodeApprovalCommand(text) {
  const raw = String(text || '');
  if (!raw) return '';
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (chunk) => {
    try { return decodeURIComponent(chunk); } catch { return chunk; }
  });
}

function hideApprovalAlert() {
  currentPendingApproval = null;
  const el = document.getElementById('approval-alert');
  if (el) el.classList.add('hidden');
}

function dismissApprovalUI(threadId, requestId, extraIds) {
  const ids = [requestId, ...(Array.isArray(extraIds) ? extraIds : [])].map((v) => String(v || '')).filter(Boolean);
  for (const id of ids) dismissedApprovalKeys.add(approvalDismissKey(threadId, id));
  const cur = currentPendingApproval;
  const curIds = cur ? [cur.id, ...(cur.ids || [])].map(String) : [];
  if (!threadId || threadId === currentThreadId) {
    if (!cur || !ids.length || ids.some((id) => curIds.includes(id))) hideApprovalAlert();
  }
}
let isInitialThreadAutoSelected = false;
let renamingThreadId = null;
let pendingFirstSend = null;
let currentWorkspaceTreeData = null;

// Active Model & Reasoning Effort Selection State (Synchronized with C:\Users\zhang\.codex\config.toml)
let selectedModel = 'gpt-5.6-sol';
let selectedEffort = 'xhigh';
let catalogModels = [];
const EFFORT_LABELS = {
  none: '无',
  minimal: '最低',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高'
};

// Configure Marked.js (highlighting is applied post-render via hljs in rAF callback)
if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: false, gfm: true });
}

function updateMobileViewport() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--vh', `${height}px`);
  const mobile = window.matchMedia('(max-width: 768px)').matches;
  const isKeyboard = mobile && vv && (window.innerHeight - vv.height > 120);
  if (isKeyboard) {
    document.body.classList.add('kb-open');
  } else {
    document.body.classList.remove('kb-open');
  }
  window.scrollTo(0, 0);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateMobileViewport);
  window.visualViewport.addEventListener('scroll', updateMobileViewport);
}
window.addEventListener('resize', updateMobileViewport);
window.addEventListener('DOMContentLoaded', updateMobileViewport);
document.addEventListener('focusin', (e) => {
  if (e.target && e.target.id === 'msg-input') {
    requestAnimationFrame(() => {
      updateMobileViewport();
      window.scrollTo(0, 0);
    });
    setTimeout(() => {
      updateMobileViewport();
      window.scrollTo(0, 0);
    }, 250);
  }
});

// Bulletproof Safe DOM Setter (Prevents "Cannot set properties of null" error 100%)
function safeSetText(el, text) {
  if (el && typeof el === 'object') {
    el.textContent = text !== undefined && text !== null ? String(text) : '';
  }
}

// DOM Elements
const connectionStatus = document.getElementById('connection-status');
const statusText = connectionStatus ? connectionStatus.querySelector('.status-text') : null;
const projectListEl = document.getElementById('project-list');
const threadListEl = document.getElementById('thread-list');
const sidebarFilterEl = document.getElementById('sidebar-filter');
const projectCountEl = document.getElementById('project-count');
const threadCountEl = document.getElementById('thread-count');
let selectedProjectKey = localStorage.getItem('activeProjectKey') || '';
let sidebarProjectsCache = [];
let sidebarThreadsCache = [];
let desktopProjectOrder = [];
let desktopPinnedOrder = [];
let sidebarFilter = '';
const RECENT_LIMIT = 20;
let expandedProjects = new Set();
try {
  const savedExpanded = JSON.parse(localStorage.getItem('expandedProjects') || '[]');
  if (Array.isArray(savedExpanded)) savedExpanded.forEach((n) => expandedProjects.add(n));
} catch (e) {}
let expandedBuckets = { pinned: true, projects: true, recent: false };
try {
  const savedBuckets = JSON.parse(localStorage.getItem('expandedBuckets') || 'null');
  if (savedBuckets && typeof savedBuckets === 'object') {
    expandedBuckets = {
      pinned: savedBuckets.pinned !== false,
      projects: savedBuckets.projects !== false,
      recent: !!savedBuckets.recent
    };
  }
} catch (e) {}
let selectedAccessMode = 'full';
const activeSessionTitle = document.getElementById('active-session-title');
const activeSessionId = document.getElementById('active-session-id');
const activeSessionBadge = document.getElementById('active-session-badge');
const chatFeed = document.getElementById('chat-feed');
const approvalAlert = document.getElementById('approval-alert');
const approvalDetail = document.getElementById('approval-detail');
const msgInput = document.getElementById('msg-input');

// Codex Desktop App Parity Elements
const floatingCapsuleBadge = document.getElementById('floating-capsule-badge');
const stepCounterText = document.getElementById('step-counter-text');

const btnAddFile = document.getElementById('btn-add-file');
const accessModeBadge = document.getElementById('access-mode-badge');
const accessModeText = document.getElementById('access-mode-text');

// Project Directory File Tree Explorer Elements
const btnToggleWorkspacePanel = document.getElementById('btn-toggle-workspace-panel');
const rightPanel = document.getElementById('right-panel');
const workspaceFolderName = document.getElementById('workspace-folder-name');
const workspaceFileSearch = document.getElementById('workspace-file-search');
const workspaceTreeBody = document.getElementById('workspace-tree-body');
const btnRefreshWorkspace = document.getElementById('btn-refresh-workspace');

// 2-Tier Popup Menu Elements
const modelSelectorBadge = document.getElementById('model-selector-badge');
const modelSpinner = document.getElementById('model-spinner');
const modelNameText = document.getElementById('model-name-text');
const effortText = document.getElementById('effort-text');

const modelPopupMenu = document.getElementById('model-popup-menu');
const popupModelVal = document.getElementById('popup-model-val');
const popupEffortVal = document.getElementById('popup-effort-val');

const modelSubmenuCard = document.getElementById('model-submenu-card');
const submenuTitleBar = document.getElementById('submenu-title-text');
const submenuBackBtn = document.getElementById('submenu-back-btn');
const isMobileLayout = () => window.matchMedia('(max-width: 640px)').matches;
const submenuOptionsList = document.getElementById('submenu-options-list');

const btnVoice = document.getElementById('btn-voice');
const btnMainAction = document.getElementById('btn-main-action');
const btnStopTurn = document.getElementById('btn-stop-turn');
const filePicker = document.getElementById('file-picker');
const attachmentChips = document.getElementById('attachment-chips');
let pendingAttachments = [];

const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const sidebar = document.getElementById('sidebar');
const btnRefresh = document.getElementById('btn-refresh');
const isOverlayLayout = () => window.matchMedia('(max-width: 768px)').matches;

function closeSidebar() {
  if (sidebar) sidebar.classList.remove('open');
  const overlay = document.getElementById('sidebar-overlay');
  if (overlay) overlay.classList.remove('active');
}

function closeRightPanel() {
  if (!isOverlayLayout()) return;
  if (rightPanel) {
    rightPanel.classList.remove('open', 'collapsed');
  }
  const overlay = document.getElementById('right-panel-overlay');
  if (overlay) overlay.classList.remove('active');
  if (btnToggleWorkspacePanel) btnToggleWorkspacePanel.classList.remove('active');
}

function openRightPanel() {
  if (!isOverlayLayout()) {
    if (rightPanel) rightPanel.classList.remove('open', 'collapsed');
    if (currentCwd) loadWorkspaceTree(currentCwd);
    return;
  }
  closeSidebar();
  if (rightPanel) {
    rightPanel.classList.add('open');
    rightPanel.classList.remove('collapsed');
  }
  const overlay = document.getElementById('right-panel-overlay');
  if (overlay) overlay.classList.add('active');
  if (btnToggleWorkspacePanel) btnToggleWorkspacePanel.classList.add('active');
  if (currentCwd) loadWorkspaceTree(currentCwd);
}

function renderStatusBadge(kind, fullText, shortText) {
  if (!activeSessionBadge) return;
  const cls = kind === 'working' ? 'badge-working' : kind === 'approval' ? 'badge-approval' : kind === 'done' ? 'badge-done' : 'badge-idle';
  activeSessionBadge.className = `session-status-badge ${cls}`;
  activeSessionBadge.title = fullText;
  const pulse = kind === 'working' ? '<span class="status-pulse-dot"></span>' : '';
  activeSessionBadge.innerHTML = `${pulse}<span class="badge-full">${escapeHtml(fullText)}</span><span class="badge-short">${escapeHtml(shortText)}</span>`;
}

if (activeSessionBadge) {
  activeSessionBadge.addEventListener('click', () => {
    if (!isOverlayLayout() || !activeSessionBadge.title) return;
    showGestureToast(activeSessionBadge.title);
  });
}

if (connectionStatus) {
  connectionStatus.addEventListener('click', () => {
    const text = (statusText && statusText.textContent) || connectionStatus.title || '连接状态';
    showGestureToast(text);
    showAuthOverlay(hostOffline ? 'offline' : (connMode === 'relay' ? 'pair' : 'login'));
  });
}
const btnApproveAllow = document.getElementById('btn-approve-allow');
const btnApproveDeny = document.getElementById('btn-approve-deny');

// Token Usage Widget Elements (compact horizontal bars)
const gaugeBarFill = document.getElementById('gauge-bar-fill');
const gaugePercentText = document.getElementById('gauge-percent-text');
const gaugeDetailText = document.getElementById('gauge-detail-text');

// Modal File Viewer Elements
const fileModal = document.getElementById('file-modal');
const fileModalName = document.getElementById('file-modal-name');
const fileModalPath = document.getElementById('file-modal-path');
const fileModalBody = document.getElementById('file-modal-body');
const btnCloseFileModal = document.getElementById('btn-close-file-modal');
const btnDownloadFile = document.getElementById('btn-download-file');
const btnApproveSession = document.getElementById('btn-approve-session');
const authOverlay = document.getElementById('auth-overlay');
const authLead = document.getElementById('auth-lead');
const authOffline = document.getElementById('auth-offline');
const authLoginForm = document.getElementById('auth-login-form');
const authPairForm = document.getElementById('auth-pair-form');
const authPassword = document.getElementById('auth-password');
const authPairCode = document.getElementById('auth-pair-code');
const authLanUrl = document.getElementById('auth-lan-url');
const authError = document.getElementById('auth-error');
const btnAuthRetry = document.getElementById('btn-auth-retry');
const btnAuthLogout = document.getElementById('btn-auth-logout');
const btnProbeLan = document.getElementById('btn-probe-lan');
const slashMenu = document.getElementById('slash-menu');
const btnSlash = document.getElementById('btn-slash');
const btnShowPairQr = document.getElementById('btn-show-pair-qr');
const btnOpenHost = document.getElementById('btn-open-host');
if (btnOpenHost && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(location.hostname)) {
  btnOpenHost.classList.remove('hidden');
}
const pairQrOverlay = document.getElementById('pair-qr-overlay');
const pairQrBox = document.getElementById('pair-qr-box');
const pairQrCode = document.getElementById('pair-qr-code');
const pairQrExpire = document.getElementById('pair-qr-expire');
const pairQrError = document.getElementById('pair-qr-error');
const pairQrRelayStatus = document.getElementById('pair-qr-relay-status');
const pairQrRelayUrl = document.getElementById('pair-qr-relay-url');
const btnRefreshPairQr = document.getElementById('btn-refresh-pair-qr');
const btnClosePairQr = document.getElementById('btn-close-pair-qr');

const LS_LAN = 'onedesk.lanBase';
const LS_TOKEN = 'onedesk.deviceToken';
const LS_HUB = 'onedesk.hubId';
const LS_MODE = 'onedesk.connMode';
const LS_HK = 'onedesk.hubE2ePub';
const LS_CK = 'onedesk.contentKey';
const LS_KID = 'onedesk.keyId';

let sessionReady = false;
let appStarted = false;
let connMode = localStorage.getItem(LS_MODE) || '';
let lanBase = (localStorage.getItem(LS_LAN) || '').replace(/\/$/, '');
let deviceToken = localStorage.getItem(LS_TOKEN) || '';
let pairedHubId = localStorage.getItem(LS_HUB) || '';
let hubE2ePub = localStorage.getItem(LS_HK) || '';
let e2eContentKey = localStorage.getItem(LS_CK) || '';
let e2eKeyId = localStorage.getItem(LS_KID) || '';
let hostOffline = false;
let reconnectFails = 0;
let lastFileMeta = null;
let slashIndex = 0;

const TOOL_LABELS = {
  exec_command: '执行命令',
  update_plan: '更新计划',
  write_file: '写入文件',
  read_file: '读取文件',
  apply_patch: '应用补丁',
  apply_delta: '应用补丁',
  edit: '编辑文件',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  list_directory: '浏览目录',
  get_file_info: '读取文件信息',
  run_terminal_command: '执行终端命令',
  save_memory: '保存记忆',
  add_delegated_agent: '启动子智能体'
};

const SLASH_ITEMS = [
  { cmd: '/review', desc: '代码审查', kind: 'send' },
  { cmd: '/compact', desc: '压缩上下文', kind: 'send' },
  { cmd: '/init', desc: '初始化项目', kind: 'send' },
  { cmd: '/status', desc: '查看状态', kind: 'send' },
  { cmd: '/plan', desc: '规划模式', kind: 'send' },
  { cmd: '/model', desc: '选择模型', kind: 'model' },
  { cmd: '/reasoning', desc: '推理强度', kind: 'effort' },
  { cmd: '/mcp', desc: 'MCP 服务器', kind: 'mcp' }
];

function persistConn() {
  if (lanBase) localStorage.setItem(LS_LAN, lanBase);
  else localStorage.removeItem(LS_LAN);
  if (deviceToken) localStorage.setItem(LS_TOKEN, deviceToken);
  else localStorage.removeItem(LS_TOKEN);
  if (pairedHubId) localStorage.setItem(LS_HUB, pairedHubId);
  else localStorage.removeItem(LS_HUB);
  if (hubE2ePub) localStorage.setItem(LS_HK, hubE2ePub);
  else localStorage.removeItem(LS_HK);
  if (e2eContentKey) localStorage.setItem(LS_CK, e2eContentKey);
  else localStorage.removeItem(LS_CK);
  if (e2eKeyId) localStorage.setItem(LS_KID, e2eKeyId);
  else localStorage.removeItem(LS_KID);
  if (connMode) localStorage.setItem(LS_MODE, connMode);
  else localStorage.removeItem(LS_MODE);
}

function originOf(href) {
  try { return new URL(href, window.location.href).origin; } catch (e) { return ''; }
}

function defaultLanProbeUrl() {
  const u = new URL(window.location.href);
  u.port = '18990';
  u.protocol = (u.protocol === 'https:') ? 'https:' : 'http:';
  u.pathname = '/';
  u.search = '';
  u.hash = '';
  return u.origin;
}

function apiUrl(path) {
  if (connMode === 'lan' && lanBase && originOf(lanBase) !== window.location.origin) {
    return lanBase.replace(/\/$/, '') + path;
  }
  return path;
}

function wsUrl() {
  if (connMode === 'lan' && lanBase && originOf(lanBase) !== window.location.origin) {
    const u = new URL(lanBase);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${proto}//${window.location.host}`;
  if (connMode === 'relay' && deviceToken) url += `/?token=${encodeURIComponent(deviceToken)}`;
  return url;
}

async function fetchTimed(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 4000);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal, credentials: 'include' }, opts || {}));
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function apiFetch(path, opts) {
  const headers = Object.assign({}, (opts && opts.headers) || {});
  if (connMode === 'relay' && deviceToken && path.indexOf('/api/relay/') === 0) {
    headers.Authorization = 'Bearer ' + deviceToken;
  }
  const res = await fetch(apiUrl(path), Object.assign({}, opts || {}, { headers, credentials: 'include' }));
  if (connMode !== 'relay' && res.status === 401 && path !== '/api/auth/status' && path !== '/api/auth/login') {
    sessionReady = false;
    clearSessionViews();
    showAuthOverlay('login');
  }
  return res;
}

function sendE2eHello() {
  const e2e = window.CodeskE2E;
  if (!e2e || !ws || ws.readyState !== WebSocket.OPEN) return false;
  const keys = e2e.loadDeviceKeys();
  const payload = hubE2ePub
    ? e2e.anonymousBox({ v: 1, devicePub: keys.publicKey, ts: Date.now() }, hubE2ePub)
    : { v: 1, devicePub: keys.publicKey, ts: Date.now() };
  ws.send(JSON.stringify({ v: 1, type: 'e2e_hello', hubId: pairedHubId, payload }));
  return true;
}

function sendApp(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pendingWsMessages.push(obj);
    return false;
  }
  if (connMode !== 'relay') {
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }
  const e2e = window.CodeskE2E;
  if (!e2e || !e2eContentKey) {
    pendingWsMessages.push(obj);
    sendE2eHello();
    return false;
  }
  try {
    ws.send(JSON.stringify({
      v: 1,
      type: 'fwd',
      hubId: pairedHubId,
      enc: e2e.secretSeal(obj, e2eContentKey, e2eKeyId)
    }));
    return true;
  } catch (e) {
    console.warn('[WS] send failed', e);
    return false;
  }
}

function unwrapIncoming(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.v === 1 && typeof raw.type === 'string') {
    if (raw.type === 'e2e_welcome') {
      const e2e = window.CodeskE2E;
      const keys = e2e ? e2e.loadDeviceKeys() : null;
      const opened = e2e && keys
        ? (e2e.anonymousOpen(raw.payload || {}, keys.secretKey)
          || (hubE2ePub ? e2e.boxOpen(raw.payload || {}, hubE2ePub, keys.secretKey) : null))
        : null;
      if (opened && opened.contentKey) {
        e2eContentKey = opened.contentKey;
        e2eKeyId = opened.keyId || '';
        if (opened.hubPub) hubE2ePub = opened.hubPub;
        persistConn();
        const queued = pendingWsMessages.splice(0);
        for (const m of queued) sendApp(m);
      } else {
        showAuthError('请重新扫码配对');
      }
      return null;
    }
    if (raw.type === 'fwd') {
      if (raw.enc) {
        const e2e = window.CodeskE2E;
        const opened = e2e && e2eContentKey ? e2e.secretOpen(raw.enc, e2eContentKey) : null;
        if (!opened) {
          e2eContentKey = '';
          sendE2eHello();
          return null;
        }
        return opened;
      }
      if (raw.payload) return raw.payload;
    }
    if (raw.type === 'hub_offline') {
      markHostOffline();
      return null;
    }
    if (raw.type === 'pong') return null;
    if (raw.type === 'ping') return { type: 'ping' };
    if (raw.type === 'error') {
      const code = raw.payload && raw.payload.code;
      if (code === 'e2e_required' || code === 'e2e_hello_bad') {
        e2eContentKey = '';
        persistConn();
        showAuthError('请重新扫码配对');
        return null;
      }
      showAuthError((raw.payload && raw.payload.message) || '中继错误');
      return null;
    }
  }
  return raw;
}

function setConnPill(kind, text) {
  if (!connectionStatus) return;
  const cls = kind === 'ok' ? 'status-connected' : kind === 'offline' ? 'status-offline' : 'status-disconnected';
  connectionStatus.className = `status-pill ${cls}`;
  connectionStatus.title = text;
  connectionStatus.setAttribute('aria-label', text);
  safeSetText(statusText, text);
}

function showAuthError(text) {
  if (!authError) return;
  if (!text) {
    authError.classList.add('hidden');
    authError.textContent = '';
    return;
  }
  authError.textContent = text;
  authError.classList.remove('hidden');
}

function showAuthOverlay(mode) {
  if (!authOverlay) return;
  authOverlay.classList.remove('hidden');
  if (authOffline) authOffline.classList.toggle('hidden', mode !== 'offline');
  if (authLoginForm) authLoginForm.classList.remove('hidden');
  if (authPairForm) authPairForm.classList.remove('hidden');
  if (btnAuthLogout) btnAuthLogout.classList.toggle('hidden', !sessionReady && !deviceToken);
  if (authLanUrl && lanBase) authLanUrl.value = lanBase;
  if (authLead) {
    authLead.textContent = mode === 'offline'
      ? '无法连上本机 Hub。'
      : '家里码和出门码不是同一个。看电脑主机台：左家里，右出门。';
  }
  if (mode === 'offline') setConnPill('offline', '主机离线');
}

function hideAuthOverlay() {
  if (authOverlay) authOverlay.classList.add('hidden');
  showAuthError('');
}

function clearSessionViews() {
  sidebarThreadsCache = [];
  sidebarProjectsCache = [];
  if (threadListEl) threadListEl.innerHTML = '<div class="sidebar-empty">未登录</div>';
}

function markHostOffline() {
  hostOffline = true;
  setConnPill('offline', '主机离线');
  showAuthOverlay('offline');
  if (threadListEl && !sidebarThreadsCache.length) {
    threadListEl.innerHTML = '<div class="sidebar-empty">主机离线</div>';
  }
}

function startApp() {
  sessionReady = true;
  hostOffline = false;
  hideAuthOverlay();
  if (btnAuthLogout) btnAuthLogout.classList.remove('hidden');
  if (appStarted) {
    if (connMode !== 'relay') fetchThreadsInstant();
    connectWS();
    return;
  }
  appStarted = true;
  if (connMode !== 'relay') fetchThreadsInstant();
  connectWS();
  startAutoRefreshEngine();
}

async function readJson(res) {
  if (!res) return null;
  try { return await res.json(); } catch (e) { return null; }
}

async function probeHub(base) {
  const root = (base || '').replace(/\/$/, '');
  const statusRes = await fetchTimed(root + '/api/auth/status', { credentials: 'include' }, 3500);
  if (statusRes && statusRes.ok) {
    const json = await readJson(statusRes);
    if (json && (json.hubId || json.loggedIn !== undefined || json.success)) return { kind: 'hub', json, base: root };
  }
  const threadRes = await fetchTimed(root + '/api/threads', { credentials: 'include' }, 3500);
  if (threadRes && threadRes.ok) return { kind: 'hub-open', json: await readJson(threadRes), base: root };
  if (threadRes && threadRes.status === 401) return { kind: 'hub-auth', json: null, base: root };
  return null;
}

function consumePairQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = (params.get('pair') || params.get('code') || '').trim();
    const hk = (params.get('hk') || '').trim();
    if (hk) {
      hubE2ePub = hk;
      persistConn();
    }
    if (!code) return '';
    params.delete('pair');
    params.delete('code');
    params.delete('hk');
    const next = params.toString();
    const url = window.location.pathname + (next ? '?' + next : '') + window.location.hash;
    window.history.replaceState({}, '', url);
    return code;
  } catch (e) {
    return '';
  }
}

async function pairWithCode(code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) throw new Error('缺少配对码');
  const res = await fetch('/api/relay/pair', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: trimmed })
  });
  const json = await readJson(res);
  if (!res.ok || !json || !json.deviceToken) {
    throw new Error((json && (json.error || json.message)) || '配对失败');
  }
  deviceToken = json.deviceToken;
  pairedHubId = json.hubId || '';
  connMode = 'relay';
  persistConn();
  startApp();
}

function relayDisplayUrl(raw, pairUrl) {
  if (pairUrl) {
    try { return new URL(pairUrl).origin; } catch { /* ignore */ }
  }
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('wss://')) return ('https://' + text.slice(6)).replace(/\/$/, '');
  if (text.startsWith('ws://')) return ('http://' + text.slice(5)).replace(/\/$/, '');
  return text.replace(/\/$/, '');
}

function renderPairRelay(relay, pairUrl) {
  if (!pairQrRelayStatus) return;
  const configured = !!(relay && relay.configured);
  const online = !!(relay && relay.online);
  pairQrRelayStatus.classList.remove('is-pending', 'is-online', 'is-offline', 'is-missing');
  if (!configured) {
    pairQrRelayStatus.classList.add('is-missing');
    pairQrRelayStatus.textContent = '中继未配置';
  } else if (online) {
    pairQrRelayStatus.classList.add('is-online');
    pairQrRelayStatus.textContent = '中继已连接';
  } else {
    pairQrRelayStatus.classList.add('is-offline');
    pairQrRelayStatus.textContent = '中继未连接';
  }
  if (pairQrRelayUrl) pairQrRelayUrl.textContent = relayDisplayUrl(relay && relay.url, pairUrl);
}

function renderPairQr(url) {
  if (!pairQrBox) return;
  pairQrBox.innerHTML = '';
  if (!url) return;
  if (typeof QRCode === 'function') {
    new QRCode(pairQrBox, { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
    return;
  }
  const img = document.createElement('img');
  img.alt = '配对二维码';
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(url);
  pairQrBox.appendChild(img);
}

async function showPairQr() {
  if (!pairQrOverlay) return;
  pairQrOverlay.classList.remove('hidden');
  if (pairQrError) {
    pairQrError.classList.add('hidden');
    pairQrError.textContent = '';
  }
  if (pairQrCode) pairQrCode.textContent = '……';
  if (pairQrExpire) pairQrExpire.textContent = '';
  if (pairQrRelayStatus) {
    pairQrRelayStatus.classList.remove('is-missing', 'is-online', 'is-offline');
    pairQrRelayStatus.classList.add('is-pending');
    pairQrRelayStatus.textContent = '正在检查中继…';
  }
  if (pairQrRelayUrl) pairQrRelayUrl.textContent = '';
  try {
    const [statusRes, pairRes] = await Promise.all([
      fetch(apiUrl('/api/auth/status'), { credentials: 'include' }),
      fetch(apiUrl('/api/auth/pair-code'), { credentials: 'include' }),
    ]);
    const statusJson = await readJson(statusRes);
    const json = await readJson(pairRes);
    const relay = (json && json.relay) || (statusJson && statusJson.relay) || {
      configured: false,
      online: !!(json && json.relayOnline),
      url: '',
    };
    renderPairRelay(relay, json && json.pairUrl);
    if (!pairRes.ok || !json || !json.code) {
      throw new Error((json && (json.error || json.message)) || (relay.configured
        ? (relay.online ? '中继已连接，但还没申请到配对码' : '中继未连接，先确认这台电脑已挂上中继')
        : '中继未配置'));
    }
    if (pairQrCode) pairQrCode.textContent = json.code;
    if (pairQrExpire && json.expiresAtMs) {
      pairQrExpire.textContent = '有效至 ' + new Date(json.expiresAtMs).toLocaleTimeString();
    }
    renderPairQr(json.pairUrl);
  } catch (err) {
    if (pairQrError) {
      pairQrError.textContent = err.message || '无法生成二维码';
      pairQrError.classList.remove('hidden');
    }
  }
}

function hidePairQr() {
  if (pairQrOverlay) pairQrOverlay.classList.add('hidden');
}

async function bootConnection() {
  const pendingPair = consumePairQuery();
  if (pendingPair) {
    setConnPill('off', '正在配对…');
    try {
      await pairWithCode(pendingPair);
      return;
    } catch (err) {
      connMode = 'relay';
      showAuthOverlay('pair');
      if (authPairCode) authPairCode.value = pendingPair;
      showAuthError(err.message || '扫码配对失败');
    }
  }

  if (authLanUrl && lanBase) authLanUrl.value = lanBase;
  setConnPill('off', '正在连接…');

  const same = await probeHub('');
  if (same) {
    connMode = 'lan';
    lanBase = '';
    persistConn();
    if (same.kind === 'hub') {
      if (same.json.loggedIn || same.json.authRequired === false || same.json.configured === false) {
        if (same.json.hubId) pairedHubId = same.json.hubId;
        persistConn();
        startApp();
        return;
      }
      showAuthOverlay('login');
      return;
    }
    if (same.kind === 'hub-open') {
      startApp();
      return;
    }
    showAuthOverlay('login');
    return;
  }

  const saved = lanBase && originOf(lanBase) !== window.location.origin ? await probeHub(lanBase) : null;
  if (saved && saved.kind !== 'hub-auth') {
    connMode = 'lan';
    persistConn();
    if (saved.kind === 'hub' && saved.json && saved.json.loggedIn === false) {
      showAuthOverlay('login');
      return;
    }
    startApp();
    return;
  }
  if (saved && saved.kind === 'hub-auth') {
    connMode = 'lan';
    persistConn();
    showAuthOverlay('login');
    return;
  }

  const probeTarget = defaultLanProbeUrl();
  if (probeTarget !== window.location.origin && window.location.protocol !== 'https:') {
    const probed = await probeHub(probeTarget);
    if (probed) {
      lanBase = probeTarget;
      connMode = 'lan';
      persistConn();
      if (probed.kind === 'hub-auth' || (probed.json && probed.json.loggedIn === false)) {
        showAuthOverlay('login');
        return;
      }
      startApp();
      return;
    }
  }

  if (deviceToken && pairedHubId) {
    connMode = 'relay';
    persistConn();
    startApp();
    return;
  }

  const pairProbe = await fetchTimed('/api/relay/hubs', {
    headers: deviceToken ? { Authorization: 'Bearer ' + deviceToken } : {}
  }, 2500);
  if (pairProbe && pairProbe.status !== 404) {
    connMode = 'relay';
    persistConn();
    showAuthOverlay('pair');
    return;
  }

  markHostOffline();
}

// Instant Dual-Fetch Thread List (< 5ms Load Guarantee)
async function fetchThreadsInstant() {
  if (!sessionReady) return;
  try {
    const res = await apiFetch('/api/threads');
    if (res.status === 401) return;
    const json = await res.json();
    if (json.success && json.data) {
      renderProjectTreeList(json.data);
      if (json.config) applyConfigData(json.config);
      if (json.quota) applyAccountQuota(json.quota);
    }
  } catch (e) {
    console.error('HTTP fetch threads error:', e);
  }
}

// Client-Side Thread History Cache for Sub-5ms Instant Switching
const clientThreadCache = new Map();
const CLIENT_HISTORY_LIMIT = 250; // 与服务端 HISTORY_LIMIT 保持一致

// 渐进渲染状态：当前隐藏在顶部的 items 数量（轻量虚拟滚动）
let renderHiddenCount = 0;
let progressiveObserver = null;
const RENDER_CHUNK = 60; // 每次向上滚动补充渲染的节点数

// 手势导航用：所有会话的扁平顺序（mtime 倒序，与侧栏一致）
let flatThreadIds = [];

// Show cached history immediately (zero-latency session switching)
function showThreadFromCache(id) {
  const cached = clientThreadCache.get(id);
  if (cached && cached.items && cached.items.length > 0) {
    renderThreadDetail(cached);
  } else {
    chatFeed.innerHTML = '<div class="loading-spinner">正在载入 Session 内容...</div>';
  }
}

// Merge a server delta (incremental new items) into the cached thread data when possible
function mergeThreadData(threadId, data) {
  const delta = data && data.delta;
  const cached = clientThreadCache.get(threadId);
  if (delta && delta.newItems && cached && Array.isArray(cached.items)
      && cached.rev !== undefined && cached.rev === delta.baseRev) {
    cached.items = cached.items.concat(delta.newItems).slice(-CLIENT_HISTORY_LIMIT);
    cached.totalItems = data.totalItems;
    cached.rev = data.rev;
    cached.hasMore = data.hasMore;
    cached.status = data.status;
    cached.startedAt = data.startedAt;
    cached.completedAt = data.completedAt;
    cached.pendingApproval = data.pendingApproval;
    cached.tokenUsage = data.tokenUsage;
    cached.activeActionText = data.activeActionText;
    if (data.cwd) cached.cwd = data.cwd;
    // 用户正在向上翻看历史时，窗口滑动补偿，保持视口内容不动
    if (renderHiddenCount > 0) {
      renderHiddenCount = Math.max(0, renderHiddenCount + delta.newItems.length);
    }
    return cached;
  }
  return data;
}

// HTTP fallback when WebSocket is unavailable
async function fetchThreadHistoryHTTP(id, all = false) {
  if (!id) return;
  try {
    const cached = clientThreadCache.get(id);
    const baseRevParam = (!all && cached && cached.rev !== undefined) ? `&baseRev=${cached.rev}` : '';
    const res = await apiFetch(`/api/thread-history?threadId=${encodeURIComponent(id)}${all ? '&all=true' : ''}${baseRevParam}`);
    const json = await res.json();
    if (json.unchanged) return; // 服务端无新内容，跳过重复渲染
    if (json.success && json.data) {
      const merged = mergeThreadData(id, json.data);
      clientThreadCache.set(id, merged);
      if (id === currentThreadId) renderThreadDetail(merged);
    }
  } catch (e) {
    console.error('HTTP load thread history error:', e);
  }
}

// Single-channel history request: WebSocket preferred, HTTP REST fallback (no duplicate fetch)
function requestThreadHistory(id) {
  if (!id) return;
  showThreadFromCache(id);
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendApp({ type: 'get_thread_history', threadId: id });
  } else {
    fetchThreadHistoryHTTP(id);
  }
}

// Throttled live rendering for high-frequency thread_update pushes (max one render / 350ms)
let pendingRenderTimer = null;
let lastLiveRenderAt = 0;

function scheduleLiveRender(threadId) {
  if (threadId !== currentThreadId) return;
  if (pendingRenderTimer) return;
  const wait = Math.max(0, 350 - (Date.now() - lastLiveRenderAt));
  pendingRenderTimer = setTimeout(() => {
    pendingRenderTimer = null;
    lastLiveRenderAt = Date.now();
    const data = clientThreadCache.get(currentThreadId);
    if (data) renderThreadDetail(data);
  }, wait);
}

// Connect WebSocket
let lastWsMsgAt = 0;
// WS 未就绪（CONNECTING/重连中）时待发送的消息队列，onopen 后统一冲刷
let pendingWsMessages = [];

function connectWS() {
  if (!sessionReady) return;
  const nextUrl = wsUrl();
  try { if (ws) ws.close(); } catch (e) {}
  ws = new WebSocket(nextUrl);

  ws.onopen = () => {
    reconnectFails = 0;
    hostOffline = false;
    hideAuthOverlay();
    setConnPill('ok', connMode === 'relay' ? '中继已连接' : '已连接');
    if (connMode === 'relay' && !e2eContentKey) sendE2eHello();
    sendApp({ type: 'get_threads' });
    if (currentThreadId) sendApp({ type: 'get_thread_history', threadId: currentThreadId });
    if (pendingWsMessages.length > 0) {
      const queued = pendingWsMessages.splice(0);
      for (const m of queued) sendApp(m);
    }
  };

  ws.onmessage = (event) => {
    lastWsMsgAt = Date.now();
    try {
      const msg = unwrapIncoming(JSON.parse(event.data));
      if (msg) handleWSMessage(msg);
    } catch (e) {
      console.error('WebSocket Message Parse Error:', e);
    }
  };

  ws.onclose = () => {
    reconnectFails += 1;
    if (reconnectFails >= 2) {
      markHostOffline();
    } else {
      setConnPill('off', '连接断开 (正在重连...)');
    }
    setTimeout(connectWS, 3000);
  };

  ws.onerror = (err) => {
    console.error('WS Error:', err);
  };
}

// 看门狗：手机网络切换/休眠易产生半开连接（onclose 不触发），
// 超过 70 秒未收到任何消息（含心跳）则强制断开触发重连
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && lastWsMsgAt && Date.now() - lastWsMsgAt > 70000) {
    console.warn('[WS] No message for 70s, forcing reconnect');
    ws.close();
  }
}, 15000);

function handleWSMessage(msg) {
  if (msg.type === 'ping') return; // 服务端心跳，仅用于保活/探活
  if (msg.type === 'thread_list') {
    renderProjectTreeList(msg.data);
    if (msg.config) {
      applyConfigData(msg.config);
    }
    if (msg.quota) applyAccountQuota(msg.quota);
  } else if (msg.type === 'config_data') {
    applyConfigData(msg.data);
  } else if (msg.type === 'thread_created') {
    selectThread(msg.threadId, msg.title || '新聊天');
    if (pendingFirstSend) {
      const pending = pendingFirstSend;
      pendingFirstSend = null;
      sendApp({
        type: 'send_message',
        threadId: msg.threadId,
        text: pending.text,
        input: pending.input
      });
    }
  } else if (msg.type === 'thread_renamed') {
    if (msg.threadId === currentThreadId && msg.title) {
      safeSetText(activeSessionTitle, msg.title);
      if (activeSessionTitle) activeSessionTitle.title = msg.title;
    }
  } else if (msg.type === 'thread_history' || msg.type === 'thread_update') {
    if (msg.threadId && msg.data) {
      const merged = mergeThreadData(msg.threadId, msg.data);
      clientThreadCache.set(msg.threadId, merged);
      if (msg.threadId === currentThreadId) {
        if (msg.type === 'thread_update') {
          // 高频推送走节流渲染，合并多次更新为一次 DOM 重建
          scheduleLiveRender(msg.threadId);
        } else {
          renderThreadDetail(merged);
        }
      }
    }
  } else if (msg.type === 'approval_request') {
    const requestId = msg.requestId == null ? '' : String(msg.requestId);
    if (requestId && dismissedApprovalKeys.has(approvalDismissKey(msg.threadId, requestId))) return;
    const at = typeof msg.at === 'number' ? msg.at : Date.now();
    if (msg.threadId && msg.threadId === currentThreadId) {
      currentPendingApproval = {
        id: requestId,
        ids: Array.isArray(msg.ids) ? msg.ids : [],
        command: msg.command,
        reason: msg.reason,
        type: msg.kind,
        at
      };
      approvalAlert.classList.remove('hidden');
      approvalDetail.textContent = decodeApprovalCommand(msg.command || '') || msg.reason || '检测到需要您确认的审批请求。';
      notifyApprovalIfNeeded(msg.threadId, currentPendingApproval);
    }
  } else if (msg.type === 'approval_resolved') {
    dismissApprovalUI(msg.threadId, msg.requestId, msg.ids);
  } else if (msg.type === 'git_status') {
    const gitPanel = document.getElementById('git-panel');
    if (gitPanel) {
      gitPanel.textContent = msg.error || [msg.status, msg.diff, msg.log].filter(Boolean).join('\n\n') || '干净工作区';
    }
  } else if (msg.type === 'command_output') {
    const cmdPanel = document.getElementById('cmd-panel');
    if (cmdPanel) {
      if (msg.stream === 'exit') cmdPanel.textContent += `\n[exit ${msg.exitCode ?? ''}]\n`;
      else if (msg.chunk) cmdPanel.textContent += msg.chunk;
      cmdPanel.scrollTop = cmdPanel.scrollHeight;
    }
  } else if (msg.type === 'search_results') {
    /* PWA 仍走 REST 搜索 */
  } else if (msg.type === 'action_feedback') {
    const gone = msg.status === 'error' && /审批|timeout|超时|没有找到|未命中/i.test(String(msg.message || '') + String(msg.code || ''));
    if (gone) dismissApprovalUI(msg.threadId || currentThreadId, msg.requestId, msg.ids);
    if (msg.status === 'error') {
      pendingFirstSend = null;
      console.error('[Action Feedback]', msg.message);
      alert(msg.message || '操作失败');
    } else {
      console.log('[Action Feedback]', msg.message);
    }
  }
}

// Apply Config Data Read from C:\Users\zhang\.codex\config.toml
function applyAccountQuota(tokenUsage) {
  if (!tokenUsage) return;
  const quotaPercentText = document.getElementById('quota-percent-text');
  const quotaBarFill = document.getElementById('quota-bar-fill');
  const quotaResetText = document.getElementById('quota-reset-text');
  const quotaPlanTag = document.getElementById('quota-plan-tag');
  const primaryPct = tokenUsage.primaryUsedPercent;
  if (primaryPct !== undefined && primaryPct !== null) {
    const remainPct = Math.max(0, Math.min(100, Math.round(100 - primaryPct)));
    safeSetText(quotaPercentText, `剩余 ${remainPct}%`);
    if (quotaBarFill) quotaBarFill.style.width = `${remainPct}%`;
  } else {
    safeSetText(quotaPercentText, '待同步');
    if (quotaBarFill) quotaBarFill.style.width = '0%';
  }
  if (tokenUsage.resetAtMs) {
    const rd = new Date(tokenUsage.resetAtMs);
    if (!isNaN(rd.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      safeSetText(quotaResetText, `重置: ${pad(rd.getMonth() + 1)}/${pad(rd.getDate())} ${pad(rd.getHours())}:${pad(rd.getMinutes())}`);
    }
  } else if (tokenUsage.resetTimeStr) {
    safeSetText(quotaResetText, `重置: ${tokenUsage.resetTimeStr}`);
  }
  if (tokenUsage.planType) safeSetText(quotaPlanTag, tokenUsage.planType);
}

function normalizeEffortId(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase();
  const map = {
    none: 'none',
    minimal: 'minimal',
    low: 'low',
    轻度: 'low',
    medium: 'medium',
    中: 'medium',
    high: 'high',
    高: 'high',
    xhigh: 'xhigh',
    'x-high': 'xhigh',
    'very-high': 'xhigh',
    极高: 'xhigh',
    max: 'max',
    maximum: 'max',
    最高: 'max',
    ultra: 'ultra',
    超高: 'ultra'
  };
  return map[key] || map[raw] || raw;
}

function findCatalogModel(id) {
  return catalogModels.find((model) => model.id === id) || null;
}

function modelDisplayName(id) {
  const model = findCatalogModel(id);
  return (model && model.displayName) || id || '';
}

function effortLabel(id) {
  const official = normalizeEffortId(id);
  return EFFORT_LABELS[official] || official || '';
}

function currentEffortOptions() {
  const model = findCatalogModel(selectedModel);
  if (model && model.supportedReasoningEfforts && model.supportedReasoningEfforts.length) {
    return model.supportedReasoningEfforts;
  }
  return Object.keys(EFFORT_LABELS).map((id) => ({ id, description: '' }));
}

function refreshModelLabels() {
  safeSetText(modelNameText, modelDisplayName(selectedModel));
  safeSetText(popupModelVal, modelDisplayName(selectedModel));
  safeSetText(effortText, effortLabel(selectedEffort));
  safeSetText(popupEffortVal, effortLabel(selectedEffort));
}

async function loadModelCatalog() {
  try {
    const res = await apiFetch('/api/models');
    const json = await res.json();
    if (json.success && Array.isArray(json.models)) {
      catalogModels = json.models;
      refreshModelLabels();
    }
  } catch (err) {
    console.warn('[models] load failed', err);
  }
}

function applyConfigData(cfg) {
  if (!cfg) return;
  selectedModel = cfg.rawModel || cfg.model || selectedModel;
  selectedEffort = normalizeEffortId(cfg.rawEffort || cfg.effort || selectedEffort);
  refreshModelLabels();
  applyAccessMode(cfg.accessMode || inferAccessMode(cfg), false);
}

function inferAccessMode(cfg) {
  if (cfg && cfg.accessMode) return cfg.accessMode;
  if (cfg && cfg.rawSandboxMode === 'danger-full-access') return 'full';
  if (cfg && cfg.rawSandboxMode === 'workspace-write') return 'auto';
  return 'ask';
}

const ACCESS_MODES = {
  ask: { label: '请求批准', icon: '✋', cls: 'mode-ask' },
  auto: { label: '帮我批准', icon: '🛡️', cls: 'mode-auto' },
  full: { label: '完全访问', icon: '!', cls: 'mode-full' }
};

function applyAccessMode(mode, persist) {
  const next = ACCESS_MODES[mode] ? mode : 'full';
  if (persist && next === 'full' && selectedAccessMode !== 'full') {
    if (!window.confirm('完全访问权限可不受限制地访问互联网和这台电脑上的任何文件。确定切换吗？')) return;
  }
  selectedAccessMode = next;
  const meta = ACCESS_MODES[selectedAccessMode];
  const iconEl = document.getElementById('access-icon');
  safeSetText(accessModeText, meta.label);
  safeSetText(iconEl, meta.icon);
  if (accessModeBadge) {
    accessModeBadge.className = `access-mode-badge ${meta.cls}`;
  }
  document.querySelectorAll('.access-option').forEach((el) => {
    el.classList.toggle('selected', el.dataset.value === selectedAccessMode);
  });
  if (persist && ws && ws.readyState === WebSocket.OPEN) {
    sendApp({ type: 'update_config', key: 'permission', value: selectedAccessMode });
  }
}

let lastSidebarRenderSig = '';

function compareThreads(a, b) {
  return (b.mtimeMs || 0) - (a.mtimeMs || 0);
}

function sortProjectsByDesktopOrder(projects) {
  const order = desktopProjectOrder || [];
  if (!order.length) {
    projects.sort((a, b) => (b.maxMtimeMs || 0) - (a.maxMtimeMs || 0));
    return projects;
  }
  const idx = new Map(order.map((name, i) => [name, i]));
  projects.sort((a, b) => {
    const ai = idx.has(a.name) ? idx.get(a.name) : Number.MAX_SAFE_INTEGER;
    const bi = idx.has(b.name) ? idx.get(b.name) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return (b.maxMtimeMs || 0) - (a.maxMtimeMs || 0);
  });
  return projects;
}

function groupThreadsByProject(rawThreads) {
  const pMap = new Map();
  rawThreads.forEach(t => {
    const key = t.projectName || '其他项目';
    if (!pMap.has(key)) {
      pMap.set(key, {
        id: t.projectId || '',
        name: key,
        cwd: t.cwd || '',
        isPinned: false,
        maxMtimeMs: 0,
        threads: []
      });
    }
    const proj = pMap.get(key);
    if (!proj.id && t.projectId) proj.id = t.projectId;
    proj.threads.push(t);
    if ((t.mtimeMs || 0) > proj.maxMtimeMs) proj.maxMtimeMs = t.mtimeMs || 0;
  });
  const projects = Array.from(pMap.values());
  projects.forEach((p) => p.threads.sort(compareThreads));
  return sortProjectsByDesktopOrder(projects);
}

function syncNewChatCwd(projects) {
  const btn = document.querySelector('.btn-new-task');
  const selected = projects.find(p => p.name === selectedProjectKey) || projects[0];
  if (btn && selected && selected.cwd) btn.dataset.cwd = selected.cwd;
}

function persistExpandedProjects() {
  localStorage.setItem('expandedProjects', JSON.stringify(Array.from(expandedProjects)));
}

function persistExpandedBuckets() {
  localStorage.setItem('expandedBuckets', JSON.stringify(expandedBuckets));
}

function matchThreadQuery(t, q) {
  return !q || (t.title || '').toLowerCase().includes(q);
}

function matchProjectQuery(p, q) {
  if (!q) return true;
  if ((p.name || '').toLowerCase().includes(q)) return true;
  return (p.threads || []).some((t) => matchThreadQuery(t, q));
}

function projectFolderThreads(proj, q) {
  const unpinned = (proj.threads || []).filter((t) => !t.isPinned);
  if (!q) return unpinned;
  if ((proj.name || '').toLowerCase().includes(q)) return unpinned;
  return unpinned.filter((t) => matchThreadQuery(t, q));
}

function renderThreadItem(t, projectName) {
  return `
      <div class="thread-item ${t.id === currentThreadId ? 'active' : ''}" data-id="${t.id}" data-title="${escapeHtml(t.title)}" data-project="${escapeHtml(projectName || t.projectName || '')}" title="双击重命名">
        ${t.isPinned ? '<span class="pin-mark" title="置顶">📌</span>' : ''}
        <span class="thread-item-title">${escapeHtml(t.title || '新聊天')}</span>
        ${t.isActive ? '<span class="status-pulse-dot"></span>' : ''}
      </div>
    `;
}

function renderProjectFolder(proj, threads) {
  const expanded = !!sidebarFilter.trim() || expandedProjects.has(proj.name);
  const threadsHtml = (threads || []).map((t) => renderThreadItem(t, proj.name)).join('');
  return `
      <div class="project-folder ${expanded ? 'expanded' : ''}" data-project="${escapeHtml(proj.name)}">
        <div class="project-folder-header" data-project="${escapeHtml(proj.name)}" data-cwd="${escapeHtml(proj.cwd || '')}">
          <span class="folder-chevron">▸</span>
          <span class="project-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
          </span>
          <span class="project-name">${escapeHtml(proj.name)}</span>
          ${proj.isPinned ? '<span class="pin-mark" title="置顶">📌</span>' : ''}
          <span class="project-count">${(threads || []).length}</span>
          <button type="button" class="btn-project-new" data-cwd="${escapeHtml(proj.cwd || '')}" title="在此项目新建对话">+</button>
        </div>
        <div class="project-items ${expanded ? '' : 'hidden'}">
          ${threadsHtml || '<div class="sidebar-empty">暂无对话</div>'}
        </div>
      </div>
    `;
}

function collectPinnedItems(allThreads, projects, q) {
  const threadMap = new Map(allThreads.map((t) => [t.id, t]));
  const projectMap = new Map();
  for (const p of projects) {
    if (p.id) projectMap.set(p.id, p);
    if (p.name && !projectMap.has(p.name)) projectMap.set(p.name, p);
  }
  const items = [];
  const seenThreads = new Set();
  const seenProjects = new Set();

  for (const entry of desktopPinnedOrder) {
    if (!entry || !entry.id) continue;
    if (entry.type === 'thread') {
      const t = threadMap.get(entry.id);
      if (!t || !matchThreadQuery(t, q)) continue;
      items.push({ type: 'thread', thread: t });
      seenThreads.add(t.id);
      continue;
    }
    if (entry.type === 'project') {
      const p = projectMap.get(entry.id);
      if (!p || !matchProjectQuery(p, q)) continue;
      items.push({ type: 'project', project: p });
      seenProjects.add(p.id || p.name);
    }
  }

  for (const t of allThreads) {
    if (!t.isPinned || seenThreads.has(t.id) || !matchThreadQuery(t, q)) continue;
    items.push({ type: 'thread', thread: t });
    seenThreads.add(t.id);
  }
  for (const p of projects) {
    const key = p.id || p.name;
    if (!p.isPinned || seenProjects.has(key) || !matchProjectQuery(p, q)) continue;
    items.push({ type: 'project', project: p });
    seenProjects.add(key);
  }
  return items;
}

function renderSidebarBucket(id, label, count, open, bodyHtml) {
  return `
      <div class="sidebar-bucket ${open ? 'expanded' : ''}" data-bucket="${id}">
        <div class="bucket-toggle" data-bucket="${id}">
          <span class="folder-chevron">▸</span>
          <span class="bucket-label">${label}</span>
          <span class="project-count">${count}</span>
        </div>
        <div class="bucket-body">${bodyHtml}</div>
      </div>
    `;
}

function renderSidebarLists() {
  if (renamingThreadId) return;
  const q = sidebarFilter.trim().toLowerCase();
  const searching = !!q;
  const allThreads = sidebarThreadsCache;
  const projects = sidebarProjectsCache;
  if (!threadListEl) return;

  const pinnedItems = collectPinnedItems(allThreads, projects, q);
  const visibleProjects = projects.filter((p) => !p.isPinned).map((p) => {
    const threads = projectFolderThreads(p, q);
    return { ...p, threads, visibleCount: threads.length };
  }).filter((p) => {
    if (searching) return p.visibleCount > 0 || p.name.toLowerCase().includes(q);
    return p.threads.length > 0;
  });
  const recent = allThreads.slice().sort(compareThreads).filter((t) => matchThreadQuery(t, q)).slice(0, RECENT_LIMIT);

  if (projectCountEl) projectCountEl.textContent = String(visibleProjects.length);

  if (!pinnedItems.length && !visibleProjects.length && !recent.length) {
    threadListEl.innerHTML = searching
      ? '<div class="sidebar-empty">暂无匹配项目</div>'
      : '<div class="sidebar-empty">暂无项目，点击上方新建。</div>';
    return;
  }

  const activeProject = visibleProjects.find((p) => p.threads.some((t) => t.id === currentThreadId))
    || projects.find((p) => p.name === selectedProjectKey)
    || pinnedItems.map((item) => item.project).find(Boolean)
    || visibleProjects[0]
    || projects[0];
  if (activeProject) {
    selectedProjectKey = activeProject.name;
    localStorage.setItem('activeProjectKey', selectedProjectKey);
  }

  const pinOpen = searching || (pinnedItems.length > 0 && expandedBuckets.pinned);
  const projOpen = searching || expandedBuckets.projects;
  const recOpen = searching || expandedBuckets.recent;

  const pinnedHtml = pinnedItems.map((item) => {
    if (item.type === 'project') return renderProjectFolder(item.project, projectFolderThreads(item.project, q));
    return renderThreadItem(item.thread);
  }).join('');
  const projectsHtml = visibleProjects.map((proj) => renderProjectFolder(proj, proj.threads)).join('');

  const html = [
    pinnedItems.length ? renderSidebarBucket('pinned', '置顶', pinnedItems.length, pinOpen, pinnedHtml) : '',
    renderSidebarBucket('projects', '项目', visibleProjects.length, projOpen, projectsHtml || '<div class="sidebar-empty">暂无对话</div>'),
    recent.length ? renderSidebarBucket('recent', '最近', recent.length, recOpen, recent.map((t) => renderThreadItem(t)).join('')) : ''
  ].join('');

  const renderSig = `${selectedProjectKey}::${currentThreadId}::${q}::${html}`;
  if (renderSig === lastSidebarRenderSig) return;
  lastSidebarRenderSig = renderSig;
  threadListEl.innerHTML = html;
  syncNewChatCwd(visibleProjects.length ? visibleProjects : projects);
}

function renderProjectTreeList(data) {
  try {
    let rawThreads = (data && data.threads) ? data.threads : [];
    const seenIds = new Set();
    rawThreads = rawThreads.filter(t => {
      if (!t.id || seenIds.has(t.id)) return false;
      seenIds.add(t.id);
      return true;
    });

    flatThreadIds = rawThreads.map(t => t.id);
    sidebarThreadsCache = rawThreads;
    desktopProjectOrder = Array.isArray(data && data.projectOrder) ? data.projectOrder : [];
    desktopPinnedOrder = Array.isArray(data && data.pinnedOrder) ? data.pinnedOrder : [];
    sidebarProjectsCache = Array.isArray(data && data.projects) && data.projects.length
      ? data.projects.map((p) => ({
          ...p,
          threads: Array.isArray(p.threads) ? p.threads.slice().sort(compareThreads) : []
        }))
      : groupThreadsByProject(rawThreads);
    if (expandedProjects.size === 0 && sidebarProjectsCache.length > 0) {
      const savedThreadId = (window.location.hash.replace('#thread-', '') || localStorage.getItem('activeThreadId') || '').trim();
      const host = sidebarProjectsCache.find((p) => p.threads.some((t) => t.id === savedThreadId || t.id === currentThreadId));
      expandedProjects.add((host || sidebarProjectsCache[0]).name);
      persistExpandedProjects();
    }

    if (sidebarProjectsCache.length === 0) {
      if (threadListEl) threadListEl.innerHTML = '<div class="sidebar-empty">暂无项目，点击上方新建。</div>';
      if (projectCountEl) projectCountEl.textContent = '0';
      return;
    }

    const hashThreadId = window.location.hash.replace('#thread-', '').trim();
    const savedThreadId = hashThreadId || localStorage.getItem('activeThreadId');
    const savedThread = rawThreads.find(t => t.id === savedThreadId);
    if (savedThread && savedThread.projectName) {
      selectedProjectKey = savedThread.projectName;
      localStorage.setItem('activeProjectKey', selectedProjectKey);
    }

    if (currentThreadId && !isOverlayLayout()) {
      const host = sidebarProjectsCache.find((p) => p.threads.some((t) => t.id === currentThreadId && !t.isPinned));
      if (host) expandedProjects.add(host.name);
      const live = rawThreads.find((t) => t.id === currentThreadId);
      if (live && live.title && !renamingThreadId) {
        safeSetText(activeSessionTitle, live.title);
        if (activeSessionTitle) activeSessionTitle.title = live.title;
      }
    }

    renderSidebarLists();

    if (!isInitialThreadAutoSelected) {
      isInitialThreadAutoSelected = true;
      const target = hashThreadId ? rawThreads.find(t => t.id === hashThreadId) : null;
      if (target) {
        try {
          selectThread(target.id, target.title);
        } catch (selectErr) {
          console.warn('Initial thread selection non-fatal error:', selectErr);
        }
      } else if (!currentThreadId) {
        enterNewChatState();
      }
    }
  } catch (err) {
    console.error('Error rendering project tree list:', err);
    if (threadListEl) threadListEl.innerHTML = `<div class="sidebar-empty">会话列表渲染异常: ${escapeHtml(err.message)}</div>`;
  }
}

function toggleProjectFolder(name) {
  if (!name) return;
  if (expandedProjects.has(name)) expandedProjects.delete(name);
  else {
    if (isOverlayLayout()) expandedProjects.clear();
    expandedProjects.add(name);
  }
  selectedProjectKey = name;
  localStorage.setItem('activeProjectKey', name);
  persistExpandedProjects();
  lastSidebarRenderSig = '';
  renderSidebarLists();
}

function toggleSidebarBucket(name) {
  if (!name || !Object.prototype.hasOwnProperty.call(expandedBuckets, name)) return;
  const next = !expandedBuckets[name];
  if (isOverlayLayout() && next) {
    if (name === 'recent') expandedBuckets.projects = false;
    if (name === 'projects') expandedBuckets.recent = false;
  }
  expandedBuckets[name] = next;
  persistExpandedBuckets();
  lastSidebarRenderSig = '';
  renderSidebarLists();
}

threadListEl.addEventListener('click', (e) => {
  if (e.target.closest('.thread-rename-input')) return;
  const newBtn = e.target.closest('.btn-project-new');
  if (newBtn) {
    e.preventDefault();
    e.stopPropagation();
    createNewChat(newBtn.getAttribute('data-cwd') || '');
    return;
  }
  const bucketToggle = e.target.closest('.bucket-toggle');
  if (bucketToggle) {
    toggleSidebarBucket(bucketToggle.getAttribute('data-bucket') || '');
    return;
  }
  const header = e.target.closest('.project-folder-header');
  if (header) {
    toggleProjectFolder(header.getAttribute('data-project') || '');
    const cwd = header.getAttribute('data-cwd') || '';
    const btn = document.querySelector('.btn-new-task');
    if (btn && cwd) btn.dataset.cwd = cwd;
    return;
  }
  const threadItem = e.target.closest('.thread-item');
  if (threadItem) {
    const id = threadItem.getAttribute('data-id');
    const title = threadItem.getAttribute('data-title') || '新聊天';
    const project = threadItem.getAttribute('data-project');
    if (project) {
      selectedProjectKey = project;
      localStorage.setItem('activeProjectKey', project);
      if (threadItem.closest('[data-bucket="projects"]')) {
        if (isOverlayLayout()) expandedProjects.clear();
        expandedProjects.add(project);
        persistExpandedProjects();
      }
    }
    if (id) selectThread(id, title);
  }
});

threadListEl.addEventListener('dblclick', (e) => {
  const threadItem = e.target.closest('.thread-item');
  if (!threadItem) return;
  e.preventDefault();
  startInlineRename(threadItem);
});

if (sidebarFilterEl) {
  sidebarFilterEl.addEventListener('input', (e) => {
    sidebarFilter = e.target.value || '';
    lastSidebarRenderSig = '';
    renderSidebarLists();
  });
}

function enterNewChatState() {
  currentThreadId = null;
  currentStatus = 'idle';
  localStorage.removeItem('activeThreadId');
  if (window.location.hash.startsWith('#thread-')) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  safeSetText(activeSessionTitle, '新对话');
  if (activeSessionTitle) activeSessionTitle.title = '新对话';
  document.querySelectorAll('.thread-item.active').forEach((el) => el.classList.remove('active'));
  if (chatFeed) {
    chatFeed.innerHTML = '<div class="empty-state"><div class="empty-icon"><img src="icons/codesk-app.png?v=3.38.0" alt=""></div><h2>新对话</h2><p>输入指令开始。标题会在首轮对话后自动生成，也可双击侧栏会话重命名。</p></div>';
  }
}

function placeholderTitleFromCwd(cwd) {
  const raw = String(cwd || '').trim().replace(/[\\/]+$/, '');
  if (!raw || raw === '/' || /^[a-zA-Z]:$/.test(raw)) return '/';
  const parts = raw.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] || '';
  if (!name || /^[a-zA-Z]:$/.test(name)) return '/';
  return `${name}/新聊天`;
}

function createNewChat(targetCwd) {
  if (!sessionReady) {
    showAuthOverlay(connMode === 'relay' ? 'pair' : 'login');
    return;
  }
  const title = placeholderTitleFromCwd(targetCwd);
  const payload = {
    type: 'create_thread',
    targetCwd: targetCwd || '',
    title
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendApp(payload);
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    pendingWsMessages.push(payload);
  } else {
    createThreadHTTP(title, targetCwd || '');
  }
}

function startInlineRename(threadItem) {
  const id = threadItem.getAttribute('data-id');
  const titleEl = threadItem.querySelector('.thread-item-title');
  if (!id || !titleEl || threadItem.querySelector('.thread-rename-input')) return;
  const current = titleEl.textContent || '';
  renamingThreadId = id;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'thread-rename-input';
  input.value = current;
  input.setAttribute('maxlength', '80');
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renamingThreadId = null;
    const next = input.value.trim();
    const span = document.createElement('span');
    span.className = 'thread-item-title';
    span.textContent = (save && next) ? next : current;
    if (input.parentNode) input.replaceWith(span);
    if (save && next && next !== current) renameThread(id, next);
    lastSidebarRenderSig = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
    e.stopPropagation();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

function renameThread(id, title) {
  const payload = { type: 'rename_thread', threadId: id, title };
  if (id === currentThreadId) {
    safeSetText(activeSessionTitle, title);
    if (activeSessionTitle) activeSessionTitle.title = title;
  }
  if (sendApp(payload)) return;
  apiFetch('/api/threads/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: id, title })
  }).catch((e) => console.error('rename failed', e));
}

// HTTP 兜底创建会话（WS 断开/重连中时使用）
async function createThreadHTTP(title, targetCwd) {
  try {
    const res = await apiFetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, targetCwd })
    });
    const json = await res.json();
    if (json.success && json.threadId) {
      selectThread(json.threadId, json.title || title);
      if (pendingFirstSend) {
        const pending = pendingFirstSend;
        pendingFirstSend = null;
        sendApp({
          type: 'send_message',
          threadId: json.threadId,
          text: pending.text,
          input: pending.input
        });
      }
    } else {
      alert(`新建会话失败: ${json.error || '未知错误'}`);
    }
  } catch (e) {
    console.error('HTTP create thread error:', e);
    alert(`新建会话失败: ${e.message}`);
  }
}

// Select Thread with Dual-Fetch Instant Loading (< 10ms Guarantee)
function selectThread(id, title) {
  currentThreadId = id;
  renderHiddenCount = 0; // 切换会话重置渐进渲染窗口
  safeSetText(activeSessionTitle, title);
  if (activeSessionTitle) activeSessionTitle.title = title || '';
  safeSetText(activeSessionId, id);
  
  // Persist Active Thread to LocalStorage & URL Hash
  localStorage.setItem('activeThreadId', id);
  if (window.location.hash !== `#thread-${id}`) {
    history.replaceState(null, '', `#thread-${id}`);
  }

  document.querySelectorAll('.thread-item').forEach(el => {
    const isActive = el.getAttribute('data-id') === id;
    el.classList.toggle('active', isActive);
    if (isActive) {
      // Auto expand parent folder if collapsed
      const parentItems = el.closest('.project-items');
      if (parentItems) parentItems.classList.remove('hidden');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  // Single-channel fetch: WebSocket preferred, HTTP REST fallback (no duplicate parsing)
  requestThreadHistory(id);
  if (typeof requestGitStatus === 'function') requestGitStatus();

  closeSidebar();
  if (isOverlayLayout()) closeRightPanel();
}

// 审批到达提醒：震动 + 轻提示音；PWA 在后台时弹系统通知（需授权）
let lastApprovalNotifyKey = '';

function playSoftBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 830;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => ctx.close();
  } catch (e) {}
}

function notifyApprovalIfNeeded(threadId, pendingApproval) {
  const key = `${threadId}:${pendingApproval ? (pendingApproval.id || '') + ':' + String(pendingApproval.command || '').slice(0, 60) : ''}`;
  if (key === lastApprovalNotifyKey) return;
  lastApprovalNotifyKey = key;

  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  playSoftBeep();

  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const body = pendingApproval && pendingApproval.command
        ? String(pendingApproval.command).replace(/\s+/g, ' ').slice(0, 120)
        : 'Codex 正在等待你的批准';
      new Notification('Codex 需要审批', { body, tag: 'codex-approval', renotify: true });
    } catch (e) {}
  }
}

function renderThreadDetail(data, opts = {}) {
  const { items, status, pendingApproval, tokenUsage, cwd } = data;
  currentStatus = status;

  // Capture scroll state before DOM rebuild (prevents viewport yanking while reading history)
  const wasNearBottom = chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight < 140;
  const prevScrollTop = chatFeed.scrollTop;
  const prevScrollHeight = chatFeed.scrollHeight;

  if (cwd && cwd !== currentCwd) {
    currentCwd = cwd;
    if (rightPanel && !rightPanel.classList.contains('collapsed')) {
      loadWorkspaceTree(cwd);
    }
  }

  updateSubagentPanel(items, status);

  if (tokenUsage) applyAccountQuota(tokenUsage);

  if (tokenUsage) {
    if (gaugeBarFill) {
      // 上下文窗口：同样倒计时方向，显示「剩余 xx%」
      const pct = tokenUsage.usedPercent;
      if (pct !== undefined && pct !== null) {
        const remainPct = Math.max(0, Math.min(100, Math.round(100 - pct)));
        gaugeBarFill.style.width = `${remainPct}%`;
        safeSetText(gaugePercentText, `剩余 ${remainPct}%`);
        const totalK = ((tokenUsage.totalTokens || 0) / 1000).toFixed(1);
        const maxK = ((tokenUsage.maxContext || 0) / 1000).toFixed(1);
        safeSetText(gaugeDetailText, `${totalK}K / ${maxK}K`);
      } else {
        gaugeBarFill.style.width = '0%';
        safeSetText(gaugePercentText, '--');
        safeSetText(gaugeDetailText, '待同步');
      }
    }
  }

  let currentStep = 0;
  let totalSteps = 0;

  if (items && items.length > 0) {
    items.forEach(item => {
      if (item.type === 'reasoning') {
        totalSteps++;
      } else if (item.type === 'custom_tool_call' || item.type === 'tool_call') {
        totalSteps++;
      }
    });
  }

  // 真实进度：当前已执行的推理/工具步骤数（不再用系数伪造进度）
  currentStep = Math.max(1, totalSteps);

  if (status === 'working') {
    renderStatusBadge('working', '运行中', '运行中');

    floatingCapsuleBadge.classList.remove('hidden');
    stepCounterText.textContent = `第 ${currentStep} / ${Math.max(totalSteps, 1)} 步`;

    modelSpinner.classList.remove('hidden');

    btnMainAction.className = 'btn-circle-action state-idle';
    btnMainAction.title = '追加到当前 Turn';
    if (btnStopTurn) btnStopTurn.classList.remove('hidden');
    if (msgInput) msgInput.placeholder = '追加指令…';

  } else if (status === 'waiting_approval') {
    renderStatusBadge('approval', '需要审批', '需审批');
    floatingCapsuleBadge.classList.add('hidden');
    modelSpinner.classList.add('hidden');
    notifyApprovalIfNeeded(currentThreadId, pendingApproval);

    btnMainAction.className = 'btn-circle-action state-idle';
    btnMainAction.title = '发送消息';
    if (btnStopTurn) btnStopTurn.classList.add('hidden');
    if (msgInput) msgInput.placeholder = '随心输入';

  } else {
    // 会话已结束：展示完成时间与总耗时（startedAt/completedAt 为 rollout 内时间戳，UTC → 本地）
    let doneText = '已就绪';
    const doneT = data.completedAt ? new Date(data.completedAt) : null;
    const startT = data.startedAt ? new Date(data.startedAt) : null;
    const hasDone = doneT && !isNaN(doneT.getTime());
    if (hasDone) {
      const pad = n => String(n).padStart(2, '0');
      // 完成状态只信任显式完成标记（task_complete / turn_completed）
      doneText = `已完成 ${pad(doneT.getMonth() + 1)}/${pad(doneT.getDate())} ${pad(doneT.getHours())}:${pad(doneT.getMinutes())}`;
      if (startT && !isNaN(startT.getTime()) && doneT >= startT) {
        const ms = doneT - startT;
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const dur = h > 0 ? `${h}小时${m}分` : (m > 0 ? `${m}分${s}秒` : `${s}秒`);
        doneText += ` · 耗时${dur}`;
      }
    }
    renderStatusBadge(hasDone ? 'done' : 'idle', doneText, hasDone ? '已完成' : '已就绪');
    floatingCapsuleBadge.classList.add('hidden');
    modelSpinner.classList.add('hidden');

    btnMainAction.className = 'btn-circle-action state-idle';
    btnMainAction.title = '发送消息';
    if (btnStopTurn) btnStopTurn.classList.add('hidden');
    if (msgInput) msgInput.placeholder = '随心输入';
  }

  const pendingId = pendingApproval && (pendingApproval.id || pendingApproval.requestId);
  const pendingDismissed = pendingId && dismissedApprovalKeys.has(approvalDismissKey(currentThreadId, pendingId));
  if (pendingApproval && !pendingDismissed) {
    currentPendingApproval = pendingApproval;
    approvalAlert.classList.remove('hidden');
    approvalDetail.textContent = decodeApprovalCommand(pendingApproval.command || '') || pendingApproval.reason || '检测到需要您确认的审批请求。';
  } else if (pendingApproval || !currentPendingApproval) {
    hideApprovalAlert();
  }

  if (!items || items.length === 0) {
    chatFeed.innerHTML = '<div class="empty-state"><div class="empty-icon"><img src="icons/codesk-app.png?v=3.38.0" alt=""></div><h2>当前会话还没有消息</h2><p>在下方输入指令，开始这段对话。</p></div>';
    return;
  }

  // 渐进渲染（轻量虚拟滚动）：首次只渲染末尾 RENDER_WINDOW 个节点，
  // 滚动到顶时哨兵再向前补 RENDER_CHUNK 个，几千条的长会话也不卡
  const MIN_VISIBLE = 10;
  renderHiddenCount = Math.max(0, Math.min(renderHiddenCount, items.length - MIN_VISIBLE));
  const from = renderHiddenCount;
  const windowedItems = items.slice(from);

  rebuildFileNameMap(items);
  const renderedNodes = renderDesktopFeedNodes(windowedItems);

  if (from > 0) {
    renderedNodes.unshift(`
      <div class="progressive-load-bar" id="progressive-load-bar">
        <span class="step-spinner">↻</span>
        <span>继续向上加载（还有 ${from} 条更早消息）</span>
      </div>
    `);
  }

  if (data.hasMore) {
    const remainingCount = (data.totalItems || 0) - (items ? items.length : 0);
    renderedNodes.unshift(`
      <div class="load-more-history-bar" data-action="load-more">
        <span class="load-more-icon">↑</span>
        <span>加载更早的历史消息 (剩余 ${remainingCount} 条)</span>
      </div>
    `);
  }

  if (status === 'working') {
    let latestCommandText = data.activeActionText || '正在运行...';
    if (!data.activeActionText && items && items.length > 0) {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.type === 'custom_tool_call' || item.type === 'tool_call') {
          const inputStr = typeof item.input === 'string' ? item.input : JSON.stringify(item.input || {});
          const cleanCmd = cleanText(inputStr).replace(/\\n/g, ' ').substring(0, 120);
          latestCommandText = `正在运行 ${cleanCmd}`;
          break;
        } else if (item.type === 'function_call') {
          // 与桌面端一致：显示真实工具活动（exec_command 显示实际命令）
          let args = item.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = null; } }
          const cmd = args && typeof args.cmd === 'string' ? cleanText(args.cmd).replace(/\\n/g, ' ').substring(0, 120) : '';
          const label = (item.name || 'tool').replace(/_/g, ' ');
          latestCommandText = cmd ? `正在执行: ${cmd}` : `正在调用 ${label}...`;
          break;
        } else if (item.type === 'reasoning') {
          latestCommandText = '正在深度思考与推理中...';
          break;
        }
      }
    }

    renderedNodes.push(`
      <div class="active-running-shimmer-bar">
        <span class="shimmer-icon">📄</span>
        <span class="shimmer-text">${escapeHtml(latestCommandText)}</span>
      </div>
    `);
  }

  if (renderedNodes.length === 0) {
    chatFeed.innerHTML = '<div class="empty-state"><div class="empty-icon"><img src="icons/codesk-app.png?v=3.38.0" alt=""></div><h2>当前会话还没有有效消息</h2><p>在下方输入指令，开始这段对话。</p></div>';
    return;
  }

  chatFeed.innerHTML = renderedNodes.join('');

  // 顶部哨兵进入视口 → 向前多渲染一批（渐进加载）
  const sentinel = document.getElementById('progressive-load-bar');
  if (sentinel) {
    if (progressiveObserver) progressiveObserver.disconnect();
    progressiveObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        progressiveObserver.disconnect();
        progressiveObserver = null;
        renderHiddenCount = Math.max(0, renderHiddenCount - RENDER_CHUNK);
        renderThreadDetail(clientThreadCache.get(currentThreadId), { preserveScroll: true });
      }
    }, { root: chatFeed, rootMargin: '300px' });
    progressiveObserver.observe(sentinel);
  }

  // Smart scrolling: only stick to bottom when the user was already there.
  // Loading older history preserves the viewport via offset compensation.
  if (opts.preserveScroll) {
    chatFeed.scrollTop = prevScrollTop + (chatFeed.scrollHeight - prevScrollHeight);
  } else if (wasNearBottom) {
    chatFeed.scrollTop = chatFeed.scrollHeight;
  } else {
    chatFeed.scrollTop = prevScrollTop;
  }

  // 搜索命中高亮：跳转后闪烁包含关键词的节点
  if (opts.highlightQuery) {
    const q = opts.highlightQuery.toLowerCase();
    let firstHit = null;
    chatFeed.querySelectorAll(':scope > *').forEach(el => {
      if (el.textContent && el.textContent.toLowerCase().includes(q)) {
        el.classList.add('search-hit-flash');
        if (!firstHit) firstHit = el;
      }
    });
    if (firstHit) firstHit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Non-blocking syntax highlighting on next animation frame for sub-1ms UI response
  if (typeof hljs !== 'undefined') {
    requestAnimationFrame(() => {
      chatFeed.querySelectorAll('pre code:not(.hljs-done)').forEach((block) => {
        block.classList.add('hljs-done');
        hljs.highlightElement(block);
        // 代码块复制按钮（委托给 data-action=copy-code）
        const pre = block.closest('pre');
        if (pre && !pre.querySelector('.code-toolbar')) {
          const lines = (block.textContent || '').split('\n').length;
          const collapsible = lines > 8;
          pre.classList.add('code-block');
          if (collapsible) pre.classList.add('collapsed', 'collapsible');
          const toolbar = document.createElement('div');
          toolbar.className = 'code-toolbar';
          if (collapsible) {
            toolbar.insertAdjacentHTML('beforeend', '<button class="code-tool-btn" data-action="toggle-code">展开</button>');
          }
          toolbar.insertAdjacentHTML('beforeend', '<button class="code-tool-btn" data-action="copy-code">复制</button>');
          pre.prepend(toolbar);
        }
      });
    });
  }
}

// Load Project Workspace Directory Tree (/api/workspace-tree?cwd=...)
async function loadWorkspaceTree(cwd) {
  if (!cwd) return;
  workspaceTreeBody.innerHTML = '<div class="loading-spinner">正在载入项目文件树...</div>';

  try {
    const res = await apiFetch(`/api/workspace-tree?cwd=${encodeURIComponent(cwd)}`);
    const data = await res.json();
    if (data.success) {
      currentWorkspaceTreeData = data;
      workspaceFolderName.textContent = `📁 ${data.rootName}`;
      collectFileMapFromTree(data.tree);
      renderWorkspaceTreeUI(data.tree, workspaceFileSearch.value.trim());
    } else {
      workspaceTreeBody.innerHTML = `<div class="placeholder-text">无法加载目录: ${escapeHtml(data.error)}</div>`;
    }
  } catch (e) {
    workspaceTreeBody.innerHTML = `<div class="placeholder-text">网络加载失败</div>`;
  }
}

function renderWorkspaceTreeUI(tree, filterKeyword = '') {
  if (!tree || tree.length === 0) {
    workspaceTreeBody.innerHTML = '<div class="placeholder-text">暂无可显示的文件</div>';
    return;
  }

  function renderItems(items, depth = 0) {
    let html = '';
    for (const item of items) {
      if (filterKeyword) {
        const matches = item.name.toLowerCase().includes(filterKeyword.toLowerCase());
        if (item.type === 'file' && !matches) continue;
      }

      const indent = depth * 12;
      if (item.type === 'directory') {
        const childrenHtml = item.children ? renderItems(item.children, depth + 1) : '';
        html += `
          <div class="tree-dir-group">
            <div class="tree-dir-item" style="padding-left: ${indent + 8}px;" data-action="toggle-dir">
              <span class="tree-arrow">›</span>
              <span class="tree-icon">📁</span>
              <span class="tree-name">${escapeHtml(item.name)}</span>
            </div>
            <div class="tree-children">
              ${childrenHtml}
            </div>
          </div>
        `;
      } else {
        const icon = item.ext === '.md' ? '📄' : (item.ext === '.json' || item.ext === '.toml' ? '⚙️' : '📄');
        html += `
          <div class="tree-file-item" style="padding-left: ${indent + 20}px;" data-path="${escapeHtml(item.path)}">
            <span class="tree-icon">${icon}</span>
            <span class="tree-name">${escapeHtml(item.name)}</span>
          </div>
        `;
      }
    }
    return html;
  }

  const treeHtml = renderItems(tree);
  workspaceTreeBody.innerHTML = treeHtml || '<div class="placeholder-text">未找到匹配文件</div>';
}

// Delegated Click Listener for Right Panel File Tree (Zero JS escaping syntax errors)
workspaceTreeBody.addEventListener('click', (e) => {
  const fileItem = e.target.closest('.tree-file-item');
  if (fileItem) {
    const filePath = fileItem.getAttribute('data-path');
    if (filePath) {
      openFileModal(filePath);
      if (isOverlayLayout()) closeRightPanel();
    }
  }
});

workspaceFileSearch.addEventListener('input', (e) => {
  if (currentWorkspaceTreeData) {
    renderWorkspaceTreeUI(currentWorkspaceTreeData.tree, e.target.value.trim());
  }
});

btnRefreshWorkspace.addEventListener('click', () => {
  if (currentCwd) {
    loadWorkspaceTree(currentCwd);
  }
});

const rightPanelOverlay = document.getElementById('right-panel-overlay');
const btnCloseRightPanel = document.getElementById('btn-close-right-panel');

if (btnToggleWorkspacePanel) {
  btnToggleWorkspacePanel.addEventListener('click', () => {
    if (!isOverlayLayout()) return;
    const isOpen = rightPanel.classList.contains('open');
    if (isOpen) closeRightPanel();
    else openRightPanel();
  });
}

window.addEventListener('resize', () => {
  if (isOverlayLayout()) return;
  if (rightPanel) rightPanel.classList.remove('open', 'collapsed');
  const overlay = document.getElementById('right-panel-overlay');
  if (overlay) overlay.classList.remove('active');
  if (btnToggleWorkspacePanel) btnToggleWorkspacePanel.classList.remove('active');
});

if (rightPanelOverlay) {
  rightPanelOverlay.addEventListener('click', closeRightPanel);
}

if (btnCloseRightPanel) {
  btnCloseRightPanel.addEventListener('click', closeRightPanel);
}

(function initRightPanelSheetGestures() {
  if (!rightPanel) return;
  let startY = 0;
  let tracking = false;
  rightPanel.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !rightPanel.classList.contains('open')) return;
    const t = e.touches[0];
    if (t.clientY - rightPanel.getBoundingClientRect().top > 64) return;
    startY = t.clientY;
    tracking = true;
  }, { passive: true });
  rightPanel.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    if (e.changedTouches[0].clientY - startY > 70) closeRightPanel();
  }, { passive: true });
})();

// Render Exact 100% Official Codex Desktop App Feed Nodes (Matches Left Screenshot Red Box 100%)
function renderDesktopFeedNodes(items, toolOutputs) {
  const nodes = [];
  let currentAssistantText = [];
  let pendingAgentBatch = [];
  let pendingAgentStatus = '';
  let pendingCommandBatch = [];

  function flushAssistantText() {
    if (currentAssistantText.length > 0) {
      const combinedText = cleanText(currentAssistantText.join('\n\n'));
      const html = combinedText ? renderMarkdown(combinedText) : '';
      const visible = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      if (visible) {
        nodes.push(`
          <div class="assistant-flow-block">
            <div class="markdown-body">${html}</div>
          </div>
        `);
      }
      currentAssistantText = [];
    }
  }

  // 100% Official Agent Status Node: 🟢 Main writer e25 e30  已更新
  // 价值低：移动端默认只显示前 2 个，点击「展开全部」查看其余（防撑破）
  function flushAgentBatch() {
    if (pendingAgentBatch.length > 0) {
      const badgesHtml = pendingAgentBatch.map(name => `
        <span class="inline-agent-node">
          <span class="agent-dot">🟢</span>
          <span class="agent-name-pill">${escapeHtml(cleanAgentName(name))}</span>
          <span class="agent-status-text">${escapeHtml(pendingAgentStatus || '已更新')}</span>
        </span>
      `).join('');

      const extraCount = pendingAgentBatch.length - 2;
      const toggleBtn = extraCount > 0
        ? `<button class="agent-toggle-btn" data-action="toggle-agent-list">展开全部 (+${extraCount})</button>`
        : '';

      nodes.push(`
        <div class="inline-node agent-status-list">
          ${badgesHtml}
          ${toggleBtn}
        </div>
      `);
      pendingAgentBatch = [];
      pendingAgentStatus = '';
    }
  }

  function flushCommandBatch() {
    if (!pendingCommandBatch.length) return;
    const cards = pendingCommandBatch.map((entry) => {
      if (entry && entry.kind === 'file') return renderFileChangeCard(entry.item);
      return renderCommandCard(entry && entry.item ? entry.item : { input: entry });
    });
    nodes.push(`<div class="command-card-stack">${cards.join('')}</div>`);
    pendingCommandBatch = [];
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const type = item.type;

    if (type === 'message') {
      const role = item.role || 'assistant';
      if (role === 'developer') continue;

      let rawText = '';
      if (typeof item.content === 'string') {
        rawText = item.content;
      } else if (Array.isArray(item.content)) {
        rawText = item.content.map(c => typeof c === 'string' ? c : (c.text || '')).join('\n');
      }

      const text = cleanText(rawText);
      if (!text) continue;

      if (text.startsWith('<app-context>') || text.startsWith('<recommended_plugins>') || text.startsWith('<multi_agent_mode>')) {
        continue;
      }

      if (role === 'user') {
        flushAssistantText();
        flushAgentBatch();
        flushCommandBatch();

        const linesCount = text.split('\n').length;
        const isLongPrompt = linesCount > 5 || text.length > 180;

        nodes.push(`
          <div class="message-card role-user">
            <div class="message-header">👤 USER 用户指令</div>
            <div class="user-prompt-wrapper">
              <div class="user-prompt-content ${isLongPrompt ? 'collapsed' : ''}">
                <div class="markdown-body">${renderMarkdown(text)}</div>
              </div>
              ${isLongPrompt ? `<button class="btn-toggle-prompt" data-action="toggle-prompt">展开全文 ˅</button>` : ''}
            </div>
          </div>
        `);
      } else {
        flushCommandBatch();
        currentAssistantText.push(text);
      }
    }

    else if (type === 'agent_message') {
      flushAssistantText();
      flushCommandBatch();
      let agentName = item.author || item.recipient || 'Main writer e25 e30';
      let rawText = typeof item.content === 'string' ? item.content : (Array.isArray(item.content) ? item.content.map(c => c.text || '').join(' ') : '');
      let statusLabel = rawText.includes('NEW_TASK') ? '已开始工作' : '已更新';

      if (pendingAgentBatch.length > 0 && pendingAgentStatus !== statusLabel) {
        flushAgentBatch();
      }
      pendingAgentBatch.push(agentName);
      pendingAgentStatus = statusLabel;
    }

    else if (type === 'custom_tool_call' || type === 'tool_call' || type === 'function_call' || type === 'fileChange' || type === 'file_change') {
      flushAssistantText();
      flushAgentBatch();
      if (isFileChangeItem(item)) {
        if (pendingCommandBatch.length && pendingCommandBatch[pendingCommandBatch.length - 1].kind !== 'file') flushCommandBatch();
        pendingCommandBatch.push({ kind: 'file', item });
      } else {
        pendingCommandBatch.push({ kind: 'cmd', item });
      }
    }

    else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_call_output') {
      const last = pendingCommandBatch[pendingCommandBatch.length - 1];
      if (last && last.item) last.item = Object.assign({}, last.item, { output: item.output || item.content || item.stdout || '' });
    }

    else if (type === 'context_compression' || type === 'auto_compressed') {
      flushAssistantText();
      flushAgentBatch();
      flushCommandBatch();
      nodes.push(`
        <div class="inline-node">
          <span class="inline-node-icon">🔄</span>
          <span>上下文已自动压缩</span>
        </div>
      `);
    }
  }

  flushAssistantText();
  flushAgentBatch();
  flushCommandBatch();
  return nodes;
}

function parseJsonish(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch (e) { return null; }
}

function describeToolItem(item) {
  const name = item && (item.name || item.tool || '') || '';
  const args = parseJsonish(item && item.arguments) || parseJsonish(item && item.input) || (item && typeof item.input === 'object' ? item.input : null);
  const cmd = (args && (args.cmd || args.command)) || (item && typeof item.input === 'string' ? item.input : '') || '';
  const patch = args && (args.patch || args.diff || args.delta);
  const path = args && (args.path || args.file || args.filename);
  return { name, args, cmd: String(cmd || '').trim(), patch, path };
}

function isFileChangeItem(item) {
  const t = item && item.type || '';
  if (t === 'fileChange' || t === 'file_change') return true;
  const d = describeToolItem(item);
  return ['apply_patch', 'apply_delta', 'write_file', 'edit'].includes(d.name);
}

function parsePatchStats(text) {
  const files = [];
  let add = 0;
  let del = 0;
  let current = null;
  String(text || '').split('\n').forEach((line) => {
    const named = line.match(/^\*\*\*\s+(Add|Update|Delete|Rename)\s+File:\s+(.+)/i);
    if (named) {
      current = { path: named[2].trim(), add: 0, del: 0 };
      files.push(current);
      return;
    }
    const unified = line.match(/^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+)/);
    if (unified && unified[1] !== '/dev/null') {
      const p = unified[1].trim();
      if (!current || current.path !== p) {
        current = { path: p, add: 0, del: 0 };
        files.push(current);
      }
      return;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      add += 1;
      if (current) current.add += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      del += 1;
      if (current) current.del += 1;
    }
  });
  return { files, add, del };
}

function renderFileChangeCard(item) {
  const d = describeToolItem(item);
  const stats = parsePatchStats(d.patch || item.patch || item.diff || '');
  let files = stats.files.slice();
  if (Array.isArray(item.changes)) {
    files = item.changes.map((c) => ({
      path: c.path || c.file || '',
      add: c.add || c.additions || 0,
      del: c.del || c.deletions || 0
    }));
  }
  if (!files.length && (d.path || item.path)) {
    files = [{ path: d.path || item.path, add: item.additions || 0, del: item.deletions || 0 }];
  }
  const add = files.reduce((sum, f) => sum + (f.add || 0), 0) || stats.add;
  const del = files.reduce((sum, f) => sum + (f.del || 0), 0) || stats.del;
  const rows = files.slice(0, 10).map((f) => `
    <div class="file-change-row">
      <span class="file-change-path" data-file-path="${escapeHtml(resolveFileRef(f.path || ''))}">${escapeHtml(f.path || '')}</span>
      <span class="file-change-stats"><span class="diff-add">+${f.add || 0}</span> <span class="diff-del">-${f.del || 0}</span></span>
    </div>
  `).join('');
  return `
    <div class="file-change-card">
      <div class="file-change-header">
        <div class="file-change-left">
          <div class="file-change-icon-box">✎</div>
          <div>
            <div class="file-change-title">已更改 ${files.length || 1} 个文件</div>
            <div class="file-change-stats"><span class="diff-add">+${add}</span><span class="diff-del">-${del}</span></div>
          </div>
        </div>
      </div>
      ${rows ? `<div class="file-change-list">${rows}</div>` : ''}
    </div>
  `;
}

function renderCommandCard(item) {
  const d = describeToolItem(item);
  const label = TOOL_LABELS[d.name] || (d.name || '命令').replace(/_/g, ' ');
  const body = d.cmd || d.path || (d.args ? JSON.stringify(d.args, null, 2) : '') || '';
  const out = item.output || item.stdout || '';
  return `
    <div class="command-card">
      <div class="command-card-head">
        <span class="command-card-icon">$</span>
        <span class="command-card-label">${escapeHtml(label)}</span>
      </div>
      ${body ? `<pre class="command-card-cmd">${escapeHtml(String(body).slice(0, 2000))}</pre>` : ''}
      ${out ? `<pre class="command-card-out">${escapeHtml(String(out).slice(0, 2000))}</pre>` : ''}
    </div>
  `;
}

function collectSubagents(items, status) {
  const names = [];
  (items || []).forEach((item) => {
    if (item.type === 'function_call' && item.name === 'add_delegated_agent') {
      const args = parseJsonish(item.arguments) || {};
      names.push(args.name || args.agent || '子智能体');
    } else if (item.type === 'agent_message') {
      names.push(cleanAgentName(item.author || item.recipient));
    }
  });
  const unique = [];
  names.forEach((n) => { if (n && unique.indexOf(n) < 0) unique.push(n); });
  return { running: status === 'working' ? unique.length : 0, names: unique };
}

function updateSubagentPanel(items, status) {
  const el = document.getElementById('subagent-list');
  if (!el) return;
  const info = collectSubagents(items, status);
  if (!info.running) {
    el.innerHTML = '<span class="subagent-status-tag">没有运行中的子智能体</span>';
    return;
  }
  el.innerHTML = `<span class="subagent-status-tag">🟢 ${info.running} 个运行中</span>` +
    info.names.slice(0, 6).map((n) => `<div class="subagent-name">${escapeHtml(n)}</div>`).join('');
}

function toggleUserPrompt(btn) {
  const wrapper = btn.closest('.user-prompt-wrapper');
  if (!wrapper) return;
  const content = wrapper.querySelector('.user-prompt-content');
  if (!content) return;
  const isCollapsed = content.classList.contains('collapsed');
  if (isCollapsed) {
    content.classList.remove('collapsed');
    btn.textContent = '收起 ˄';
  } else {
    content.classList.add('collapsed');
    btn.textContent = '展开全文 ˅';
  }
}

async function loadFullHistory(id) {
  if (!id) return;
  const bar = document.querySelector('.load-more-history-bar');
  if (bar) bar.innerHTML = '<span class="step-spinner">↻</span> 正在载入更早消息...';
  try {
    const res = await apiFetch(`/api/thread-history?threadId=${encodeURIComponent(id)}&all=true`);
    const json = await res.json();
    if (json.success && json.data) {
      clientThreadCache.set(id, json.data);
      if (json.threadId === currentThreadId) {
        // 全量可能上千条：初始只渲染末尾窗口，向上滚动再渐进补
        renderHiddenCount = Math.max(0, (json.data.items?.length || 0) - 120);
        renderThreadDetail(json.data, { preserveScroll: true });
      }
    }
  } catch (e) {
    console.error('Error loading full history:', e);
  }
}

function cleanAgentName(name) {
  if (!name) return 'Main writer e25 e30';
  // UUID 形态的 agent 标识对用户无意义，显示为友好名称
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return '子智能体';
  const parts = name.split(/[\/\\]/);
  return parts[parts.length - 1].replace(/_/g, ' ');
}

function cleanText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

const markdownCache = new Map();
const FILE_REF_EXT = 'md|txt|json|py|js|mjs|cjs|ts|tsx|jsx|rs|toml|html|css|yml|yaml|csv|xml|log|mdc';
const ABS_FILE_SRC = String.raw`(?:file:/{2,3}[^\s)\]<>"'\\\`]+|[A-Za-z]:[\\/][^\s)\]<>"'\\\`]+\.(?:${FILE_REF_EXT}))`;
const FILE_NAME_RE = new RegExp(String.raw`^[^\\/:*?"<>|\s]+\.(?:${FILE_REF_EXT})$`, 'i');
let fileNameMap = new Map();

function stripMemCitation(text) {
  if (!text || !/<oai-mem-citation>/i.test(text)) return text;
  let cleaned = text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function stripFileUrl(p) {
  let s = String(p || '').trim();
  s = s.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
  try { s = decodeURIComponent(s); } catch (e) {}
  return s;
}

function isAbsFilePath(p) {
  const s = stripFileUrl(p);
  return /^[A-Za-z]:[\\/]/.test(s);
}

function fileBasename(p) {
  const clean = stripFileUrl(p).replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

function looksLikeFileRef(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || t.length > 260 || /^https?:/i.test(t)) return false;
  if (isAbsFilePath(t)) return true;
  if (FILE_NAME_RE.test(t)) return true;
  return /[\\/]/.test(t) && new RegExp(String.raw`\.(?:${FILE_REF_EXT})$`, 'i').test(t);
}

function registerFilePath(p) {
  const clean = stripFileUrl(p);
  if (!clean) return;
  const name = fileBasename(clean);
  if (!name) return;
  const key = name.toLowerCase();
  if (!fileNameMap.has(key)) fileNameMap.set(key, clean);
}

function resolveFileRef(ref) {
  const raw = stripFileUrl(ref);
  if (!raw) return '';
  if (isAbsFilePath(raw)) {
    registerFilePath(raw);
    return raw;
  }
  const mapped = fileNameMap.get(fileBasename(raw).toLowerCase());
  if (mapped) return mapped;
  if (currentCwd) {
    const sep = currentCwd.includes('\\') ? '\\' : '/';
    return currentCwd.replace(/[\\/]+$/, '') + sep + raw.replace(/^[\\/]+/, '');
  }
  return raw;
}

function collectFileMapFromText(text) {
  if (!text) return;
  const re = new RegExp(ABS_FILE_SRC, 'gi');
  let m;
  while ((m = re.exec(text))) registerFilePath(m[0]);
}

function collectFileMapFromTree(items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (item.type === 'file' && item.path) registerFilePath(item.path);
    if (item.children) collectFileMapFromTree(item.children);
  }
}

function rebuildFileNameMap(items) {
  fileNameMap = new Map();
  if (currentWorkspaceTreeData && currentWorkspaceTreeData.tree) {
    collectFileMapFromTree(currentWorkspaceTreeData.tree);
  }
  if (!Array.isArray(items)) return;
  for (const item of items) {
    let text = '';
    if (typeof item.content === 'string') text = item.content;
    else if (Array.isArray(item.content)) {
      text = item.content.map(c => typeof c === 'string' ? c : (c && c.text) || '').join('\n');
    }
    if (item.input) text += '\n' + (typeof item.input === 'string' ? item.input : JSON.stringify(item.input));
    collectFileMapFromText(text);
  }
}

function makeFileLink(fullPath, label) {
  const clean = stripFileUrl(fullPath);
  const rawLabel = String(label || '').replace(/<[^>]+>/g, '').replace(/^📄\s*/, '').trim();
  const text = rawLabel && !isAbsFilePath(rawLabel) && rawLabel.length < 80 ? rawLabel : fileBasename(clean);
  return `<a class="file-link-inline" title="${escapeHtml(clean)}" data-file-path="${escapeHtml(clean)}"><span class="file-link-icon">📄</span><span class="file-link-text">${escapeHtml(text)}</span></a>`;
}

function alreadyInsideFileAttr(html, offset) {
  const before = html.slice(Math.max(0, offset - 24), offset);
  return /(?:data-file-path|title|href)=["']?$/.test(before);
}

function renderMarkdown(text) {
  if (!text) return '';
  text = stripMemCitation(text);
  collectFileMapFromText(text);
  const cacheKey = `${fileNameMap.size}::${text}`;
  if (markdownCache.has(cacheKey)) {
    return markdownCache.get(cacheKey);
  }

  let html = '';
  if (typeof marked !== 'undefined') {
    html = marked.parse(text);
  } else {
    html = escapeHtml(text);
  }

  html = html.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (match, href, innerText) => {
    if (href.startsWith('file:') || isAbsFilePath(href) || looksLikeFileRef(stripFileUrl(href))) {
      return makeFileLink(resolveFileRef(href), innerText);
    }
    return match;
  });

  html = html.replace(/<code>([^<]+)<\/code>/gi, (match, inner) => {
    const ref = String(inner || '').trim();
    if (!looksLikeFileRef(ref)) return match;
    return makeFileLink(resolveFileRef(ref), fileBasename(ref));
  });

  html = html.replace(new RegExp(ABS_FILE_SRC, 'gi'), (match, offset, str) => {
    if (alreadyInsideFileAttr(str, offset)) return match;
    return makeFileLink(match);
  });

  html = html.replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '');

  html = html.replace(/<pre><code(.*?)>([\s\S]*?)<\/code><\/pre>/gi, (match, attrs, code) => {
    return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">代码片段</span><button type="button" class="btn-copy-code" data-action="copy-code">复制</button></div><pre><code${attrs}>${code}</code></pre></div>`;
  });

  if (markdownCache.size > 800) {
    const firstKey = markdownCache.keys().next().value;
    markdownCache.delete(firstKey);
  }
  markdownCache.set(cacheKey, html);

  return html;
}

window.copyCodeBlock = function(btn) {
  const pre = btn.closest('.code-block-wrapper')?.querySelector('pre');
  if (!pre) return;
  const text = pre.innerText || pre.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓ 已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1800);
  }).catch(() => {
    btn.textContent = '复制失败';
  });
};

// Open File Preview Modal (invoked via data-file-path event delegation)
async function openFileModal(filePath) {
  fileModal.classList.remove('hidden');
  fileModalName.textContent = '正在读取文件...';
  fileModalPath.textContent = filePath;
  fileModalBody.innerHTML = '<div class="loading-spinner">⚡ 正在读取本地磁盘物理文件并在线渲染 Markdown...</div>';

  try {
    const qs = new URLSearchParams({ path: filePath });
    if (currentCwd) qs.set('cwd', currentCwd);
    const res = await apiFetch(`/api/file?${qs.toString()}`);
    const data = await res.json();
    if (data.success) {
      lastFileMeta = { name: data.fileName, path: data.path, content: data.content || '' };
      fileModalName.textContent = `📄 ${data.fileName}`;
      fileModalPath.textContent = data.path;

      if (data.ext === '.md' || data.fileName.endsWith('.md')) {
        const renderedHtml = typeof marked !== 'undefined' ? marked.parse(data.content) : escapeHtml(data.content);
        fileModalBody.innerHTML = `
          <div class="file-preview-banner">
            <span>✨ 格式：Markdown 文档</span>
            <span class="file-size-tag">${data.content.length} 字符</span>
          </div>
          <div class="markdown-body">${renderedHtml}</div>
        `;
      } else {
        fileModalBody.innerHTML = `
          <div class="file-preview-banner">
            <span>📄 代码 / 文本文件 (${data.ext})</span>
            <span class="file-size-tag">${data.content.length} 字符</span>
          </div>
          <pre><code>${escapeHtml(data.content)}</code></pre>
        `;
      }

      if (typeof hljs !== 'undefined') {
        fileModalBody.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
      }
    } else {
      fileModalBody.innerHTML = `<div class="approval-alert">❌ 无法读取该文件: ${escapeHtml(data.error || '文件不存在或无法访问')}</div>`;
    }
  } catch (err) {
    fileModalBody.innerHTML = `<div class="approval-alert">❌ 网络加载异常: ${escapeHtml(err.message)}</div>`;
  }
};

btnCloseFileModal.addEventListener('click', () => {
  fileModal.classList.add('hidden');
});

function nextAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderAttachmentChips() {
  if (!attachmentChips) return;
  if (!pendingAttachments.length) {
    attachmentChips.classList.add('hidden');
    attachmentChips.innerHTML = '';
    return;
  }
  attachmentChips.classList.remove('hidden');
  attachmentChips.innerHTML = pendingAttachments.map((att) => {
    const thumb = att.previewUrl
      ? `<img src="${att.previewUrl}" alt="">`
      : `<span class="attachment-chip-icon">${att.type === 'skill' ? '⚡' : '📄'}</span>`;
    return `<span class="attachment-chip" data-att-id="${att.id}">${thumb}<span class="attachment-chip-name">${escapeHtml(att.name)}</span><button type="button" class="attachment-chip-remove" data-action="remove-attachment" data-att-id="${att.id}" title="移除">✕</button></span>`;
  }).join('');
}

function removeAttachment(id) {
  const att = pendingAttachments.find((item) => item.id === id);
  if (!att) return;
  if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
  if (att.type === 'mention' && msgInput) {
    const pattern = new RegExp(`\\s?@${escapeRegExp(att.name)}\\s?`, 'g');
    msgInput.value = msgInput.value.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
  }
  pendingAttachments = pendingAttachments.filter((item) => item.id !== id);
  renderAttachmentChips();
}

function clearComposer() {
  for (const att of pendingAttachments) {
    if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
  }
  pendingAttachments = [];
  renderAttachmentChips();
  if (msgInput) msgInput.value = '';
}

function buildTurnInput() {
  const input = [];
  let text = msgInput ? msgInput.value.trim() : '';
  const mentions = pendingAttachments
    .filter((att) => att.type === 'mention')
    .sort((a, b) => b.name.length - a.name.length);
  for (const mention of mentions) {
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(mention.name)}(?=$|\\s)`, 'g');
    text = text.replace(pattern, `$1@${mention.path}`);
    input.push({ type: 'mention', name: mention.name, path: mention.path });
  }
  for (const att of pendingAttachments) {
    if (att.type === 'localImage') input.push({ type: 'localImage', path: att.path });
    if (att.type === 'skill') input.push({ type: 'skill', name: att.name, path: att.path });
  }
  if (text) input.push({ type: 'text', text, text_elements: [] });
  return input;
}

async function uploadLocalFile(file) {
  const res = await apiFetch(`/api/upload?name=${encodeURIComponent(file.name || 'file')}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || `上传失败 (${res.status})`);
  return json;
}

async function attachLocalFile(file) {
  const uploaded = await uploadLocalFile(file);
  if (file.type && file.type.startsWith('image/')) {
    pendingAttachments.push({
      id: nextAttachmentId(),
      type: 'localImage',
      name: uploaded.name || file.name || 'image',
      path: uploaded.path,
      previewUrl: URL.createObjectURL(file)
    });
  } else {
    const name = uploaded.name || file.name || 'file';
    pendingAttachments.push({
      id: nextAttachmentId(),
      type: 'mention',
      name,
      path: uploaded.path
    });
    if (msgInput) {
      const prefix = msgInput.value && !msgInput.value.endsWith(' ') ? ' ' : '';
      msgInput.value += `${prefix}@${name} `;
    }
  }
  renderAttachmentChips();
}

function handleMainAction() {
  hideSlashMenu();
  if (!sessionReady) {
    showAuthOverlay(deviceToken ? 'offline' : 'login');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showGestureToast('还没连上，稍后再发');
    return;
  }
  if (currentStatus === 'waiting_approval') {
    showGestureToast('请先处理审批');
    return;
  }
  const input = buildTurnInput();
  if (!input.length) return;
  const text = msgInput ? msgInput.value.trim() : '';
  if (!currentThreadId) {
    pendingFirstSend = { input, text };
    const cwd = document.querySelector('.btn-new-task')?.dataset.cwd || '';
    createNewChat(cwd);
    clearComposer();
    return;
  }
  const type = currentStatus === 'working' ? 'send_steer' : 'send_message';
  sendApp({
    type,
    threadId: currentThreadId,
    text,
    input
  });
  clearComposer();
}

btnMainAction.addEventListener('click', handleMainAction);

msgInput.addEventListener('keydown', (e) => {
  if (slashMenu && !slashMenu.classList.contains('hidden')) {
    const items = Array.from(slashMenu.querySelectorAll('.slash-item'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      slashIndex = e.key === 'ArrowDown'
        ? Math.min(items.length - 1, slashIndex + 1)
        : Math.max(0, slashIndex - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === slashIndex));
      return;
    }
    if (e.key === 'Enter' && items[slashIndex]) {
      e.preventDefault();
      applySlashItem(items[slashIndex].dataset.cmd);
      return;
    }
    if (e.key === 'Escape') {
      hideSlashMenu();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleMainAction();
  }
});

// 2-Tier Model & Reasoning Selector Popup Menu Listeners (Dynamically Syncing C:\Users\zhang\.codex\config.toml)
loadModelCatalog();

modelSelectorBadge.addEventListener('click', (e) => {
  e.stopPropagation();
  modelPopupMenu.classList.toggle('hidden');
  modelSubmenuCard.classList.add('hidden');
});

document.addEventListener('click', (e) => {
  if (!modelSelectorBadge.contains(e.target) && !modelPopupMenu.contains(e.target) && !modelSubmenuCard.contains(e.target)) {
    modelPopupMenu.classList.add('hidden');
    modelSubmenuCard.classList.add('hidden');
  }
});

// Open Submenu on Click
document.querySelectorAll('.popup-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const menuType = item.getAttribute('data-menu');

    // 移动端：二级菜单替换一级菜单（同位置显示），避免总宽超出屏幕
    const openSubmenu = () => {
      modelSubmenuCard.classList.remove('hidden');
      if (isMobileLayout()) modelPopupMenu.classList.add('hidden');
    };

    if (menuType === 'model') {
      submenuTitleBar.textContent = '模型选择';
      const models = catalogModels.length ? catalogModels : [{ id: selectedModel, displayName: modelDisplayName(selectedModel), description: '' }];
      submenuOptionsList.innerHTML = models.map((model) => `
        <div class="submenu-option ${model.id === selectedModel ? 'selected' : ''}" data-action="select-model" data-value="${escapeHtml(model.id)}">
          <div class="submenu-option-header">
            <span>${escapeHtml(model.displayName || model.id)}</span>
            ${model.id === selectedModel ? '<span>✓</span>' : ''}
          </div>
          ${model.description ? `<div class="submenu-option-desc">${escapeHtml(model.description)}</div>` : ''}
        </div>
      `).join('');
      openSubmenu();
    } else if (menuType === 'effort') {
      submenuTitleBar.textContent = '推理强度';
      const efforts = currentEffortOptions();
      submenuOptionsList.innerHTML = efforts.map((eff) => `
        <div class="submenu-option ${eff.id === selectedEffort ? 'selected' : ''}" data-action="select-effort" data-value="${escapeHtml(eff.id)}">
          <div class="submenu-option-header">
            <span>${escapeHtml(effortLabel(eff.id))}</span>
            ${eff.id === selectedEffort ? '<span>✓</span>' : ''}
          </div>
          ${eff.description ? `<div class="submenu-option-desc">${escapeHtml(eff.description)}</div>` : ''}
        </div>
      `).join('');
      openSubmenu();
    }
  });
});

// 移动端二级菜单返回一级菜单
if (submenuBackBtn) submenuBackBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  modelSubmenuCard.classList.add('hidden');
  modelPopupMenu.classList.remove('hidden');
});

function selectModel(modelId) {
  selectedModel = modelId;
  const model = findCatalogModel(modelId);
  const supported = currentEffortOptions().map((item) => item.id);
  if (model && supported.length && !supported.includes(selectedEffort)) {
    selectedEffort = model.defaultReasoningEffort || supported[0];
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendApp({ type: 'update_config', key: 'effort', value: selectedEffort });
    }
  }
  refreshModelLabels();
  modelSubmenuCard.classList.add('hidden');
  modelPopupMenu.classList.add('hidden');

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendApp({ type: 'update_config', key: 'model', value: modelId });
  }
}

function selectEffort(effortId) {
  selectedEffort = normalizeEffortId(effortId);
  refreshModelLabels();
  modelSubmenuCard.classList.add('hidden');
  modelPopupMenu.classList.add('hidden');

  sendApp({ type: 'update_config', key: 'effort', value: selectedEffort });
}

btnAddFile.addEventListener('click', () => {
  if (filePicker) filePicker.click();
});

const btnSkill = document.getElementById('btn-skill');
const skillPopup = document.getElementById('skill-popup');
const skillSearch = document.getElementById('skill-search');
const skillListEl = document.getElementById('skill-list');
const btnSkillManage = document.getElementById('btn-skill-manage');
const btnMcp = document.getElementById('btn-mcp');
const mcpPopup = document.getElementById('mcp-popup');
const mcpListEl = document.getElementById('mcp-list');
const mcpBtnLabel = document.getElementById('mcp-btn-label');
const btnMcpReload = document.getElementById('btn-mcp-reload');
let skillCache = [];
let skillManageMode = false;
let mcpCache = [];

function closeComposerPopups(except) {
  if (skillPopup && except !== skillPopup) skillPopup.classList.add('hidden');
  if (mcpPopup && except !== mcpPopup) mcpPopup.classList.add('hidden');
  const accessMenu = document.getElementById('access-popup-menu');
  if (accessMenu && except !== accessMenu) accessMenu.classList.add('hidden');
}

function attachSkill(skill) {
  if (!skill || !skill.path) return;
  if (pendingAttachments.some((att) => att.type === 'skill' && att.path === skill.path)) return;
  pendingAttachments.push({
    id: nextAttachmentId(),
    type: 'skill',
    name: skill.name,
    path: skill.path
  });
  renderAttachmentChips();
}

function renderSkillList() {
  if (!skillListEl) return;
  const q = (skillSearch && skillSearch.value || '').trim().toLowerCase();
  const rows = skillCache.filter((skill) => {
    if (!skillManageMode && skill.enabled === false) return false;
    if (!q) return true;
    return String(skill.name || '').toLowerCase().includes(q) || String(skill.description || '').toLowerCase().includes(q);
  });
  if (!rows.length) {
    skillListEl.innerHTML = `<div class="composer-popup-empty">${skillCache.length ? '没有匹配的 Skill' : '没有可用 Skill'}</div>`;
    return;
  }
  skillListEl.innerHTML = rows.map((skill) => {
    const idx = skillCache.indexOf(skill);
    const desc = escapeHtml(skill.shortDescription || skill.description || '');
    if (skillManageMode) {
      return `<div class="composer-item ${skill.enabled === false ? 'disabled' : ''}">
        <div class="composer-item-body">
          <span class="composer-item-title">${escapeHtml(skill.name)}</span>
          ${desc ? `<span class="composer-item-desc">${desc}</span>` : ''}
        </div>
        <button type="button" class="skill-toggle ${skill.enabled === false ? '' : 'on'}" data-action="toggle-skill" data-index="${idx}" title="启用/停用"></button>
      </div>`;
    }
    return `<button type="button" class="composer-item" data-action="select-skill" data-index="${idx}">
      <div class="composer-item-body">
        <span class="composer-item-title">${escapeHtml(skill.name)}</span>
        ${desc ? `<span class="composer-item-desc">${desc}</span>` : ''}
      </div>
    </button>`;
  }).join('');
}

async function loadSkills() {
  if (!skillListEl) return;
  skillListEl.innerHTML = '<div class="composer-popup-hint">正在加载 Skill…</div>';
  try {
    const cwd = encodeURIComponent(currentCwd || '');
    const res = await apiFetch(`/api/skills?cwd=${cwd}`);
    const json = await res.json();
    skillCache = Array.isArray(json.skills) ? json.skills : [];
    renderSkillList();
  } catch (err) {
    skillListEl.innerHTML = `<div class="composer-popup-empty">${escapeHtml(err.message || '加载失败')}</div>`;
  }
}

function renderMcpList() {
  if (!mcpListEl) return;
  if (!mcpCache.length) {
    mcpListEl.innerHTML = '<div class="composer-popup-empty">没有 MCP 服务器</div>';
    if (mcpBtnLabel) mcpBtnLabel.textContent = 'MCP';
    return;
  }
  if (mcpBtnLabel) mcpBtnLabel.textContent = `${mcpCache.length} MCP`;
  mcpListEl.innerHTML = mcpCache.map((server) => `
    <div class="composer-item">
      <div class="composer-item-body">
        <span class="composer-item-title">${escapeHtml(server.name)}</span>
        <span class="composer-item-desc">${server.authStatus ? `认证: ${escapeHtml(String(server.authStatus))}` : '已连接'}</span>
      </div>
      <span class="composer-item-meta">${server.toolCount || 0} 工具</span>
    </div>
  `).join('');
}

async function loadMcpServers() {
  if (!mcpListEl) return;
  mcpListEl.innerHTML = '<div class="composer-popup-hint">正在加载 MCP…</div>';
  try {
    const res = await apiFetch('/api/mcp-servers');
    const json = await res.json();
    mcpCache = Array.isArray(json.servers) ? json.servers : [];
    renderMcpList();
  } catch (err) {
    mcpListEl.innerHTML = `<div class="composer-popup-empty">${escapeHtml(err.message || '加载失败')}</div>`;
  }
}

if (btnSkill && skillPopup) {
  btnSkill.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = skillPopup.classList.contains('hidden');
    closeComposerPopups();
    if (willOpen) {
      skillPopup.classList.remove('hidden');
      loadSkills();
      if (skillSearch) skillSearch.focus();
    }
  });
}

if (skillSearch) {
  skillSearch.addEventListener('input', renderSkillList);
}

if (btnSkillManage) {
  btnSkillManage.addEventListener('click', (e) => {
    e.stopPropagation();
    skillManageMode = !skillManageMode;
    btnSkillManage.classList.toggle('active', skillManageMode);
    renderSkillList();
  });
}

if (btnMcp && mcpPopup) {
  btnMcp.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = mcpPopup.classList.contains('hidden');
    closeComposerPopups();
    if (willOpen) {
      mcpPopup.classList.remove('hidden');
      loadMcpServers();
    }
  });
}

if (btnMcpReload) {
  btnMcpReload.addEventListener('click', async (e) => {
    e.stopPropagation();
    btnMcpReload.disabled = true;
    try {
      await apiFetch('/api/mcp-servers/reload', { method: 'POST' });
      await loadMcpServers();
    } catch (err) {
      showGestureToast(err.message || 'MCP 重载失败');
    } finally {
      btnMcpReload.disabled = false;
    }
  });
}

document.addEventListener('click', (e) => {
  if (skillPopup && !skillPopup.classList.contains('hidden') && !e.target.closest('.composer-pop-wrap')) {
    skillPopup.classList.add('hidden');
  }
  if (mcpPopup && !mcpPopup.classList.contains('hidden') && !e.target.closest('.composer-pop-wrap')) {
    mcpPopup.classList.add('hidden');
  }
});

if (filePicker) {
  filePicker.addEventListener('change', async () => {
    const files = Array.from(filePicker.files || []);
    filePicker.value = '';
    for (const file of files) {
      try {
        await attachLocalFile(file);
      } catch (err) {
        showGestureToast(err.message || '上传失败');
      }
    }
  });
}

if (msgInput) {
  msgInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      try {
        await attachLocalFile(file);
      } catch (err) {
        showGestureToast(err.message || '上传失败');
      }
    }
  });
}

const inputCardEl = document.querySelector('.input-card');
if (inputCardEl) {
  inputCardEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputCardEl.classList.add('drag-over');
  });
  inputCardEl.addEventListener('dragleave', () => {
    inputCardEl.classList.remove('drag-over');
  });
  inputCardEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    inputCardEl.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    for (const file of files) {
      try {
        await attachLocalFile(file);
      } catch (err) {
        showGestureToast(err.message || '上传失败');
      }
    }
  });
}

if (btnStopTurn) {
  btnStopTurn.addEventListener('click', () => {
    if (!currentThreadId || currentStatus !== 'working') return;
    sendApp({ type: 'send_stop', threadId: currentThreadId });
  });
}

const accessPopupMenu = document.getElementById('access-popup-menu');
if (accessModeBadge && accessPopupMenu) {
  accessModeBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = accessPopupMenu.classList.contains('hidden');
    closeComposerPopups(accessPopupMenu);
    if (willOpen) {
      const input = document.getElementById('msg-input');
      if (input) input.blur();
      accessPopupMenu.classList.remove('hidden');
    }
    if (modelPopupMenu) modelPopupMenu.classList.add('hidden');
    if (modelSubmenuCard) modelSubmenuCard.classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!accessModeBadge.contains(e.target) && !accessPopupMenu.contains(e.target)) {
      accessPopupMenu.classList.add('hidden');
    }
  });
}

btnVoice.addEventListener('click', () => {
  alert('语音输入功能：请使用手机自带的输入法语音按键输入！');
});

function sendApprovalDecision(decision) {
  if (!currentPendingApproval || !currentThreadId) return;
  const pending = currentPendingApproval;
  sendApp({
    type: 'send_approval',
    threadId: currentThreadId,
    requestId: pending.id,
    decision,
    kind: pending.type,
    ids: pending.ids || []
  });
  dismissApprovalUI(currentThreadId, pending.id, pending.ids);
}

btnApproveAllow.addEventListener('click', () => sendApprovalDecision('accept'));
if (btnApproveSession) btnApproveSession.addEventListener('click', () => sendApprovalDecision('acceptForSession'));
btnApproveDeny.addEventListener('click', () => sendApprovalDecision('denied'));

const sidebarOverlay = document.getElementById('sidebar-overlay');

btnToggleSidebar.addEventListener('click', () => {
  const willOpen = !sidebar.classList.contains('open');
  if (willOpen) {
    if (isOverlayLayout()) closeRightPanel();
    sidebar.classList.add('open');
    if (sidebarOverlay) sidebarOverlay.classList.add('active');
  } else {
    closeSidebar();
  }
});

if (sidebarOverlay) {
  sidebarOverlay.addEventListener('click', closeSidebar);
}

btnRefresh.addEventListener('click', () => {
  fetchThreadsInstant();
  sendApp({ type: 'get_threads' });
});

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Register Solution D: PWA Service Worker for Offline Caching & True Standalone App Installation
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const resetKey = 'onedesk-sw-reset-329';
    const reset = sessionStorage.getItem(resetKey)
      ? Promise.resolve()
      : Promise.all([
          navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))),
          caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        ]).then(() => {
          sessionStorage.setItem(resetKey, '1');
          location.reload();
        });
    reset.then(() => {
      if (sessionStorage.getItem(resetKey) !== '1') return;
      navigator.serviceWorker.register('./sw.js?v=3.29.0').catch(() => {});
    }).catch(() => {});
  });
}

// PWA Standalone Navigation Lock (Prevents Safari/Chrome from spawning browser tabs)
if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a && a.href && !a.href.startsWith('javascript:') && a.target !== '_blank') {
      const href = a.href;
      if (href.startsWith(window.location.origin)) {
        e.preventDefault();
        window.location.href = href;
      }
    }
  }, false);
}

// Auto-Refresh Engine: Background silent polling every 60 seconds
// (active-thread history is pushed in realtime by the server watcher / push gate)
let autoRefreshTimer = null;

function startAutoRefreshEngine() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendApp({ type: 'get_threads' });
    } else {
      fetchThreadsInstant();
    }
  }, 60000); // Exactly 60 seconds (1分钟)
}

// Unified delegated click handler for all data-action / data-file-path elements.
// Replaces every inline onclick: fixes Windows path escaping bugs (\n, \t, quotes)
// and keeps dynamically rendered HTML free of JS string interpolation hazards.
document.addEventListener('click', (e) => {
  // 首次交互时请求通知授权（浏览器要求用户手势；仅请求一次），授权后顺手注册 Web Push
  if (!window.__notifAsked && 'Notification' in window && Notification.permission === 'default') {
    window.__notifAsked = true;
    Notification.requestPermission()
      .then(p => { if (p === 'granted') registerPushSubscription(); })
      .catch(() => {});
  }

  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const action = actionEl.dataset.action;
    if (action === 'load-more') {
      loadFullHistory(currentThreadId);
    } else if (action === 'toggle-prompt') {
      toggleUserPrompt(actionEl);
    } else if (action === 'toggle-show-all') {
      const list = actionEl.previousElementSibling;
      if (list) list.classList.toggle('show-all');
    } else if (action === 'toggle-agent-list') {
      // 展开/收起 agent 状态列表（低价值消息，移动端默认折叠）
      const wrap = actionEl.closest('.agent-status-list');
      if (wrap) {
        const expanded = wrap.classList.toggle('expanded');
        actionEl.textContent = expanded ? '收起' : `展开全部 (+${wrap.querySelectorAll('.inline-agent-node').length - 2})`;
      }
    } else if (action === 'toggle-dir') {
      const children = actionEl.nextElementSibling;
      if (children) children.classList.toggle('hidden');
    } else if (action === 'select-model') {
      selectModel(actionEl.dataset.value);
    } else if (action === 'select-effort') {
      selectEffort(actionEl.dataset.value);
    } else if (action === 'select-access') {
      applyAccessMode(actionEl.dataset.value, true);
      if (accessPopupMenu) accessPopupMenu.classList.add('hidden');
    } else if (action === 'toggle-section') {
      const target = actionEl.dataset.target;
      const section = target ? document.getElementById(target)?.closest('.sidebar-section') : actionEl.closest('.sidebar-section');
      if (section) section.classList.toggle('collapsed');
    } else if (action === 'new-chat') {
      createNewChat(actionEl.dataset.cwd || '');
    } else if (action === 'toggle-code') {
      const pre = actionEl.closest('pre');
      if (pre) {
        const collapsed = pre.classList.toggle('collapsed');
        pre.classList.toggle('expanded', !collapsed);
        actionEl.textContent = collapsed ? '展开' : '折叠';
      }
    } else if (action === 'copy-code') {
      const pre = actionEl.closest('pre');
      const code = pre ? pre.querySelector('code') : null;
      if (code && navigator.clipboard) {
        navigator.clipboard.writeText(code.innerText).then(() => {
          actionEl.textContent = '已复制 ✓';
          setTimeout(() => { actionEl.textContent = '复制'; }, 1500);
        }).catch(() => {});
      }
    } else if (action === 'remove-attachment') {
      removeAttachment(actionEl.dataset.attId);
    } else if (action === 'select-skill') {
      const skill = skillCache[Number(actionEl.dataset.index)];
      if (skill) {
        attachSkill(skill);
        if (skillPopup) skillPopup.classList.add('hidden');
      }
    } else if (action === 'toggle-skill') {
      const skill = skillCache[Number(actionEl.dataset.index)];
      if (skill) {
        const enabled = skill.enabled === false;
        apiFetch('/api/skills/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: skill.path, enabled })
        }).then((res) => res.json()).then((json) => {
          if (!json.success) throw new Error(json.error || '更新失败');
          skill.enabled = enabled;
          renderSkillList();
        }).catch((err) => showGestureToast(err.message || '更新 Skill 失败'));
      }
    } else if (action === 'jump-search') {
      jumpToSearchResult(parseInt(actionEl.dataset.index, 10), searchInput.value.trim());
    } else if (action === 'slash') {
      applySlashItem(actionEl.dataset.cmd);
    } else if (action === 'copy-code') {
      window.copyCodeBlock(actionEl);
    }
    return;
  }

  const fileLink = e.target.closest('[data-file-path]');
  if (fileLink) {
    e.preventDefault();
    openFileModal(fileLink.dataset.filePath);
  }
});

// ----------------------------------------------------
// Web Push 订阅注册（通知授权后无感完成）
// ----------------------------------------------------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function registerPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const keyRes = await apiFetch('/api/push/public-key');
      const keyJson = await keyRes.json();
      if (!keyJson.success || !keyJson.publicKey) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyJson.publicKey)
      });
    }
    await apiFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub)
    });
    console.log('[Push] Subscription registered');
  } catch (e) {
    console.warn('[Push] Subscribe failed:', e);
  }
}

// 已授权过的设备启动时幂等补注册（SW 更新后订阅可能丢失）
if ('Notification' in window && Notification.permission === 'granted') {
  registerPushSubscription();
}

// ----------------------------------------------------
// 会话内全文搜索（服务端跨完整历史检索）
// ----------------------------------------------------
const searchOverlay = document.getElementById('search-overlay');
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const btnOpenSearch = document.getElementById('btn-open-search');
const btnCloseSearch = document.getElementById('btn-close-search');

function openSearchOverlay() {
  if (!currentThreadId) {
    showGestureToast('请先选择一个会话');
    return;
  }
  searchOverlay.classList.remove('hidden');
  setTimeout(() => searchInput.focus(), 50);
}

function closeSearchOverlay() {
  searchOverlay.classList.add('hidden');
}

const gitPanel = document.getElementById('git-panel');
const btnGitRefresh = document.getElementById('btn-git-refresh');
const cmdInput = document.getElementById('cmd-input');
const cmdPanel = document.getElementById('cmd-panel');
const btnRunCmd = document.getElementById('btn-run-cmd');

function requestGitStatus() {
  if (!currentThreadId) {
    if (gitPanel) gitPanel.textContent = '先打开一个会话';
    return;
  }
  if (gitPanel) gitPanel.textContent = '正在读取 git…';
  sendApp({ type: 'git_status', threadId: currentThreadId, action: 'all' });
}

function runComposerCommand() {
  const command = cmdInput ? cmdInput.value.trim() : '';
  if (!currentThreadId || !command) return;
  if (cmdPanel) cmdPanel.textContent = `$ ${command}\n`;
  sendApp({ type: 'run_command', threadId: currentThreadId, command });
}

if (btnGitRefresh) btnGitRefresh.addEventListener('click', requestGitStatus);
if (btnRunCmd) btnRunCmd.addEventListener('click', runComposerCommand);
if (cmdInput) cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runComposerCommand();
  }
});

function initRightPanelTabs() {
  const tabs = document.querySelectorAll('.right-tab-btn');
  const panes = document.querySelectorAll('.right-tab-pane');
  if (!tabs.length || !panes.length) return;

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      tabs.forEach((t) => {
        const isActive = t === tab;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      panes.forEach((pane) => {
        const isMatch = pane.id === `tab-pane-${targetTab}`;
        pane.classList.toggle('hidden', !isMatch);
      });
    });
  });
}
initRightPanelTabs();

if (btnOpenSearch) btnOpenSearch.addEventListener('click', openSearchOverlay);
if (btnCloseSearch) btnCloseSearch.addEventListener('click', closeSearchOverlay);
if (searchOverlay) searchOverlay.addEventListener('click', (e) => {
  if (e.target === searchOverlay) closeSearchOverlay();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSearchOverlay();
    const fileModal = document.getElementById('file-modal');
    if (fileModal) fileModal.classList.add('hidden');
    const pairQrOverlay = document.getElementById('pair-qr-overlay');
    if (pairQrOverlay) pairQrOverlay.classList.add('hidden');
    const skillPopup = document.getElementById('skill-popup');
    if (skillPopup) skillPopup.classList.add('hidden');
    const mcpPopup = document.getElementById('mcp-popup');
    if (mcpPopup) mcpPopup.classList.add('hidden');
    const accessPopup = document.getElementById('access-popup-menu');
    if (accessPopup) accessPopup.classList.add('hidden');
    const modelPopup = document.getElementById('model-popup-menu');
    if (modelPopup) modelPopup.classList.add('hidden');
    const modelSubmenu = document.getElementById('model-submenu-card');
    if (modelSubmenu) modelSubmenu.classList.add('hidden');
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearchOverlay();
  }
});

async function runThreadSearch() {
  const q = searchInput.value.trim();
  if (!q || !currentThreadId) return;
  searchResultsEl.innerHTML = '<div class="loading-spinner">正在搜索完整历史...</div>';
  try {
    const res = await apiFetch(`/api/search?threadId=${encodeURIComponent(currentThreadId)}&q=${encodeURIComponent(q)}`);
    const json = await res.json();
    if (!json.success) {
      searchResultsEl.innerHTML = `<div class="search-hint">搜索失败: ${escapeHtml(json.error || '')}</div>`;
      return;
    }
    if (!json.results.length) {
      searchResultsEl.innerHTML = '<div class="search-hint">没有找到匹配的消息</div>';
      return;
    }
    const typeLabels = {
      user_message: '👤 用户', agent_message: '🤖 回复',
      reasoning: '💭 思考', custom_tool_call: '🔧 工具', tool_call: '🔧 工具',
      custom_tool_call_output: '📤 输出'
    };
    searchResultsEl.innerHTML = json.results.map(r => `
      <div class="search-result-item" data-action="jump-search" data-index="${r.index}">
        <span class="search-result-type">${typeLabels[r.type] || '📄'}</span>
        <span class="search-result-snippet">${escapeHtml(r.snippet)}</span>
      </div>
    `).join('');
  } catch (e) {
    searchResultsEl.innerHTML = `<div class="search-hint">网络错误: ${escapeHtml(e.message)}</div>`;
  }
}

let searchDebounce = null;
if (searchInput) searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runThreadSearch, 350);
});
if (searchInput) searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchDebounce);
    runThreadSearch();
  }
});

// 点击搜索结果：确保完整历史已加载 → 定位渲染窗口 → 高亮命中节点
async function jumpToSearchResult(absoluteIndex, q) {
  if (absoluteIndex === undefined || absoluteIndex === null || !q) return;
  const cached = clientThreadCache.get(currentThreadId);

  // 需要更早的历史时先全量加载
  if (!cached || cached.hasMore || (cached.items && cached.items.length <= absoluteIndex)) {
    await loadFullHistory(currentThreadId);
  }

  const data = clientThreadCache.get(currentThreadId);
  if (!data || !data.items || !data.items.length) return;

  const offset = Math.max(0, (data.totalItems || data.items.length) - data.items.length);
  const localIdx = absoluteIndex - offset;
  if (localIdx < 0) {
    showGestureToast('该消息超出可加载范围');
    return;
  }

  // 让目标落在窗口中部附近
  renderHiddenCount = Math.max(0, Math.min(localIdx - 5, data.items.length - 10));
  closeSearchOverlay();
  renderThreadDetail(data, { highlightQuery: q });
}

// ----------------------------------------------------
// 手机手势：边缘右滑开侧栏 / 聊天区左右滑切换会话
// ----------------------------------------------------
function showGestureToast(text) {
  const toast = document.getElementById('gesture-toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.remove('hidden');
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.add('hidden');
  }, 1600);
}

function switchThreadByOffset(dir) {
  if (!flatThreadIds.length || !currentThreadId) return;
  const idx = flatThreadIds.indexOf(currentThreadId);
  if (idx < 0) return;
  const nextIdx = idx + dir;
  if (nextIdx < 0 || nextIdx >= flatThreadIds.length) {
    showGestureToast(dir > 0 ? '已经是最新会话' : '已经是最早会话');
    return;
  }
  const nextId = flatThreadIds[nextIdx];
  const titleEl = document.querySelector(`.thread-item[data-id="${nextId}"] .thread-title, .thread-item[data-id="${nextId}"]`);
  selectThread(nextId, titleEl ? (titleEl.textContent || '').trim().slice(0, 30) : '会话');
  showGestureToast(dir > 0 ? '↓ 下一个会话' : '↑ 上一个会话');
}

(function initGestures() {
  let startX = 0, startY = 0, startTime = 0, tracking = false;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    // 忽略输入框/代码块/滚动容器内部的双指等场景
    if (t.target.closest('input, textarea, pre, .search-overlay, .right-panel')) { tracking = false; return; }
    startX = t.clientX;
    startY = t.clientY;
    startTime = Date.now();
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startTime;

    const isHorizontal = Math.abs(dx) > Math.abs(dy) * 2.2;
    if (!isHorizontal || dt > 600 || Math.abs(dx) < 70) {
      // 不构成横向滑动：忽略（交给垂直滚动）
      return;
    }

    const sidebarOpen = sidebar && sidebar.classList.contains('open');
    const rightOpen = rightPanel && rightPanel.classList.contains('open');

    // 边缘右滑（从屏幕左缘开始）→ 打开侧栏
    if (startX < 36 && dx > 60 && !sidebarOpen && !rightOpen) {
      if (isOverlayLayout()) closeRightPanel();
      sidebar.classList.add('open');
      if (sidebarOverlay) sidebarOverlay.classList.add('active');
      return;
    }

    // 侧栏打开时左滑 → 关闭
    if (sidebarOpen && dx < -50) {
      closeSidebar();
      return;
    }

    // 聊天区横向快滑 → 切换会话（左滑下一个，右滑上一个）
    if (!sidebarOpen && Math.abs(dx) > 90) {
      switchThreadByOffset(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
})();

function filteredSlashItems() {
  const raw = (msgInput && msgInput.value) || '';
  if (!raw.startsWith('/')) return [];
  const q = raw.slice(1).split(/\s/)[0].toLowerCase();
  return SLASH_ITEMS.filter((item) => !q || item.cmd.slice(1).startsWith(q) || item.cmd.includes(q));
}

function hideSlashMenu() {
  if (slashMenu) {
    slashMenu.classList.add('hidden');
    slashMenu.innerHTML = '';
  }
}

function renderSlashMenu() {
  if (!slashMenu) return;
  const items = filteredSlashItems();
  if (!items.length) {
    hideSlashMenu();
    return;
  }
  slashIndex = Math.max(0, Math.min(slashIndex, items.length - 1));
  slashMenu.innerHTML = items.map((item, i) => `
    <button type="button" class="slash-item ${i === slashIndex ? 'active' : ''}" data-action="slash" data-cmd="${escapeHtml(item.cmd)}">
      <span class="slash-item-cmd">${escapeHtml(item.cmd)}</span>
      <span class="slash-item-desc">${escapeHtml(item.desc)}</span>
    </button>
  `).join('');
  slashMenu.classList.remove('hidden');
}

function applySlashItem(cmd) {
  const item = SLASH_ITEMS.find((row) => row.cmd === cmd);
  hideSlashMenu();
  if (!item) return;
  if (item.kind === 'model' && modelSelectorBadge) {
    if (msgInput) msgInput.value = '';
    modelPopupMenu.classList.remove('hidden');
    return;
  }
  if (item.kind === 'effort' && modelSelectorBadge) {
    if (msgInput) msgInput.value = '';
    modelPopupMenu.classList.remove('hidden');
    const effortItem = document.querySelector('.popup-item[data-menu="effort"]');
    if (effortItem) effortItem.click();
    return;
  }
  if (item.kind === 'mcp') {
    if (msgInput) msgInput.value = '';
    const mcpPopup = document.getElementById('mcp-popup');
    const btnMcp = document.getElementById('btn-mcp');
    if (btnMcp) btnMcp.click();
    else if (mcpPopup) mcpPopup.classList.remove('hidden');
    return;
  }
  if (msgInput) msgInput.value = item.cmd;
  handleMainAction();
}

if (msgInput) {
  msgInput.addEventListener('input', () => {
    if ((msgInput.value || '').startsWith('/')) renderSlashMenu();
    else hideSlashMenu();
  });
}

if (btnSlash) {
  btnSlash.addEventListener('click', (e) => {
    e.preventDefault();
    if (msgInput) {
      if (!msgInput.value.startsWith('/')) msgInput.value = '/';
      msgInput.focus();
      renderSlashMenu();
    }
  });
}

function downloadCurrentFile() {
  if (!lastFileMeta || !lastFileMeta.content) {
    showGestureToast('没有可下载的文件');
    return;
  }
  const blob = new Blob([lastFileMeta.content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = lastFileMeta.name || 'file.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

if (btnDownloadFile) btnDownloadFile.addEventListener('click', downloadCurrentFile);

async function submitLogin(e) {
  if (e) e.preventDefault();
  const password = authPassword ? authPassword.value : '';
  if (!password) {
    showAuthError('请输入主机台左边的家里码');
    return;
  }
  try {
    const res = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const json = await readJson(res);
    if (!res.ok || (json && json.ok === false)) {
      showAuthError((json && (json.error || json.message)) || '家里码不对');
      return;
    }
    connMode = 'lan';
    if (json && json.hubId) pairedHubId = json.hubId;
    persistConn();
    startApp();
  } catch (err) {
    showAuthError(err.message || '登录失败');
  }
}

async function submitPair(e) {
  if (e) e.preventDefault();
  const code = authPairCode ? authPairCode.value.trim() : '';
  if (!code) {
    showAuthError('请输入主机台右边的出门码，或扫右边的二维码');
    return;
  }
  try {
    await pairWithCode(code);
  } catch (err) {
    showAuthError(err.message || '配对失败');
  }
}

async function probeLanFromForm() {
  const raw = authLanUrl ? authLanUrl.value.trim() : '';
  if (!raw) {
    showAuthError('请填写局域网地址');
    return;
  }
  let base = raw;
  try { base = new URL(raw, window.location.href).origin; } catch (e) {
    showAuthError('地址无效');
    return;
  }
  const probed = await probeHub(base);
  if (!probed) {
    showAuthError('探测失败：主机离线或地址不对');
    markHostOffline();
    return;
  }
  lanBase = base;
  connMode = 'lan';
  persistConn();
  if (originOf(base) !== window.location.origin) {
    window.location.href = base.replace(/\/$/, '') + '/';
    return;
  }
  if (probed.kind === 'hub-auth' || (probed.json && probed.json.loggedIn === false)) {
    showAuthOverlay('login');
    return;
  }
  startApp();
}

async function logoutAll() {
  try { await fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' }); } catch (e) {}
  if (deviceToken) {
    try {
      await fetch('/api/relay/revoke', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + deviceToken },
        body: JSON.stringify({ deviceToken })
      });
    } catch (e) {}
  }
  deviceToken = '';
  pairedHubId = '';
  sessionReady = false;
  persistConn();
  try { if (ws) ws.close(); } catch (e) {}
  clearSessionViews();
  showAuthOverlay(connMode === 'relay' ? 'pair' : 'login');
}

if (authLoginForm) authLoginForm.addEventListener('submit', submitLogin);
if (authPairForm) authPairForm.addEventListener('submit', submitPair);
if (btnProbeLan) btnProbeLan.addEventListener('click', probeLanFromForm);
if (btnAuthRetry) btnAuthRetry.addEventListener('click', () => bootConnection());
if (btnAuthLogout) btnAuthLogout.addEventListener('click', logoutAll);
if (btnShowPairQr) btnShowPairQr.addEventListener('click', showPairQr);
if (btnRefreshPairQr) btnRefreshPairQr.addEventListener('click', showPairQr);
if (btnClosePairQr) btnClosePairQr.addEventListener('click', hidePairQr);

bootConnection();
