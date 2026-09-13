import type { ProjectIntelligence } from './project-index-core';

export type WebMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; conversationId?: string; context?: ComposerContext; agentId?: string }
  | { type: 'stop' }
  | { type: 'newConversation' }
  | { type: 'openConversation'; id: string }
  | { type: 'archiveConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'renameConversation'; id: string; title?: string }
  | { type: 'togglePinConversation'; id: string }
  | { type: 'restoreCheckpoint'; conversationId: string; itemId: string }
  | { type: 'reviewChanges'; conversationId: string; itemId: string }
  | { type: 'gitReviewFile'; conversationId: string; itemId: string; path: string }
  | { type: 'gitRevertFile'; conversationId: string; itemId: string; path: string }
  | { type: 'gitStageChanges'; conversationId: string; itemId: string; paths?: string[] }
  | { type: 'gitCommit'; conversationId: string; itemId: string }
  | { type: 'reindexProject' }
  | { type: 'copyText'; text: string }
  | { type: 'steerQueued'; conversationId: string }
  | { type: 'removeQueued'; conversationId: string }
  | { type: 'setKey' }
  | { type: 'selectModel'; model: string; provider?: string }
  | { type: 'requestSettings' }
  | { type: 'requestExtensionLogs' }
  | { type: 'clearExtensionLogs' }
  | { type: 'extensionLogs'; logs: string[] }
  | { type: 'saveSettings'; maxSteps: number; approvalMode: string; searxngUrl: string; mcpServers: string; activeProvider: string; providers: import('./providers').Provider[]; apiKey: string; extraFreeModels: string; onlyDefaultModels: boolean; confirmDelete: boolean; compactionModel?: string; initialSetup?: boolean; subagentModels?: SubagentModelMap }
  | { type: 'fetchProviderModels'; id?: string; name?: string; baseURL: string; apiKey?: string; customHeaders?: Record<string, string> }
  | { type: 'providerModels'; id?: string; ok: boolean; text: string; models?: string[] }
  | { type: 'saveProviderApiKey'; providerId: string; apiKey: string }
  | { type: 'removeApiKey'; providerId: string }
  | { type: 'saveMcpConnection'; connection: import('./types').McpConnectionData }
  | { type: 'deleteMcpConnection'; name: string }
  | { type: 'testMcpConnection'; name: string }
  | { type: 'connectMcpOAuth'; name: string }
  | { type: 'mcpConnections'; connections: import('./types').McpConnectionData[]; statuses?: import('./types').McpConnectionStatus[] }
  | { type: 'mcpConnectionResult'; ok: boolean; text: string; status?: import('./types').McpConnectionStatus }
  | { type: 'sleepyLogin' }
  | { type: 'sleepyDeviceLogin' }
  | { type: 'sleepyLogout' }
  | { type: 'sleepyAccountData' }
  | { type: 'openSleepyDashboard' }
  | { type: 'openSleepyWebsite' }
  | { type: 'resetSettings' }
  | { type: 'openFile'; path: string }
  | { type: 'chooseContext' }
  | { type: 'compact'; conversationId?: string }
  | { type: 'cancelCompact'; conversationId?: string }
  | { type: 'compactProgress'; conversationId: string; phase: 'start' | 'summarizing' | 'done' | 'cancelled' | 'error'; auto?: boolean; text?: string; beforeTokens?: number; afterTokens?: number; contextWindow?: number; itemCount?: number }
  | { type: 'requestFilePicker' }
  | { type: 'pasteImage'; dataUrl: string; mimeType: string; name: string; size: number }
  | { type: 'dropFiles'; paths: string[] }
  | { type: 'removeAttachment'; index: number }
  | { type: 'fileMentionQuery'; query: string }
  | { type: 'openMemory' }
  | { type: 'revealInOS' }
  | { type: 'revealSkill'; folder: string }
  | { type: 'retryMessage'; conversationId: string }
  | { type: 'continueIteration'; conversationId: string; itemId: string }
  | { type: 'branchConversation'; conversationId: string; itemId: string }
  | { type: 'editUserMessage'; conversationId: string; itemId: string; text: string; context?: ComposerContext }
  | { type: 'undoLastTurn'; conversationId: string }
  | { type: 'redoLastTurn'; conversationId: string }
  | { type: 'selectAgent'; agentId: string }
  | { type: 'saveAgent'; agent: CustomAgentConfig }
  | { type: 'deleteAgent'; id: string }
  | { type: 'agents'; agents: CustomAgentConfig[] }
  | { type: 'requestUsage' }
  | { type: 'requestMarketplace' }
  | { type: 'requestMarketplaceInstalled' }
  | { type: 'marketplaceTop'; sortBy?: 'stars' | 'recent' }
  | { type: 'marketplaceSearch'; query: string; limit: number; sortBy: 'stars' | 'recent' }
  | { type: 'marketplaceListRepo'; source: string; branch?: string }
  | { type: 'marketplacePreview'; source: string; path?: string; branch?: string }
  | { type: 'marketplaceInstall'; source: string; skill?: string; branch?: string; key?: string }
  | { type: 'marketplaceInstallProgress'; key: string; done: number; total: number }
  | { type: 'marketplaceUninstall'; folder: string }
  | { type: 'notifyResponse'; id: number; choice: 'ok' | 'secondary' | 'cancel' }
  | { type: 'toast'; id: number; title: string; message: string; kind: 'info' | 'attention' }
  | { type: 'openPanel'; panel: 'worktrees' | 'index' | 'agents' | 'tasks' | 'checkpoints' }
  | { type: 'requestPanel'; panel: 'worktrees' | 'index' | 'agents' | 'tasks' | 'checkpoints' }
  | { type: 'showPanel'; panel: 'worktrees' | 'index' | 'agents' | 'tasks' | 'checkpoints' }
  | { type: 'panel'; panel: 'worktrees' | 'index' | 'agents' | 'tasks' | 'checkpoints'; rows: { title: string; detail?: string }[]; hint?: string }
  | { type: 'browserPreview'; conversationId?: string; dataUrl: string; cursor?: { x: number; y: number } }
  | { type: 'contextNotice'; conversationId: string; kind: 'trimmed' | 'compacted'; text: string };

export type WorkItem = {
  kind: 'reasoning' | 'task' | 'plan';
  text: string;
  /** Raw tool name (e.g. "read_file") used to pick the row icon in the chat. */
  tool?: string;
  done?: boolean;
  title?: string;
  steps?: string[];
  activeStep?: number;
  doneSteps?: number[];
  interrupted?: boolean;
  manual?: boolean;
};

export type FileChange = {
  path: string;
  action: 'Created' | 'Modified' | 'Deleted';
  staged?: boolean;
  reverted?: boolean;
};

/** Content captured before the first time a turn touched a file, so undo works outside Git. */
export type FileSnapshot = {
  path: string;
  existed: boolean;
  content: string;
};


export type AgentErrorAction = 'retry' | 'signin' | 'account' | 'models' | 'context' | 'settings';

export type AgentErrorCode =
  | 'action_denied'
  | 'auth_required'
  | 'credits_exhausted'
  | 'account_limit'
  | 'rate_limited'
  | 'context_too_large'
  | 'model_unavailable'
  | 'service_unavailable'
  | 'network'
  | 'provider_error'
  | 'unknown';

export type AgentErrorPresentation = {
  code: AgentErrorCode;
  title: string;
  message: string;
  retryable: boolean;
  primaryAction?: AgentErrorAction;
  primaryLabel?: string;
  secondaryAction?: AgentErrorAction;
  secondaryLabel?: string;
};

export type TranscriptItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Text streamed before an error interrupted the run; kept so a retry can continue from the halfway point. */
  partialText?: string;
  timestamp: number;
  kind?: 'error' | 'divider';
  gitTree?: string;
  work?: WorkItem[];
  seconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  attachments?: Attachment[];
  changes?: FileChange[];
  fileSnapshot?: FileSnapshot[];
  errorInfo?: AgentErrorPresentation;
  commitHash?: string;
  commitMessage?: string;
  paused?: boolean;
  pauseReason?: 'max_steps';
  pauseLimit?: number;
};

