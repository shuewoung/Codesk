export type ConnKind = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'hub_offline';

export type Thread = {
  id: string;
  title: string;
  projectName?: string;
  cwd?: string;
  isActive?: boolean;
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
};

export type ThreadHistory = {
  items: HistoryItem[];
  status: string;
  pendingApproval: { id?: string; ids?: string[]; command?: string; reason?: string; type?: string; at?: number } | null;
  activeActionText: string;
  cwd: string;
  tokenUsage?: TokenUsage;
  rev?: number;
  totalItems?: number;
  hasMore?: boolean;
};

export type TreeNode = {
  name: string;
  type: 'file' | 'directory';
  path: string;
  ext?: string;
  children?: TreeNode[];
};

export type TimelineNode = {
  id: string;
  kind: 'user' | 'assistant' | 'system' | 'diff' | 'command';
  text: string;
  path?: string;
  add?: number;
  del?: number;
  patch?: string;
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
  accessMode?: string;
};

export type Route =
  | { name: 'boot' }
  | { name: 'pair' }
  | { name: 'scan' }
  | { name: 'list' }
  | { name: 'thread'; threadId: string }
  | { name: 'settings' }
  | { name: 'file'; threadId: string; path: string };
