export type ConnKind = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'hub_offline';

export type Thread = {
  id: string;
  title: string;
  projectName?: string;
  cwd?: string;
  isActive?: boolean;
  working?: boolean;
  status?: 'working' | 'waiting_approval' | 'just_finished' | 'idle' | string;
  needsApproval?: boolean;
  isPinned?: boolean;
  updatedAt?: string;
  mtimeMs?: number;
};

export type Project = {
  id?: string;
  name: string;
  cwd?: string;
  isPinned?: boolean;
  threads: Thread[];
};

export type SkillInfo = {
  name: string;
  path?: string;
  enabled?: boolean;
  description?: string;
  shortDescription?: string;
};

export type McpServerInfo = {
  name: string;
  authStatus?: string | null;
  needsAuth?: boolean;
  toolCount?: number;
  tools?: string[];
  error?: string | null;
};

export type PluginInfo = {
  id: string;
  name: string;
  marketplace?: string;
  enabled?: boolean;
  displayName?: string;
  description?: string;
  category?: string;
  mention?: string;
  needsDesktopUi?: boolean;
};

export type Approval = {
  requestId: string;
  ids?: string[];
  threadId: string;
  kind?: string;
  command?: string;
  reason?: string;
  at?: number;
  source?: 'live' | 'history';
};

export type HistoryItem = {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  author?: string;
  recipient?: string;
  patch?: string;
  command?: string;
  path?: string;
  [key: string]: unknown;
};

export type TokenUsage = {
  primaryUsedPercent?: number;
  usedPercent?: number;
  totalTokens?: number;
  maxContext?: number;
  resetAtMs?: number;
  planType?: string;
  sources?: { label: string; percent: number }[];
};

export type ThreadHistory = {
  items: HistoryItem[];
  status: string;
  pendingApproval: { id?: string; ids?: string[]; command?: string; reason?: string; type?: string; at?: number } | null;
  activeActionText: string;
  cwd: string;
  lockHolder?: 'desktop' | 'hub' | null;
  subagents?: { id: string; title?: string; status?: string; cwd?: string }[];
  tokenUsage?: TokenUsage;
  rev?: number;
  totalItems?: number;
  hasMore?: boolean;
  full?: boolean;
};

export type TreeNode = {
  name: string;
  type: 'file' | 'directory';
  path: string;
  ext?: string;
  hasChildren?: boolean;
  children?: TreeNode[];
};

export type TimelineNode = {
  id: string;
  kind: 'user' | 'assistant' | 'system' | 'diff' | 'command' | 'reasoning' | 'agent';
  text: string;
  path?: string;
  add?: number;
  del?: number;
  patch?: string;
};

export type FailedSend = {
  id: string;
  threadId: string;
  text: string;
  input?: unknown[];
  working: boolean;
  kind: 'message' | 'command';
  error: string;
};

export type Bubble = TimelineNode;

export type Decision = 'accept' | 'acceptForSession' | 'denied';

export type ModelInfo = {
  id: string;
  displayName?: string;
  description?: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { id: string; description?: string }[];
};

export type FileData = {
  path: string;
  fileName: string;
  ext: string;
  encoding: 'utf8' | 'base64';
  content: string;
  truncated: boolean;
  error?: string | null;
};

export type HubConfig = {
  model?: string;
  rawModel?: string;
  effort?: string;
  speed?: string;
  rawSpeed?: string;
  accessMode?: string;
};

export const ACCESS_MODES = {
  ask: { label: '变更前确认', shortLabel: '确认', icon: '✋', hint: '改文件或跑命令前先问我。' },
  auto: { label: '帮我批准', shortLabel: '自动', icon: '🛡️', hint: '常见操作自动过，有风险再问。' },
  full: { label: '完全访问', shortLabel: '完全', icon: '⚡', hint: '少确认，直接改文件和上网。' },
} as const;

export type AccessModeId = keyof typeof ACCESS_MODES;

export function accessMeta(mode?: string) {
  if (mode === 'ask' || mode === 'auto' || mode === 'full') return ACCESS_MODES[mode];
  return ACCESS_MODES.full;
}

export function applyConfigPatch(prev: HubConfig, key: string, value: string): HubConfig {
  if (key === 'model') return { ...prev, model: value, rawModel: value };
  if (key === 'effort') return { ...prev, effort: value };
  if (key === 'speed') return { ...prev, speed: value, rawSpeed: value };
  if (key === 'permission') return { ...prev, accessMode: value };
  return prev;
}

export type Route =
  | { name: 'boot' }
  | { name: 'pair' }
  | { name: 'scan' }
  | { name: 'list' }
  | { name: 'thread'; threadId: string }
  | { name: 'settings' }
  | { name: 'file'; threadId: string; path: string };