export type Conversation = {
  id: string;
  title: string;
  items: TranscriptItem[];
  archived: boolean;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  model?: string;
  provider?: string;
  agentId?: string;
};

/** User-defined agent that extends the built-in roster with its own model, tool policy, and skills. */
export type CustomAgentConfig = {
  id: string;
  name: string;
  color?: string;
  prompt?: string;
  model?: string;
  tools?: { allow?: string[]; deny?: string[] };
  skills?: string[];
};

export type SubagentModelMap = {
  explorer?: string;
  reviewer?: string;
  worker?: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  conversations: Conversation[];
  activeConversationId: string;
  createdAt: number;
  updatedAt: number;
};

export type ProviderModelItem = { id: string; name: string; contextWindow?: number; maxOutputLimit?: number; recommended?: boolean; isAuto?: boolean };

export type ProviderModelGroup = {
  providerId: string;
  providerName: string;
  configured: boolean;
  models: (string | ProviderModelItem)[];
  error?: string;
};

export type ApprovalMode = 'ask' | 'edits' | 'autonomous';

export type McpAuthType = 'none' | 'bearer' | 'basic' | 'api-key' | 'custom' | 'oauth2';

export type McpOAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  tokenAuthMethod?: 'client_secret_basic' | 'client_secret_post';
  tokenUrl: string;
  authUrl: string;
  scope?: string;
  resource?: string;
  redirectUri?: string;
};

