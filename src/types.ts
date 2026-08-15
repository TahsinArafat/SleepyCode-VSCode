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
  | { type: 'saveSettings'; maxSteps: number; approvalMode: string; searxngUrl: string; mcpServers: string; activeProvider: string; providers: import('./providers').Provider[]; apiKey: string; extraFreeModels: string; onlyDefaultModels: boolean; confirmDelete: boolean; compactionModel?: string; initialSetup?: boolean; subagentModels?: SubagentModelMap }
  | { type: 'saveProviderApiKey'; providerId: string; apiKey: string }
  | { type: 'removeApiKey'; providerId: string }
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
  | { type: 'compactStatus'; conversationId: string; ok: boolean; summary?: string; inputTokens?: number; outputTokens?: number }
  | { type: 'compactProgress'; conversationId: string; phase: 'start' | 'summarizing' | 'done' | 'cancelled' | 'error'; summary?: string; inputTokens?: number; outputTokens?: number; newContextTokens?: number; contextWindow?: number }
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
  | { type: 'toast'; id: number; title: string; message: string; kind: 'info' | 'attention' };

export type WorkItem = {
  kind: 'reasoning' | 'task' | 'plan';
  text: string;
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
  timestamp: number;
  kind?: 'error';
  gitTree?: string;
  work?: WorkItem[];
  seconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  attachments?: Attachment[];
  changes?: FileChange[];
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
