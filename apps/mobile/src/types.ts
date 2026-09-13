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
  summary?: { fileChanges: number; generatedImages: number; partial?: boolean };
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

export type CommandStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain';
export type CommandState = { requestId: string; clientUserMessageId?: string; threadId?: string; status: CommandStatus; result?: unknown; error?: string | { code?: string; message?: string } };
export type ExecutionState = { threadId: string; location: 'desktop' | 'hub' | 'unknown'; status: string; canHandoff: boolean; reason?: string; pendingUserInputs?: UserInputRequest[] };
export type QueuedMessage = { queueId: string; threadId: string; text: string; status: string; requestId?: string; clientUserMessageId?: string; images?: unknown[] };
export type RemoteDraft = { version: number; text: string; attachments: import('./composer-draft').ComposerPending[]; updatedAt?: number };
export type DraftSyncState = { status: 'loading' | 'synced' | 'saving' | 'conflict' | 'error'; remote?: RemoteDraft; local?: Pick<RemoteDraft, 'text' | 'attachments'>; error?: string };
export type UserInputRequest = { requestId: string; threadId: string; method: string; payload: { questions?: { id: string; header?: string; question: string; isSecret?: boolean; options?: { label: string; description?: string }[] }[] }; at?: number };
export type UserInputAnswers = { answers: Record<string, { answers: string[] }> };

export type ThreadHistory = {
  needsReconcile?: boolean;
  branch?: string;
  executionLocation?: string;
  items: HistoryItem[];
  status: string;
  pendingApproval: { id?: string; ids?: string[]; command?: string; reason?: string; type?: string; at?: number } | null;
  activeActionText: string;
  cwd: string;
  lockHolder?: 'desktop' | 'desktop-stale' | 'hub' | null;
  subagents?: { id: string; title?: string; status?: string; cwd?: string; model?: string }[];
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

export type TimelineImage = {
  uri?: string;
  path?: string;
  name?: string;
};

export type TimelineNode = {
  id: string;
  deliveryStatus?: CommandStatus;
  attachments?: { name: string; path: string }[];
  kind: 'user' | 'assistant' | 'system' | 'diff' | 'command' | 'reasoning' | 'agent' | 'generated-image' | 'search' | 'image-view' | 'compaction';
  status?: string;
  important?: boolean;
  threadId?: string;
  model?: string;
  turnId?: string;
  text: string;
  command?: string;
  output?: string;
  path?: string;
  add?: number;
  del?: number;
  patch?: string;
  images?: TimelineImage[];
  searchResults?: { title: string; url: string }[];
};

export type FailedSend = {
  pendingNamespace?: string;
  restored?: boolean;
  clientUserMessageId?: string;
  mode?: 'plan' | 'review';
  deliveryStatus?: CommandStatus;
  draftKey?: string;
  id: string;
  threadId: string;
  text: string;
  input?: unknown[];
  working: boolean;
  kind: 'message' | 'command';
  error: string;
  // Only retained from structured feedback with an exact matching threadId.
  code?: 'writer_lock_conflict' | 'writer_owner_unknown';
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
  requestPath?: string;
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

export type UploadTask = { draftKey?: string; taskId: string; threadId: string; identity: string; name: string; image: boolean; status: 'reading' | 'uploading' | 'success' | 'error'; path?: string; error?: string };
export type ArtifactRecord = { name: string; path: string; threadId?: string; ext?: string; mtimeMs?: number; size?: number; source?: string; turnId?: string; timestamp?: string | number };