export type McpAuthConfig = {
  type: McpAuthType;
  token?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
  oauth2Config?: McpOAuthConfig;
};

export type McpOAuthTokens = {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
};

export type McpTransportType = 'http' | 'sse';

export type McpConnectionData = {
  name: string;
  description: string;
  url: string;
  transport: McpTransportType;
  auth: McpAuthConfig;
  enabled: boolean;
  order: number;
};

export type McpConnectionStatus = {
  name: string;
  state: 'ok' | 'auth_required' | 'error' | 'disabled';
  error?: string;
  toolCount?: number;
};

export type ContextAttachment = {
  kind: 'file' | 'folder';
  path: string;
};

export type ImageAttachment = {
  kind: 'image';
  name: string;
  size: number;
  mimeType: string;
  tempPath?: string;
  previewDataUrl?: string;
};

export type Attachment = ContextAttachment | ImageAttachment;

export type ComposerContext = {
  includeActiveFile?: boolean;
  includeSelection?: boolean;
  activeFile?: string;
  selectionLines?: string;
  attachments?: Attachment[];
  includeProjectIndex?: boolean;
};

export type UsageRecord = {
  model: string;
  provider: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
  tokensPerSecond?: number;
};

export interface AppConfig {
  model: string;
  activeProvider: string;
  apiKey: string;
  baseUrl: string;
  maxSteps: number;
  approvalMode: ApprovalMode;
  searxngUrl: string;
  systemPrompt: string;
  mcpServers: string;
  extraFreeModels: string[];
  onlyDefaultModels: boolean;
  agentId: string;
  compactionModel: string;
}

export type { ProjectIntelligence };

export const MAX_FILE_BYTES = 250_000;
export const MAX_TOOL_OUTPUT = 40_000;
export const MAX_PERSISTED_REASONING = 3_000;
/** Hard memory guard only — history is not routinely trimmed at this size. */
export const MAX_STORED_ITEMS = 2_000;
export const MAX_PERSISTED_PROJECTS = 500;
export const MAX_PERSISTED_CONVERSATIONS = 500;

export type ExtensionLogEntry = {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  event: string;
  detail?: string;
};
