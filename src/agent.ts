import * as skillIdentity from './skill-identity';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, streamText, isLoopFinished, isStepCount } from 'ai';
import { executeTool } from '@ai-sdk/provider-utils';
import { captureGitTree, commitGit, gitChangedPathsBetween, gitFileAtTree, gitHeadShort, gitHeadTreeOrEmpty, gitPorcelain, gitTreeChanges, invalidateGitTrackedCache, isGitTrackedWorkspace, restoreGitPath, restoreGitTree, stageGitPaths } from './git';
import { cloneProviders, fetchProviderModels, getProvider, SLEEPY_AUTO_MODEL_ID, type Provider } from './providers';
import { installSkillFromRepository, listInstalledSkills, listRepositorySkills, readSkillMarkdown, resolveInstallPath, sanitizeSkillName, searchSkills, uninstallSkill, SKILL_FILE_NAMES, SKILLS_SUBDIR, type InstalledSkill, type SkillInfo } from './skills';
import { buildTools } from './tools';
import type { AppConfig, Attachment, ComposerContext, Conversation, CustomAgentConfig, ExtensionLogEntry, FileChange, FileSnapshot, McpConnectionData, McpConnectionStatus, Project, ProviderModelGroup, ProviderModelItem, SubagentModelMap, TranscriptItem, WebMessage, WorkItem } from './types';
import type { ModelMessage } from 'ai';
import { MAX_FILE_BYTES, MAX_PERSISTED_CONVERSATIONS, MAX_PERSISTED_PROJECTS, MAX_STORED_ITEMS, MAX_STORED_MESSAGES } from './types';
import { attachReasoningToLatestAssistant, backfillAssistantReasoning, collectReasoningText, DEFAULT_PERSISTED_REASONING, extractThinkBlocks, normalizePersistedReasoningLimit, persistedReasoningBody, reasoningTextsFromItems, rememberReasoningText } from './reasoning-core';
import { enqueuePersist, loadEach, splitProjectIndex } from './persist-core';
import { webviewTranscriptItems } from './webview-payload-core';
import { classifyAgentError, conversationTitle, createTranscriptItem, errorMessage, friendlyError, humanToolName, isAuthRejection, isSecret, normalizeApprovalMode, normalizeTranscriptItem, pathInside, providerErrorMessage, requiresApproval, resolvePathSafe, shouldAutoContinue, statusCodeOf, toolTask } from './util';
import { createRetryBudget, retryKindForStatus, retryMessage } from './retry-core.ts';
import { durationMs, toolArgsText, toolResultText } from './tool-payload-core.ts';
import { createThinkSplitter } from './think-strip';
import { AUTO_COMPACT_RATIO, CHARS_PER_TOKEN, COMPACTION_HISTORY_ITEMS, compactionOutputBudget, compactionPromptInput, contextOccupancy, estimateHistoryTokens, estimateMessageTokens, selectCarriedItems, shouldAutoCompact, structuredHistoryBudget, summarizeFileOperations, DEFAULT_CONTEXT_WINDOW } from './compaction-core';
import { appendConversationMessages, droppedMessageCount, iterationRequestMessages, pausedByStepLimit, recoverPendingHistory, selectStructuredHistory } from './iteration-core';
import { pickContextWindow } from './context-window-core';
import { applyTurnSnapshot, branchConversationState, clearForwardStacks, interruptedAssistantFields, interruptedFieldsFromPending, INTERRUPTED_TURN_TEXT, loadCompactionStacks, persistCompactionStacks, popLastTurn, restoreCompaction, resumeFromLastAssistant, sliceMessagesToItems, takeTurnRedo, workspaceGitRestoreFromSnapshot, workspaceRestoreFromSnapshot, type SessionCompactionSnapshot, type SessionTurnSnapshot } from './session-core';
import { classifySubagentStep, harvestSubagentText, rememberVisibleText } from './subagent-core';
import { getWebviewHtml } from './webview';
import * as adapter from './webview-adapter';
import * as modeRules from './agent-mode';
import * as planFile from './plan-file';
import * as fileIcons from './file-icons';
import * as paste from './paste-core';
import * as goalCore from './goal-core';
import * as modelOptions from './model-options';
import * as worktreeNaming from './worktree-naming';
import * as queueCore from './queue-core';
import * as featurePrefs from './feature-prefs';
import * as costCore from './cost-core';
import * as providersCore from './providers-core';
import { renderReactWebviewHtml } from './webview-react';
import { SettingsPanel, type SettingsPanelHost } from './settings-panel';
import * as settingsAdapter from './settings-adapter';
import { systemNotify } from './notifications';
import { aggregateUsage, loadUsage, recordUsage } from './usage';
import { beginMcpOAuth, connectMcpServers, connectToMcpConnections, deleteMcpConnection, emptyMcpConnection, finishMcpOAuth, loadMcpConnections, loginShellEnv, mcpHost, mcpOAuthLogin, parseMcpServers, saveMcpConnection, type McpConnection } from './mcp';
import { McpOAuthProvider } from './mcp-oauth';
import { clearGatewayConfig, fetchSleepyAccountData, fetchSleepyModelPrices, getSleepyAccount, getSleepyToken, getSleepyTokenSync, loginWithBrowser, loginWithDevice, refreshSleepyToken, sleepyApiBase, SLEEPY_ACCOUNT_URL, SLEEPY_WEBSITE_URL, type SleepyModelPrice } from './sleepyai';
import { chooseAutoModel, rankModelsByPrice, sortModelsA2Z } from './model-routing-core';
import { TerminalManager } from './terminal';
import { MEMORY_RELATIVE_PATH, openProjectMemory, readProjectMemory, writeProjectMemory } from './memory';
import { ProjectIndexService } from './project-index';
import { retrieveProjectContext, summarizeProjectIndex, type ProjectIntelligence } from './project-index-core';
import { RepoIndex, scanWorkspace, SourceCitedMemory, loadMemoryJson } from './repo-index';
import { dueTasks, evaluateHooks, nextRunAt, type HookContext, type HookRule, type ScheduledTask } from './hooks';
import { fileChangeStats } from './line-diff';
import { createWorktree, listWorktrees } from './worktrees';
import { BrowserController } from './browser';
import { CliClient, isPreferredCliModel, pickCliModel, type CliProviderCatalog } from './cli-client';
import { CliSessionRegistry, resolveEngine, type EngineStatus } from './cli-engine';
import { CliSessionManager } from './cli-session-manager';
import {
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffort,
  reasoningEffortBody,
  type ReasoningEffort,
} from './reasoning-effort';
import { hasLocalHistory, usesCliEngine } from './engine-routing-core';
import type { CliServer } from './cli-server';
import { BrowserPreviewPanel } from './browser-preview';

type PlanState = {
  title: string;
  steps: string[];
  active: number;
  done: Set<number>;
  manual: boolean;
  interrupted: boolean;
};

const MAX_CONCURRENT_RUNS = 3;

function abortableTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error(`${label} cancelled.`)));
    const timer = setTimeout(() => finish(() => reject(new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)}s.`))), timeoutMs);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

/** Capture a file's pre-edit content so undo can restore it outside Git. `before` avoids a disk read when the tool already supplied it. */
function captureFileSnapshot(rootPath: string, relative: string, before?: unknown, existed?: boolean): FileSnapshot {
  if (typeof before === 'string') return { path: relative, existed: existed ?? true, content: before };
  try {
    const absolute = path.join(rootPath, relative);
    return { path: relative, existed: existed ?? true, content: readFileSync(absolute, 'utf8') };
  } catch {
    return { path: relative, existed: false, content: '' };
  }
}

function readWorkspaceText(rootPath: string, relative: string): string {
  try {
    return readFileSync(path.join(rootPath, relative), 'utf8');
  } catch {
    return '';
  }
}

export const AGENT_DEFINITIONS: { id: string; name: string; color: string; prompt?: string }[] = [
  { id: 'default', name: 'SleepyCode', color: '#6c7086' },
  { id: 'apex', name: 'Apex (Builder)', color: '#f43f5e', prompt: 'Act as an implementation-focused builder. Prefer complete, working vertical slices over speculative discussion. Trace dependencies before editing, keep changes cohesive, and verify the user-visible path end to end.' },
  { id: 'phantom', name: 'Phantom (Debugger)', color: '#9333ea', prompt: 'Act as a debugger. Reproduce failures, form falsifiable hypotheses, inspect state transitions and edge cases, then make the smallest fix that addresses the root cause. Add regression coverage for every confirmed bug.' },
  { id: 'pivot', name: 'Pivot (Prototyper)', color: '#eab308', prompt: 'Act as a pragmatic prototyper. Optimize for fast validated learning while keeping the code reversible and understandable. Build the smallest useful implementation, verify it, then harden only the parts proven necessary.' },
  { id: 'forge', name: 'Forge (Reviewer)', color: '#14b8a6', prompt: 'Act as a rigorous reviewer and implementer. Look for correctness, security, regressions, maintainability, and missing tests. Prioritize concrete findings by severity and fix high-confidence issues without unrelated refactors.' },
  { id: 'stack', name: 'Stack (Architect)', color: '#3b82f6', prompt: 'Act as a software architect who still ships code. Preserve clear boundaries, data ownership, and failure semantics. Prefer simple interfaces and migration-safe changes, then verify architecture decisions against real runtime paths.' },
];

/** Tools that stay available regardless of an agent's allow/deny policy so the UI can still report progress. */
const AGENT_ALWAYS_ALLOWED_TOOLS = new Set(['plan', 'ask_user']);

/** Tool-name prefixes that may be granted or revoked as a group in an agent's policy. */
const AGENT_TOOL_WILDCARDS = ['terminal_', 'skillsmp_', 'web_search', 'worktree_', 'repo_', 'browser_', 'github_'];

/** Keeps only the tools an agent's allow/deny policy permits. Deny always wins; `plan` is never removed. */
function filterAgentTools<T extends Record<string, unknown>>(tools: T, policy?: CustomAgentConfig['tools']): T {
  const allow = (policy?.allow ?? []).map(name => name.trim()).filter(Boolean);
  const deny = (policy?.deny ?? []).map(name => name.trim()).filter(Boolean);
  if (!allow.length && !deny.length) return tools;
  const matches = (names: string[], toolName: string): boolean => names.some(name => {
    if (name === '*' || name === toolName) return true;
    if (name.endsWith('*') && toolName.startsWith(name.slice(0, -1))) return true;
    return AGENT_TOOL_WILDCARDS.includes(name) && toolName.startsWith(name);
  });
  const permitted = (toolName: string): boolean => {
    if (AGENT_ALWAYS_ALLOWED_TOOLS.has(toolName)) return true;
    if (matches(deny, toolName)) return false;
    if (!allow.length) return true;
    return matches(allow, toolName);
  };
  const filtered = { ...tools };
  for (const toolName of Object.keys(tools)) {
    if (!permitted(toolName)) delete filtered[toolName];
  }
  return filtered;
}

/** Decode the XML entities Claude-Code style text tool calls use. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Best-effort conversion of XML parameter values into the JSON types tools expect. */
function coerceXmlParam(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed); } catch { return value; }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return value;
}

/** Parse Claude-Code style text tool calls: <invoke name="read_file"><parameter name="path">src/a.ts</parameter></invoke>. */
function parseInvokeBlocks(text: string): { name: string; params: [string, string][] }[] {
  const calls: { name: string; params: [string, string][] }[] = [];
  const invokeRe = /<invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = invokeRe.exec(text))) {
    const params: [string, string][] = [];
    const paramRe = /<parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRe.exec(invokeMatch[2]!))) {
      params.push([paramMatch[1]!.trim(), decodeXmlEntities(paramMatch[2]!)]);
    }
    calls.push({ name: invokeMatch[1]!.trim(), params });
  }
  return calls;
}

function userOsName(): string {
  switch (process.platform) {
    case 'darwin': return 'macOS (darwin)';
    case 'win32': return 'Windows (win32)';
    case 'linux': return 'Linux (linux)';
    default: return process.platform;
  }
}

function notificationSummary(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

/**
 * The newest assistant item in a transcript, or undefined when there is none.
 *
 * Walks backwards rather than copying the array with `[...items].reverse()`:
 * the conversation list is rebuilt on every state sync, and copying every
 * conversation's whole item array each time is pure allocation churn.
 */
function findLastAssistant(items: readonly TranscriptItem[]): TranscriptItem | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.role === 'assistant') return item;
  }
  return undefined;
}

/**
 * Fold the text a turn streamed before it was stopped or failed into the messages that become
 * durable history. A step-level message list only exists once a step finishes, so a turn cut off
 * mid-answer has none: without this the next message cannot see what the user already read.
 */
function appendPartialAnswer(messages: ModelMessage[], partial: string | undefined): void {
  const text = partial?.trim();
  if (!text) return;
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    if (typeof last.content === 'string') {
      last.content = last.content ? `${last.content}\n${text}` : text;
      return;
    }
    if (Array.isArray(last.content)) {
      (last.content as unknown[]).push({ type: 'text', text });
      return;
    }
  }
  messages.push({ role: 'assistant', content: text });
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type ActiveRun = {
  conversationId: string;
  controller: AbortController;
  steering: boolean;
};

/** Everything a turn needs to pick its model and its thinking budget. */
type Selection = {
  model: string;
  provider: string;
  agentId: string;
  reasoningEffort: ReasoningEffort;
  /** Composer mode; absent means `agent`. */
  mode?: 'agent' | 'ask' | 'plan';
};

type ProjectMetaEntry = { id?: unknown; name?: unknown; path?: unknown; createdAt?: unknown; updatedAt?: unknown };

function isProjectMeta(entry: unknown): entry is ProjectMetaEntry & { id: string; name: string; path: string } {
  const meta = entry as ProjectMetaEntry | undefined;
  return Boolean(meta && typeof meta.id === 'string' && typeof meta.name === 'string' && typeof meta.path === 'string');
}

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private static readonly LOG_KEY = 'sleepycode.extensionLogs';
  private static readonly LOG_LIMIT = 400;
  /** Minimum gap between coalesced mid-run checkpoint writes. */
  private static readonly CHECKPOINT_INTERVAL_MS = 3_000;
  private view?: vscode.WebviewView;
  private reactMode = false;
  /** Conversations whose React transcript is live-streaming (see `post`). */
  private readonly reactStreaming = new Set<string>();
  /** Let the next transcript snapshot through even if that conversation is streaming. */
  private reactSnapshotOnce = false;
  /** The React base has no sign-in banner, so the offer is surfaced once. */
  private signInOffered = false;
  /** Newest assistant item per conversation, used to route React change review. */
  private readonly reactChangeTarget = new Map<string, string>();
  /** Newest running tool call per conversation, so approvals land on its card. */
  private readonly reactLastToolCall = new Map<string, string>();
  /** Last transcript items per conversation, for React actions that need a turn. */
  private readonly reactItems = new Map<string, unknown[]>();
  /** Files the latest turn touched per conversation, for the bulk review buttons. */
  private readonly reactPendingPaths = new Map<string, string[]>();
  /** Serialises draft writes so a keystroke burst cannot interleave. */
  private chatWorkspaceWrite: Promise<void> = Promise.resolve();
  /**
   * Per-subagent abort controllers.
   *
   * A subagent used to share only the parent run's signal, so it could be stopped
   * with the whole run but not on its own. Each entry is linked to the run's
   * controller, so stopping the run still stops its subagents.
   */
  private readonly subagentControllers = new Map<string, AbortController>();
  private projects: Project[] = [];
  private activeProjectId = '';
  private loaded = false;
  private runs = new Map<string, ActiveRun>();
  private mcpNoticeSignatures = new Map<string, string>();
  private queue: { id: string; text: string; conversationId: string; context?: ComposerContext; promptContext?: string }[] = [];
  private queueSeq = 0;
  private apiKeys: Record<string, string> = {};
  private persistChain: Promise<void> = Promise.resolve();
  /** Set once a write failed, so one report covers a chain that keeps failing. */
  private persistFailed = false;
  /** Index entries that failed validation on load, kept verbatim so a rewrite cannot delete them. */
  private unreadableProjectEntries: unknown[] = [];
  /** Last dropped-message count announced per conversation, so the notice is not repeated every turn. */
  private lastHistoryDropNotice = new Map<string, number>();
  /** Timestamp of the last coalesced mid-run checkpoint write, per conversation. */
  private checkpointAtByConversation = new Map<string, number>();
  private notifySeq = 0;
  /**
   * Prompts awaiting an answer. The approval context rides along so the decision
   * can be reported back to the card it came from — without it nothing removed the
   * card, and an answered approval asked for a decision already made.
   */
  private pendingNotifies = new Map<number, { resolve: (choice: 'ok' | 'secondary' | 'cancel') => void; approval?: { conversationId: string } }>();
  /**
   * Questions waiting on the user, keyed by tool call id. A run blocks on one of
   * these, so every entry must be resolved: by an answer, by abort, or by the
   * timeout in `askUser`.
   */
  private pendingQuestions = new Map<string, (answers: Record<string, string[]>) => void>();
  private readonly terminals = new TerminalManager();
  private compactionUndoStacks = new Map<string, SessionCompactionSnapshot<TranscriptItem, ModelMessage>[]>();
  private compactionRedoStacks = new Map<string, SessionCompactionSnapshot<TranscriptItem, ModelMessage>[]>();
  private agentPromptCache = new Map<string, string>(); // agentId -> prompt text
  private sessionAllowedCommands = new Set<string>();
  private sessionAutoApproveEditRoots = new Set<string>();
  private lastSleepyAccountRefresh = 0;
  private readonly projectIndex: ProjectIndexService;
  private repoIndexCache?: { root: string; index: RepoIndex; symboled: boolean };
  private readonly browser = new BrowserController();
  private readonly browserPreview = new BrowserPreviewPanel();
  private browserPreviewTimer: NodeJS.Timeout | undefined;
  private projectIndexTimer?: NodeJS.Timeout;
  private schedulerTimer?: NodeJS.Timeout;
  private lastModelGroups: ProviderModelGroup[] = [];
  private lastSleepyModelPrices: SleepyModelPrice[] = [];
  private lastSleepyPriceRefresh = 0;
  private reviewTempDirs = new Set<string>();
  private subagentSequence = 0;
  private compactionControllers = new Map<string, AbortController>();
  private lastAutoCompactAt = new Map<string, number>();
  /** Last captured git tree + the fs version at capture start, so a clean workspace reuses it. */
  private lastGitTree: { root: string; tree: string; version: number } | undefined;
  /** Bumped on every workspace file change; gates reuse of `lastGitTree`. */
  private fsVersion = 0;
  /** Cached merged MCP connection, reused across turns while its config signature is unchanged. */
  private mcpCache: { key: string; connection: McpConnection } | undefined;

  /**
   * Which engine owns the run loop. The Sleepy CLI owns it whenever it is
   * installed; the local `ToolLoopAgent` is the offline fallback. Resolved once
   * at startup and never swapped for a conversation that has already run, so a
   * chat cannot change engines mid-flight.
   */
  private engineStatus: EngineStatus = { mode: 'local', reason: 'Starting up.' };
  private cliServer: CliServer | undefined;
  private cliClient: CliClient | undefined;
  private cliRegistry: CliSessionRegistry | undefined;
  private cliSessions: CliSessionManager | undefined;
  /** Memoised CLI provider catalog, so a send can name a model that exists. */
  private cliModels: { at: number; catalog: CliProviderCatalog } | undefined;
  /** Conversations already told their sidebar model is not a CLI model. */
  private readonly cliModelNotices = new Set<string>();
  private engineReady: Promise<void> | undefined;
  /** Which setting `engineReady` resolved under, so a toggle can re-resolve without racing the resolve in flight. */
  private engineUseCli: boolean | undefined;

  /** Close and forget the cached MCP connection (on config change or deactivate). */
  private closeMcpCache(): void {
    const cached = this.mcpCache?.connection;
    this.mcpCache = undefined;
    if (cached) void cached.close().catch(() => { });
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.projectIndex = new ProjectIndexService(context, message => this.post(message));
    const onFsEvent = (uri: vscode.Uri): void => {
      this.fsVersion++;
      this.scheduleProjectReindex(uri);
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(onFsEvent),
      watcher.onDidChange(onFsEvent),
      watcher.onDidDelete(onFsEvent),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.onWorkspaceFoldersChanged()),
      vscode.window.onDidChangeActiveTextEditor(() => this.sendEditorContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.sendEditorContext()),
    );
    this.schedulerTimer = setInterval(() => { void this.runDueScheduledTasks(); }, 30_000);
    context.subscriptions.push({ dispose: () => { if (this.schedulerTimer) clearInterval(this.schedulerTimer); } });
    context.subscriptions.push({ dispose: () => { void this.shutdownCli(); } });
    context.subscriptions.push({ dispose: () => this.closeMcpCache() });
    // Warm the SleepyAI token in the background so the first send doesn't block on a cold refresh.
    void getSleepyToken().catch(() => { });
  }

  /**
   * Pick the engine once. Only the local loop writes VS Code globalState; in CLI
   * mode the CLI process owns `sleepy.db` and we never open it.
   */
  private async ensureEngine(): Promise<EngineStatus> {
    const useCli = vscode.workspace.getConfiguration('sleepycode').get<boolean>('useCli', false);
    if (this.engineReady && this.engineUseCli === useCli) {
      await this.engineReady;
      return this.engineStatus;
    }
    if (this.engineReady) await this.engineReady.catch(() => undefined);
    this.engineUseCli = useCli;
    this.engineReady = (async () => {
      const directory = this.workspaceRoot()?.fsPath;
      if (!directory) {
        this.engineStatus = { mode: 'local', reason: 'No folder is open, so this window uses the offline agent.' };
        return;
      }
      this.engineStatus = await resolveEngine(directory, useCli);
      if (this.engineStatus.mode === 'cli' && this.engineStatus.url) {
        this.cliClient = new CliClient(this.engineStatus.url, directory);
        this.cliRegistry = new CliSessionRegistry({
          get: key => this.context.globalState.get<string>(key),
          set: (key, value) => { void this.context.globalState.update(key, value); },
        });
        this.cliSessions = new CliSessionManager(this.cliClient, this.cliRegistry, directory, conversationId => ({
          label: (tool, input) => toolTask(tool, input),
          update: (items, busy) => this.applyCliProjection(conversationId, items, busy),
          error: detail => this.post({ type: 'error', conversationId, text: detail }),
          permission: permission => this.post({
            type: 'permission',
            conversationId,
            permissionId: permission.id,
            title: permission.title ?? 'The CLI is asking for permission.',
          }),
          live: event => this.applyCliLiveEvent(conversationId, event),
        }));
        // A lost CLI session starts a fresh one, which orphans the old conversation in
        // sleepy.db. Say so: silent replacement reads as history vanishing.
        this.cliSessions.onSessionLost = id => {
          this.log('warn', 'cli.session.lost', id);
          this.post({
            type: 'contextNotice',
            conversationId: id,
            kind: 'trimmed',
            text: 'The Sleepy CLI no longer has this session, so a new one was started. The previous CLI history is still on disk but is no longer shown here.',
          });
        };
      }
    })();
    await this.engineReady;
    return this.engineStatus;
  }

  private async shutdownCli(): Promise<void> {
    this.cliSessions?.dispose();
    // Only stop a server this extension started; an attached one is not ours.
    if (this.cliServer?.owned) this.cliServer.child?.kill();
    this.cliServer = undefined;
    this.cliSessions = undefined;
    this.cliClient = undefined;
  }

  /**
   * Open (or rejoin) the CLI session backing this conversation, then hand the
   * send to the CLI. The conversation keeps a mirror of the projected items for
   * display only; the CLI's own rows stay authoritative for undo and resume.
   */
  /**
   * Whether this conversation's next turn belongs to the CLI.
   *
   * A conversation carrying leftover local history stays local for good, so a
   * CLI server starting up later never silently moves an existing chat. See
   * `usesCliEngine` for why we do not migrate.
   */
  private cliOwns(conversation: Conversation, engine: EngineStatus): boolean {
    const boundToSession = this.cliRegistry?.owns(conversation.id) ?? false;
    return usesCliEngine({
      engineAvailable: engine.mode === 'cli' || (boundToSession && Boolean(this.cliClient)),
      boundToSession,
      hasLocalHistory: hasLocalHistory(conversation),
    });
  }

  /**
   * Refuse a local-history operation on a conversation the CLI owns.
   *
   * Commands that rewind, fork, or summarise `items` are all local-only
   * operations. On a CLI conversation `items` is a display mirror and `messages`
   * is deliberately undefined, so editing one rewrites a transcript the CLI
   * still holds, and compacting fabricates a summary the CLI never made. The
   * UI cannot be trusted to hide these buttons on its own, so the extension
   * refuses them here and says why.
   *
   * Returns true when the caller should stop.
   */
  private refuseIfCliOwned(conversation: Conversation, action: string): boolean {
    if (!this.cliOwns(conversation, this.engineStatus)) return false;
    this.post({
      type: 'error',
      conversationId: conversation.id,
      text: `${action} is not available in a CLI conversation. Its history lives in the Sleepy CLI, not in this window.`,
    });
    return true;
  }

  private cliChatFor(conversationId: string, _root?: vscode.Uri) {
    return this.cliSessions?.open(conversationId) ?? Promise.resolve(undefined);
  }

  /**
   * Render the CLI's rows. This replaces the display transcript only; the CLI
   * still owns the real history, so nothing here is fed back as a prompt.
   */
  private applyCliProjection(conversationId: string, items: TranscriptItem[], busy: boolean): void {
    const conversation = this.findConversation(conversationId);
    if (!conversation) return;
    conversation.items = items;
    // These are display-only mirrors of CLI rows, not a second history. They are
    // cleared on purpose because in CLI mode the authoritative record lives in
    // `sleepy.db` and must never be replayed as model-visible history.
    conversation.messages = undefined;
    conversation.pending = undefined;
    this.boundConversationItems(conversation);
    this.post({ type: 'state', conversationId, running: busy, label: busy ? 'Working' : '' });
    // A full conversation republish wipes the streaming node. Keep the
    // in-memory items while the CLI is busy; rebuild the settled transcript
    // only when idle. Clear the webview's live buffer first, otherwise
    // renderConversation() draws the settled answer and renderLive() appends
    // the same streamed text a second time.
    if (busy) return;
    this.post({ type: 'cliSettled', conversationId });
    this.syncConversations();
  }

  private applyCliLiveEvent(conversationId: string, event: import('./cli-engine').CliLiveEvent): void {
    if (event.kind === 'delta') this.post({ type: 'delta', conversationId, text: event.text });
    else if (event.kind === 'reasoningDelta') this.post({ type: 'reasoningDelta', conversationId, text: event.text });
    else this.post({ type: 'tool', conversationId, phase: event.phase, id: event.id, tool: event.tool, name: event.name, failed: event.failed });
  }

  private findConversation(conversationId: string): Conversation | undefined {
    for (const project of this.projects) {
      const found = project.conversations.find(conversation => conversation.id === conversationId);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * The CLI's provider catalog, memoised briefly.
   *
   * Only used to pick a model that exists. A failed lookup returns undefined so
   * the caller can fall back to the CLI's own resolution rather than blocking
   * every send on a lookup that is currently down.
   */
  private async cliProviderCatalog(): Promise<CliProviderCatalog | undefined> {
    const now = Date.now();
    if (!this.cliModels || now - this.cliModels.at > 60_000) {
      try {
        this.cliModels = { at: now, catalog: (await this.cliClient?.providerCatalog()) ?? { providers: [], defaults: {}, connected: [] } };
      } catch (error) {
        this.log('warn', 'cli.models.unavailable', errorMessage(error));
        return undefined;
      }
    }
    return this.cliModels.catalog;
  }

  private async sendViaCli(conversationId: string, text: string, root?: vscode.Uri): Promise<void> {
    // The composer has already cleared itself, so a send that never reached the
    // CLI would take the user's prompt with it. Both failure paths hand the
    // text back to the composer instead of dropping it.
    const chat = await this.cliChatFor(conversationId, root);
    if (!chat) {
      this.post({ type: 'error', conversationId, text: 'The Sleepy CLI is not reachable, so this message was not sent.' });
      this.post({ type: 'restoreDraft', conversationId, text });
      return;
    }
    this.post({ type: 'state', conversationId, running: true, label: 'Working' });
    // Always name a concrete model. The CLI resolves an unspecified one from its
    // own config, and that default is a placeholder that exists in no provider
    // (`sleepy/auto-best-coding`), so omitting it fails every send with "Model
    // not found". The sidebar's pick wins when the CLI actually has it -- the
    // sidebar lists SleepyCode's models, which the CLI has never heard of.
    const sending = this.findConversation(conversationId);
    const selection = sending ? this.selectionFor(sending) : undefined;
    const preferred = selection?.provider && selection.model
      ? { providerID: selection.provider, modelID: selection.model }
      : undefined;
    const catalog = await this.cliProviderCatalog();
    const model = pickCliModel(
      catalog ?? { providers: [], defaults: {}, connected: [] },
      preferred,
    );
    // `isPreferredCliModel` allows for the provider-id alias, so a send that
    // really did use the requested model does not raise a false mismatch.
    if (preferred && !isPreferredCliModel(preferred, model)) {
      this.log('warn', 'cli.model.unknown', `${preferred.providerID}/${preferred.modelID}`);
      // Say it once per conversation. The sidebar lists SleepyCode's providers
      // and models, which the CLI does not have, so the mismatch is permanent
      // rather than a one-off -- repeating the notice on every send buried the
      // transcript under a wall of identical errors.
      if (!this.cliModelNotices.has(conversationId)) {
        this.cliModelNotices.add(conversationId);
        this.post({
          type: 'error',
          conversationId,
          keepTurn: true,
          text: model
            ? `The Sleepy CLI has no model "${preferred.modelID}" under provider "${preferred.providerID}". This conversation will use ${model.providerID}/${model.modelID} instead.`
            : `The Sleepy CLI has no model "${preferred.modelID}" under provider "${preferred.providerID}", and no connected provider to fall back to.`,
        });
      }
    }
    if (!model) this.log('warn', 'cli.model.none', 'no connected provider offers a model');
    // prompt_async creates the real user message in the CLI; the client never
    // writes a synthetic "Continue" turn.
    try {
      await chat.send(text, model);
    } catch (error) {
      const detail = errorMessage(error);
      this.log('error', 'cli.send.failed', detail);
      this.post({ type: 'error', conversationId, text: detail });
      this.post({ type: 'restoreDraft', conversationId, text });
    }
  }

  /** Continue the interrupted assistant the CLI still has, with no new user turn. */
  private async continueViaCli(conversationId: string, root?: vscode.Uri): Promise<boolean> {
    // Open the chat if it is not in memory yet: a reloaded window has an empty
    // map even though the conversation still lives in the CLI, and failing here
    // would silently resume it with the local agent instead.
    const chat = this.cliSessions?.get(conversationId) ?? (await this.cliChatFor(conversationId, root));
    if (!chat) return false;
    const resumed = await chat.continueTurn();
    if (!resumed) {
      this.post({ type: 'error', conversationId, text: 'There is no interrupted turn to continue.' });
    }
    return resumed;
  }

  private async stopViaCli(conversationId: string): Promise<boolean> {
    const chat = this.cliSessions?.get(conversationId);
    if (!chat) return false;
    await chat.stop();
    return true;
  }

  /**
   * Undo and redo belong to whichever engine owns the conversation.
   *
   * A CLI conversation's items are only a display mirror, so popping one locally
   * would rewrite a transcript the CLI still holds and would leave the files the
   * CLI reverted untouched. CLI revert restores the snapshot/patch parts and the
   * revert point together, then republishes, so the two stay consistent.
   *
   * Returns false when the conversation is not CLI-owned or the chat is gone, so
   * the caller can fall through to the local undo stack.
   */
  private async undoViaCli(conversation: Conversation, root?: vscode.Uri): Promise<boolean> {
    if (!this.cliOwns(conversation, this.engineStatus)) return false;
    const chat = this.cliSessions?.get(conversation.id) ?? (await this.cliChatFor(conversation.id, root));
    if (!chat) return false;
    // The CLI picks its own revert target, so it can also tell us when there is
    // no finished assistant turn to rewind. Falling through to the local stack
    // in that case would pop items the CLI still owns.
    const reverted = await chat.undo();
    if (!reverted) {
      this.post({ type: 'error', conversationId: conversation.id, text: 'There is no turn to undo in this conversation yet.' });
    }
    return true;
  }

  private async redoViaCli(conversation: Conversation, root?: vscode.Uri): Promise<boolean> {
    if (!this.cliOwns(conversation, this.engineStatus)) return false;
    const chat = this.cliSessions?.get(conversation.id) ?? (await this.cliChatFor(conversation.id, root));
    if (!chat) return false;
    await chat.redo();
    return true;
  }

  /** User-defined agents persisted in global state. Invalid entries are dropped rather than trusted. */
  private customAgents(): CustomAgentConfig[] {
    const stored = this.context.globalState.get<unknown[]>('sleepycode.customAgents', []);
    if (!Array.isArray(stored)) return [];
    return stored.filter((agent): agent is CustomAgentConfig => Boolean(agent) && typeof agent === 'object' && typeof (agent as CustomAgentConfig).id === 'string' && typeof (agent as CustomAgentConfig).name === 'string');
  }

  private async saveCustomAgents(list: CustomAgentConfig[]): Promise<void> {
    await this.context.globalState.update('sleepycode.customAgents', list);
  }

  /** Built-in agents first, then user agents. A user agent may not shadow a built-in id. */
  private allAgents(): CustomAgentConfig[] {
    const builtIns = AGENT_DEFINITIONS as CustomAgentConfig[];
    const builtInIds = new Set(builtIns.map(agent => agent.id));
    return [...builtIns, ...this.customAgents().filter(agent => !builtInIds.has(agent.id))];
  }

  private agentConfig(agentId: string): CustomAgentConfig | undefined {
    return this.allAgents().find(agent => agent.id === agentId);
  }

  /** Matches a leading `@agent-id` token against the agent roster and strips it from the request. */
  private parseAgentMention(text: string): { agentId?: string; text: string } {
    const match = text.match(/^\s*@([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { text };
    const agent = this.allAgents().find(item => item.id.toLowerCase() === match[1]!.toLowerCase());
    if (!agent) return { text };
    const rest = (match[2] ?? '').trim();
    return { agentId: agent.id, text: rest || text.trim() };
  }

  /** Repairs a selection that points at a deleted custom agent. Returns true when state changed. */
  private async ensureSelectedAgent(): Promise<boolean> {
    const base = this.config();
    if (this.agentConfig(base.agentId)) return false;
    const fallback = AGENT_DEFINITIONS[0]!.id;
    await this.context.globalState.update('sleepycode.agentId', fallback);
    let changed = false;
    for (const project of this.projects) {
      for (const conversation of project.conversations) {
        if (conversation.agentId !== base.agentId) continue;
        conversation.agentId = fallback;
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        changed = true;
      }
    }
    this.postConfig();
    return changed;
  }

  private scheduledTasks(): ScheduledTask[] {
    const stored = this.context.globalState.get<unknown[]>('sleepycode.scheduledTasks', []);
    if (!Array.isArray(stored)) return [];
    return stored.filter((task): task is ScheduledTask => Boolean(task) && typeof task === 'object' && typeof (task as ScheduledTask).id === 'string' && typeof (task as ScheduledTask).prompt === 'string');
  }

  private async runDueScheduledTasks(): Promise<void> {
    if (!vscode.workspace.getConfiguration('sleepycode').get<boolean>('tasksHooks', true)) return;
    const tasks = this.scheduledTasks();
    if (!tasks.length) return;
    const due = dueTasks(tasks, Date.now());
    if (!due.length) return;
    const now = Date.now();
    const updated = tasks.map(task => {
      if (!due.some(item => item.id === task.id)) return task;
      return { ...task, lastRunAt: now, nextRunAt: nextRunAt(task.schedule, now) };
    });
    await this.context.globalState.update('sleepycode.scheduledTasks', updated);
    for (const task of due) {
      if (!task.enabled) continue;
      if (this.runs.size >= MAX_CONCURRENT_RUNS) {
        this.enqueue(task.prompt, this.activeProject()?.activeConversationId ?? '');
        continue;
      }
      const project = this.activeProject();
      const conversationId = project?.activeConversationId ?? '';
      this.notifyHooks('onAgentStart', { text: `scheduled:${task.name}` });
      void this.run(task.prompt, conversationId, undefined, undefined, undefined, `Scheduled task "${task.name}".`);
    }
  }

  private onWorkspaceFoldersChanged(): void {
    this.projectIndex.invalidate();
    invalidateGitTrackedCache();
    if (!this.loaded) return;
    this.reanchorToWorkspace();
    void this.ensureProjectIntelligence(false);
  }

  private scheduleProjectReindex(uri: vscode.Uri): void {
    const root = this.workspaceRoot();
    if (!root || !pathInside(root.fsPath, uri.fsPath)) return;
    const relative = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
    if (/(^|\/)(node_modules|\.git|dist|out|build|coverage|\.next|target|vendor)(\/|$)/.test(relative)) return;
    this.projectIndex.invalidate(root.fsPath);
    if (this.projectIndexTimer) clearTimeout(this.projectIndexTimer);
    this.projectIndexTimer = setTimeout(() => { void this.ensureProjectIntelligence(true); }, 1_800);
  }

  private async ensureProjectIntelligence(force: boolean): Promise<ProjectIntelligence | undefined> {
    const root = this.workspaceRoot();
    if (!root) return undefined;
    try { return await this.projectIndex.ensure(root, force); }
    catch { return undefined; }
  }

  private reanchorToWorkspace(): void {
    const previous = this.activeProjectId;
    const root = this.workspaceRoot()?.fsPath;
    if (root) {
      let project = this.projects.find(item => item.path === root);
      if (!project) {
        project = this.createProject(root);
        this.projects.unshift(project);
        this.migrateLegacyWorkspaceState(project);
      }
      this.activeProjectId = project.id;
    } else {
      this.activeProjectId = this.projects[0]?.id ?? '';
    }
    if (this.activeProjectId !== previous || root) {
      this.sortProjects();
      void this.persistProjects();
      this.syncConversations();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.reactMode = this.context.globalState.get<boolean>('useReactWebview', true);
    view.webview.options = { enableScripts: true };
    view.webview.html = this.reactMode
      ? renderReactWebviewHtml(view.webview, this.context.extensionUri, 'sidebar', 'SleepyCode')
      : getWebviewHtml(view.webview, this.context.extensionUri, this.workspaceRoot()?.fsPath);
    view.webview.onDidReceiveMessage((message: any) => {
      if (this.reactMode && this.handleReactChangeAction(message)) return;
      if (this.reactMode && message?.type === 'updateChatWorkspace') {
        void this.persistChatWorkspace(message.state);
        return;
      }
      if (this.reactMode && message?.type === 'searchConversations') {
        // The history panel searches over the host's real conversations; the
        // webview only holds summaries. Without this the search box did nothing.
        const project = this.activeProject();
        this.post(adapter.conversationSearchResults(
          Number(message.requestId ?? 0),
          project?.conversations,
          String(message.query ?? ''),
          message.archived === true,
        ));
        return;
      }
      if (this.reactMode && message?.type === 'continueRun') {
        const conversationId = this.activeProject()?.activeConversationId;
        const target = adapter.continueTarget(conversationId, conversationId ? this.reactItems.get(conversationId) : undefined);
        if (target) void this.onMessage({ type: 'continueIteration', ...target } as WebMessage);
        return;
      }
      if (this.reactMode && message?.type === 'setApprovalPreset') {
        void this.applyApprovalPreset(message.preset);
        return;
      }
      const translated = this.reactMode ? adapter.toSleepyMessage(message) : message;
      // React sends messages with no SleepyCode counterpart (queue
      // actions, goals). Dropping them keeps the host handler from having to
      // understand a protocol it does not speak.
      if (!translated) return;
      void this.onMessage(translated as WebMessage).catch(error => {
        const detail = errorMessage(error);
        this.log('error', 'webview.message.failed', detail);
        this.post({ type: 'error', text: detail });
        this.post({ type: 'state', conversationId: this.activeProject()?.activeConversationId ?? '', running: false, label: '' });
      });
    });
    view.onDidDispose(() => this.disposePendingNotifies());
    this.loaded = true;
    // loadProjects runs after the webview is live, so an escaped throw rendered an
    // empty chat with nothing in the UI to explain it. Keep whatever loaded.
    try {
      this.loadProjects();
    } catch (error) {
      this.log('error', 'projects.load.failed', errorMessage(error));
      this.post({ type: 'error', conversationId: '', text: `SleepyCode could not load your conversations: ${errorMessage(error)}` });
    }
    this.syncConversations();
    void this.migrateProvidersIfNeeded().then(() => this.loadApiKeys()).then(() => {
      if (this.view !== view) return;
      this.postConfig();
      void this.maybeShowFirstLaunchSettings();
    });
  }

  /**
   * Hand the React webview its opening payload: the conversation list, the
   * active transcript and the bootstrap state. The React app renders nothing
   * until `initialState` arrives, so this runs on every `ready`.
   */
  /** Republish the active conversation's totals, e.g. after opening it. */
  private refreshSessionStats(): void {
    const active = this.activeConversation();
    if (active) this.postSessionStats(active.id);
  }

  private sendReactBootstrap(): void {
    const active = this.activeConversation();
    const selection = active ? this.selectionFor(active) : undefined;
    this.post(adapter.buildInitialState({
      activeId: active?.id,
      workspaceRoot: this.workspaceRoot()?.fsPath,
      selectedModel: selection?.model ?? '',
      turns: adapter.itemsToTurns(webviewTranscriptItems(active?.items)),
      // Without this the context ring started at zero on every reload, even
      // though the conversation already had a measured window in use.
      usedTokens: adapter.contextTokensOf(webviewTranscriptItems(active?.items)),
      approvalMode: this.config().approvalMode,
      mode: active?.mode ?? 'agent',
      // Drafts and open tabs live per workspace; without this they are lost on
      // every reload.
      workspaceState: this.readChatWorkspace(),
      uiPrefs: this.readChatPrefs(),
      reasoningEffort: selection?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      agentId: selection?.agentId,
      agents: this.allAgents(),
    }));
    // Queued prompts and goals are host state the webview holds a copy of. They
    // must be re-sent here or a reload shows an empty queue while the host still
    // intends to run those prompts — and "Resume interrupted request" has no row
    // to resume from.
    this.postWorkflow(active?.id);
    // Same for the session totals: they are derived from stored records, so a
    // reload can rebuild them rather than starting from zero.
    this.refreshSessionStats();
  }

  /** Open the settings window (also used by the command). */
  public openSettingsWindow(section?: string): void {
    SettingsPanel.show(this.context, this.settingsPanelHost(), section);
  }

  /**
   * Adapt SleepyCode's configuration and MCP storage to the settings window.
   * The panel owns no storage of its own, so every read and write lands on the
   * same state the rest of the extension uses.
   */
  /**
   * Search the SkillsMP catalogue.
   *
   * Extracted so the sidebar's marketplace view and the settings window's
   * Marketplace section share one implementation: two copies of a search is how
   * the MCP transports diverged.
   */
  private async searchMarketplace(query: string, sortBy?: 'stars' | 'recent'): Promise<{ skills: SkillInfo[]; total: number }> {
    return searchSkills(query, { limit: 20, sortBy: sortBy ?? 'stars' });
  }

  /** Installed skills, read from the global skills folder. */
  private async installedSkillList(): Promise<InstalledSkill[]> {
    await this.ensureGlobalSkills();
    return listInstalledSkills(this.skillsRoot());
  }

  /**
   * Install a skill from a repository reference (a URL or `owner/repo`).
   * Returns a user-facing outcome instead of posting, so every surface can
   * present it its own way.
   */
  private async installMarketplaceSkill(
    source: string,
    requested?: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: boolean; text: string }> {
    await this.ensureGlobalSkills();
    try {
      const reference = resolveInstallPath(source, requested ?? '', 'main');
      let folderPath = reference.folderPath;
      if (!folderPath) {
        const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch);
        const match = requested
          ? skills.find(candidate => candidate.name === sanitizeSkillName(requested) || candidate.name.toLowerCase() === requested.trim().toLowerCase())
          : undefined;
        if (!match) {
          return {
            ok: false,
            text: skills.length
              ? `${reference.owner}/${reference.repo} has ${skills.length} skills. Pick one: ${skills.slice(0, 20).map(skill => skill.name).join(', ')}`
              : `No SKILL.md skills found in ${reference.owner}/${reference.repo}.`,
          };
        }
        folderPath = match.path;
      }
      // The folder is namespaced by vendor so two skills of the same name can
      // both be installed; the name the agent uses stays the plain skill name.
      const skillName = sanitizeSkillName(reference.hintedName ?? folderPath.split('/').pop() ?? requested ?? 'skill');
      const installName = skillIdentity.skillFolderName({ owner: reference.owner, repo: reference.repo, name: skillName });
      await this.approve('edit', 'Install skill "' + installName + '"?', 'Source: ' + reference.owner + '/' + reference.repo + (folderPath ? ' (' + folderPath + ')' : '') + '\n\nThe skill will be installed into your global skills folder as \'' + installName + '\' and is available in every workspace. Its SKILL.md will be added to the agent\'s instructions on every future request and can direct file edits and commands. Only install skills from trusted authors.');
      await installSkillFromRepository(this.skillsRoot(), { owner: reference.owner, repo: reference.repo, branch: reference.branch, folderPath, installName }, undefined, onProgress);
      const sources = this.context.globalState.get<Record<string, string>>('sleepycode.skillSources', {}) ?? {};
      sources[installName] = reference.owner + '/' + reference.repo;
      await this.context.globalState.update('sleepycode.skillSources', sources);
      return { ok: true, text: `Installed '${skillName}' from ${reference.owner}/${reference.repo}. Ask SleepyCode to use the '${skillName}' skill by name.` };
    } catch (error) {
      return { ok: false, text: errorMessage(error) };
    }
  }

  /** Remove an installed skill by folder name. */
  private async uninstallMarketplaceSkill(folder: string): Promise<{ ok: boolean; text: string }> {
    await this.ensureGlobalSkills();
    try {
      const installed = await listInstalledSkills(this.skillsRoot());
      const found = skillIdentity.findSkill(installed, folder);
      if (found.kind === 'ambiguous') return { ok: false, text: skillIdentity.ambiguousSkillMessage(folder, found.candidates) };
      if (found.kind !== 'found') return { ok: false, text: `Skill '${folder || ''}' not found.` };
      const skill = found.skill;
      const choice = await this.prompt('Uninstall skill \'' + skill.name + '\'?', 'This removes \'' + skill.name + '\' from your global skills folder. It will no longer be offered to the agent in any workspace.', { ok: 'Uninstall', cancel: 'Cancel', danger: true });
      if (choice !== 'ok') return { ok: false, text: 'Uninstall cancelled.' };
      await uninstallSkill(this.skillsRoot(), skill.folder);
      const sources = this.context.globalState.get<Record<string, string>>('sleepycode.skillSources', {}) ?? {};
      delete sources[skill.folder];
      await this.context.globalState.update('sleepycode.skillSources', sources);
      return { ok: true, text: `Removed '${skill.name}'.` };
    } catch (error) {
      return { ok: false, text: errorMessage(error) };
    }
  }

  /**
   * Drafts and open tabs, keyed per workspace.
   *
   * A React-mode capability: the classic webview never persisted drafts, so there
   * was no existing mechanism to reuse. Keyed by the workspace path so two
   * windows on different folders do not share a draft.
   */
  private chatWorkspaceKey(): string {
    return `sleepycode.chatWorkspace.${this.workspaceRoot()?.fsPath ?? 'none'}`;
  }

  private readChatWorkspace(): unknown {
    return this.context.globalState.get<unknown>(this.chatWorkspaceKey(), undefined);
  }

  /**
   * What this conversation has consumed and cost.
   *
   * The host owns the arithmetic because it owns the prices: shipping rates to the
   * webview would duplicate the split between cached and uncached input tokens,
   * which is the part that is easy to get wrong.
   */
  private postSessionStats(conversationId: string): void {
    if (!this.reactMode || !conversationId) return;
    const records = costCore.recordsFor(loadUsage(this.context), conversationId);
    // The prices the account last reported, cached on this provider. Reading the
    // account here would return only the signed-in flags.
    const prices = this.lastSleepyModelPrices as costCore.ModelPrice[];
    const summary = costCore.sessionSummary(
      records.map(record => ({
        model: record.model,
        input: record.inputTokens,
        output: record.outputTokens,
        cacheRead: record.cacheReadTokens ?? 0,
        cacheWrite: record.cacheWriteTokens ?? 0,
      })),
      prices,
    );
    const conversation = this.activeProject()?.conversations.find(item => item.id === conversationId);
    const selection = conversation ? this.selectionFor(conversation) : undefined;
    const model = selection?.model;
    const providerId = selection?.provider ?? '';
    this.post({
      type: 'sessionStats',
      conversationId,
      tokens: summary.tokens,
      cost: summary.cost,
      speed: costCore.latestSpeed(records),
      contextLimit: this.getEffectiveModelInfo(providerId, model ?? '').contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    });
  }

  /** Whether a finished request should be written to the local usage log. */
  private shouldRecordUsage(): boolean {
    return settingsAdapter.shouldRecordUsage(this.readChatPrefs());
  }

  /** Chat preferences for this workspace, validated against their defaults. */
  private readChatPrefs(): featurePrefs.ChatPrefs {
    const stored = this.readChatWorkspace() as { prefs?: unknown } | undefined;
    return featurePrefs.normalizePrefs(stored?.prefs);
  }

  /**
   * Apply a feature payload's chat preferences.
   *
   * Only the keys the payload carries are taken, so an MCP edit — which posts
   * the feature set without the preferences — cannot reset the user's text size
   * or tab count.
   */
  private async writeChatPrefs(patch: Partial<featurePrefs.ChatPrefs>): Promise<void> {
    const next = featurePrefs.applyPrefs(this.readChatPrefs(), patch);
    await this.persistChatWorkspace({ prefs: next });
    this.postConfig();
  }

  private persistChatWorkspace(update: unknown): Promise<void> {
    const key = this.chatWorkspaceKey();
    const current = this.readChatWorkspace() as Record<string, unknown> | undefined;
    const merged = adapter.mergeWorkspaceState(current as never, update as never);
    const storable = adapter.toStorableWorkspaceState(merged);
    if (storable.trimmed) {
      // Say so rather than silently dropping an attachment the user still sees
      // in the composer.
      this.log('warn', 'chatWorkspace.draft.trimmed', 'attachments too large to persist');
    }
    const { trimmed: _trimmed, ...state } = storable;
    this.chatWorkspaceWrite = this.chatWorkspaceWrite.then(() => this.context.globalState.update(key, state));
    return this.chatWorkspaceWrite;
  }

  /**
   * Write a conversation to a Markdown file the user picks.
   *
   * Markdown rather than JSON: the point is a readable record to share or keep,
   * and the transcript already reads as one.
   */
  private async exportConversation(conversationId?: string): Promise<void> {
    const project = this.activeProject();
    const conversation = conversationId
      ? project?.conversations.find(item => item.id === conversationId)
      : this.activeConversation();
    if (!conversation) {
      void vscode.window.showInformationMessage('There is no conversation to export.');
      return;
    }
    const root = this.workspaceRoot();
    const defaultUri = vscode.Uri.file(path.join(root?.fsPath ?? os.tmpdir(), adapter.exportFileName(conversation.title)));
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ['md'] },
      saveLabel: 'Export',
      title: 'Export conversation',
    });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(adapter.conversationToMarkdown(conversation), 'utf8'));
      this.log('info', 'conversation.exported', `${conversation.id} -> ${target.fsPath}`);
      const choice = await vscode.window.showInformationMessage(`Exported to ${path.basename(target.fsPath)}.`, 'Open');
      if (choice === 'Open') await vscode.window.showTextDocument(target, { preview: true });
    } catch (error) {
      const detail = errorMessage(error);
      this.log('error', 'conversation.export.failed', detail);
      void vscode.window.showErrorMessage(`Could not export the conversation: ${detail}`);
    }
  }

  /**
   * Ask the user and wait for the answer.
   *
   * Deliberately blocking: the tool's result *is* the answer, so returning early
   * would make the model guess. Every exit path resolves the promise — an answer,
   * an aborted run, or the timeout — because a run that never resolves is a hung
   * extension.
   */
  /**
   * Report which preflight stage a send reached, and complain if one stalls.
   *
   * A send that never produces a run used to leave no trace beyond
   * "message.send.received", which is indistinguishable from a dead extension.
   * Each call records the stage; a 20 s timer names the stage that never
   * finished.
   */
  private beginSendStage(conversationId: string): (stage: string) => void {
    let current = 'start';
    const started = Date.now();
    let reported = false;
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      this.log('warn', 'message.send.stalled', `conversation=${conversationId}; stage=${current}; elapsed=${elapsed}ms`);
      // Say it in the chat too: a send that silently never starts is
      // indistinguishable from a broken extension.
      if (!reported && elapsed >= 20_000) {
        reported = true;
        this.post({
          type: 'error',
          conversationId,
          text: `This message has not started after ${Math.round(elapsed / 1000)}s (stuck at "${current}"). Open the SleepyCode log for details, or press Stop and try again.`,
        });
      }
    }, 20_000);
    timer.unref?.();
    return (next: string) => {
      current = next;
      this.log('info', 'message.send.stage', `${next} (${Date.now() - started}ms)`);
      if (next === 'done') clearInterval(timer);
    };
  }

  private async askUser(
    conversationId: string,
    header: string,
    questions: { question: string; options?: string[]; multiple?: boolean; type?: string; required?: boolean; placeholder?: string }[],
    callId: string | undefined,
    signal?: AbortSignal,
    timeoutMs = 10 * 60_000,
  ): Promise<Record<string, string[]>> {
    const id = callId || `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.log('info', 'question.asked', `${id}: ${questions.length} question(s)`);
    return new Promise<Record<string, string[]>>((resolve) => {
      let settled = false;
      const finish = (answers: Record<string, string[]>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pendingQuestions.delete(id);
        resolve(answers);
      };
      const onAbort = () => finish({});
      const timer = setTimeout(() => {
        this.log('warn', 'question.timeout', id);
        finish({});
      }, timeoutMs);
      if (signal?.aborted) return finish({});
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingQuestions.set(id, finish);
      this.post({ type: 'question', conversationId, callId: id, header, questions });
    });
  }

  /**
   * Find where pasted code came from.
   *
   * Searches a distinctive line across workspace files and accepts only a unique
   * hit: a wrong `@code` mention is worse than a plain paste, because the model
   * would be pointed at the wrong file. Bounded so a paste cannot scan a huge
   * repository for long.
   */
  private async locatePastedCode(text: string): Promise<paste.CodeMention | undefined> {
    const needle = paste.pastedCodeSearchLine(text);
    if (!needle) return undefined;
    const root = this.workspaceRoot();
    if (!root) return undefined;
    try {
      const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', 2_000);
      let found: { path: string; line: number } | undefined;
      for (const uri of files) {
        let content: string;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_FILE_BYTES) continue;
          content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          continue;
        }
        const index = content.indexOf(needle);
        if (index < 0) continue;
        if (found) {
          // Ambiguous: two files contain the paste, so neither is "the" source.
          this.log('info', 'paste.ambiguous', needle.slice(0, 60));
          return undefined;
        }
        found = {
          path: path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/'),
          line: content.slice(0, index).split('\n').length,
        };
      }
      if (found) this.log('info', 'paste.located', `${found.path}:${found.line}`);
      return paste.toCodeMention(found);
    } catch (error) {
      this.log('warn', 'paste.locate.failed', errorMessage(error));
      return undefined;
    }
  }

  /** Publish one conversation's goal in the shape the webview reads. */
  private postGoal(conversation: Conversation): void {
    if (!conversation.goal) return;
    this.post({ type: 'goal', conversationId: conversation.id, goal: conversation.goal });
  }

  /** Per-model option overrides, normalised from storage. */
  private storedModelOptions(): modelOptions.OverrideStore {
    return modelOptions.normalizeOverrides(this.context.globalState.get<unknown>('sleepycode.modelOptions'));
  }

  /**
   * Create an isolated worktree for a piece of work and offer to open it.
   *
   * SleepyCode binds to ONE workspace root — 46 call sites resolve paths through
   * `workspaceRoot()` — so a conversation cannot run in a second tree while the
   * first stays open. Opening the worktree as the workspace is what isolation
   * means here: it rebinds the extension, and the work happens in its own branch
   * with the original folder untouched. Faking per-conversation roots would mean
   * rewriting every path resolution, where a mistake writes to the wrong tree.
   */
  private async createWorktreeConversation(title?: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showInformationMessage(adapter.noWorkspaceMessage());
      return;
    }
    if (!isGitTrackedWorkspace(root.fsPath)) {
      void vscode.window.showInformationMessage('Worktrees need a Git repository. This folder is not one.');
      return;
    }
    const conversation = this.activeConversation();
    const name = worktreeNaming.worktreeNameFor(title || conversation?.title);
    try {
      const tree = await createWorktree(root.fsPath, { name });
      this.log('info', 'worktree.created', `${name} -> ${tree.path}`);
      const choice = await vscode.window.showInformationMessage(
        `Worktree "${name}" created on its own branch. Open it to work there?`,
        'Open in new window',
        'Reveal',
      );
      const uri = vscode.Uri.file(tree.path);
      if (choice === 'Open in new window') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      else if (choice === 'Reveal') await vscode.commands.executeCommand('revealFileInOS', uri);
    } catch (error) {
      const detail = errorMessage(error);
      this.log('error', 'worktree.create.failed', detail);
      void vscode.window.showErrorMessage(`Could not create the worktree: ${detail}`);
    }
  }

  private settingsPanelHost(): SettingsPanelHost {
    return {
      signIn: () => this.signIn(),
      sleepyAccount: async () => {
        // The stored config is the truth about being signed in; the dashboard is
        // the only place the limits live, and it is allowed to be unreachable.
        const account = getSleepyAccount();
        if (!account.loggedIn) return account;
        const token = await getSleepyToken().catch(() => null);
        if (!token) return account;
        const usage = await fetchSleepyAccountData(token).catch(() => null);
        return usage ? { ...account, ...usage } : account;
      },
      signOut: async () => {
        await clearGatewayConfig();
        // The chat's own banner reads this status, so signing out here has to
        // reach it too — otherwise one surface says signed in and the other out.
        this.post({ type: 'sleepyStatus', loggedIn: false, busy: false, text: '' });
      },
      writeChatPrefs: (patch) => this.writeChatPrefs(patch),
      openPanelFile: async (rawPath) => {
        const root = this.workspaceRoot();
        // Resolve first (the Rules row is workspace-relative), then authorise
        // against the roots this extension owns. The path came from a webview
        // message, so it is never opened unchecked.
        const resolved = settingsAdapter.resolvePanelPath(rawPath, root?.fsPath);
        const allowed = settingsAdapter.openableFile(resolved, [
          root?.fsPath ?? '',
          this.skillsRoot().fsPath,
          this.context.globalStorageUri.fsPath,
        ]);
        if (!allowed) return false;
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(allowed), { preview: true });
          return true;
        } catch (error) {
          this.log('warn', 'settings.openFile.failed', errorMessage(error));
          return false;
        }
      },
      createSkill: async () => {
        const name = await vscode.window.showInputBox({
          prompt: 'Name for the new skill',
          placeHolder: 'release-checklist',
          validateInput: value => (value.trim() ? undefined : 'Enter a name'),
        });
        if (!name) return { ok: false, text: 'No name given, so no skill was created.' };
        const folder = sanitizeSkillName(name);
        if (!folder) return { ok: false, text: 'That name has no usable characters.' };
        const file = vscode.Uri.joinPath(this.skillsRoot(), folder, 'SKILL.md');
        try {
          // Never overwrite: the folder name is user-supplied, so refusing is the
          // difference between adding a skill and destroying one.
          await vscode.workspace.fs.stat(file);
          return { ok: false, text: `A skill named “${folder}” already exists.` };
        } catch {
          // Does not exist — the expected path.
        }
        try {
          await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(settingsAdapter.skillScaffold(name)));
          await vscode.window.showTextDocument(file, { preview: false });
          this.log('info', 'skill.created', folder);
          return { ok: true, text: `Created “${folder}”. Edit the description so the agent knows when to use it.` };
        } catch (error) {
          return { ok: false, text: `Could not create the skill: ${errorMessage(error)}` };
        }
      },
      deleteSkill: async (rawPath) => {
        const folder = settingsAdapter.skillFolderFromPath(this.skillsRoot().fsPath, rawPath);
        if (!folder) return { ok: false, text: 'That path is not an installed skill, so nothing was removed.' };
        const choice = await vscode.window.showWarningMessage(`Delete the skill “${folder}”?`, { modal: true }, 'Delete');
        if (choice !== 'Delete') return { ok: false, text: 'Deletion cancelled.' };
        try {
          await uninstallSkill(this.skillsRoot(), folder);
          this.log('info', 'skill.deleted', folder);
          return { ok: true, text: `Deleted “${folder}”.` };
        } catch (error) {
          return { ok: false, text: `Could not delete the skill: ${errorMessage(error)}` };
        }
      },
      version: () => String(this.context.extension.packageJSON.version ?? ''),
      readProviders: async () => {
        const rows = providersCore.providerRows({
          providers: this.getProviders(),
          keys: this.apiKeys,
          activeId: this.context.globalState.get<string>('sleepycode.activeProvider', ''),
        });
        return rows;
      },
      writeProvider: async (draft) => {
        const input = (draft ?? {}) as providersCore.ProviderDraft;
        const error = providersCore.validateProviderDraft(input);
        if (error) throw new Error(error);
        const providers = this.getProviders();
        const built = providersCore.providerFromDraft(input);
        const existing = providers.find(provider => provider.id === built.id);
        // The canonical provider keeps its identity and its base URL: the product
        // is built around it, so an edit must not be able to repoint it.
        const next = existing
          ? providers.map(provider => (provider.id === built.id
            ? { ...provider, name: built.isSleepy ? provider.name : built.name, baseURL: provider.isSleepy ? provider.baseURL : built.baseURL, ...(built.modelList ? { modelList: built.modelList } : {}) }
            : provider))
          : [...providers, built];
        await this.context.globalState.update('sleepycode.providers', next);
        this.log('info', 'provider.saved', built.id);
        await this.refreshModels();
      },
      removeProvider: async (id) => {
        const providers = this.getProviders();
        const target = providers.find(provider => provider.id === id);
        if (!target || target.isSleepy) return;
        await this.context.globalState.update('sleepycode.providers', providers.filter(provider => provider.id !== id));
        await this.context.secrets.delete(`sleepycode.apiKey.${id}`).then(undefined, () => undefined);
        delete this.apiKeys[id];
        this.log('info', 'provider.removed', id);
        await this.refreshModels();
      },
      setProviderKey: async (id, key) => {
        const provider = this.getProviders().find(entry => entry.id === id);
        if (!provider) return;
        const trimmed = typeof key === 'string' ? key.trim() : '';
        if (trimmed) {
          await this.context.secrets.store(`sleepycode.apiKey.${id}`, trimmed);
          this.apiKeys[id] = trimmed;
        } else {
          await this.context.secrets.delete(`sleepycode.apiKey.${id}`);
          delete this.apiKeys[id];
        }
        this.log('info', 'provider.key', `${id}: ${trimmed ? 'set' : 'cleared'}`);
        await this.refreshModels();
      },
      readLogs: async () => this.context.globalState.get<unknown[]>(AgentViewProvider.LOG_KEY, []),
      clearLogs: async () => {
        await this.context.globalState.update(AgentViewProvider.LOG_KEY, []);
      },
      resetAll: async () => {
        // Reuse the handler the classic webview's reset posted, so there is one
        // definition of what "default" means.
        await this.onMessage({ type: 'resetSettings' } as WebMessage);
      },
      completeSetup: async () => {
        await this.context.globalState.update('sleepycode.setupComplete', true);
      },
      resetUsage: async () => {
        await this.context.globalState.update('sleepycode.usage', []);
        this.log('info', 'usage.reset', 'local usage cleared');
      },
      readFeatures: async () => featurePrefs.featuresFromHost({
        prefs: this.readChatPrefs(),
        settings: {
          systemNotifications: vscode.workspace.getConfiguration('sleepycode').get<boolean>('systemNotifications', true),
          maxSteps: this.config().maxSteps,
          repoIndex: vscode.workspace.getConfiguration('sleepycode').get<boolean>('repoIndex', true),
        },
      }),
      setApprovalMode: async (mode) => {
        // The window's policy is already projected onto SleepyCode's single mode
        // by `approvalModeFromPolicy`; normalising here keeps a bad value from
        // being stored as-is.
        await this.context.globalState.update('sleepycode.approvalMode', normalizeApprovalMode(mode));
        this.postConfig();
      },
      readSettings: () => ({
        model: this.config().model,
        maxSteps: this.config().maxSteps,
        systemPrompt: this.config().systemPrompt,
        repoIndex: vscode.workspace.getConfiguration('sleepycode').get<boolean>('repoIndex', true),
      }),
      writeSettings: async (patch) => {
        const config = vscode.workspace.getConfiguration('sleepycode');
        if (patch.model !== undefined) await config.update('model', patch.model, vscode.ConfigurationTarget.Global);
        if (patch.maxSteps !== undefined) await config.update('maxSteps', patch.maxSteps, vscode.ConfigurationTarget.Global);
        if (patch.systemPrompt !== undefined) await config.update('systemPrompt', patch.systemPrompt, vscode.ConfigurationTarget.Global);
        if (patch.repoIndex !== undefined) await config.update('repoIndex', patch.repoIndex, vscode.ConfigurationTarget.Global);
        if (patch.systemNotifications !== undefined) await config.update('systemNotifications', patch.systemNotifications, vscode.ConfigurationTarget.Global);
        this.log('info', 'settings.write', JSON.stringify(patch));
        this.postConfig();
      },
      readConnections: async () => (await loadMcpConnections(this.context)).map(settingsAdapter.toMcpPanelConfig),
      writeConnections: async (connections) => {
        const previous = await loadMcpConnections(this.context);
        const keep = new Set(connections.map((connection) => connection.name));
        for (const connection of previous) {
          if (!keep.has(connection.name)) await deleteMcpConnection(this.context, connection.name);
        }
        for (let index = 0; index < connections.length; index++) {
          await saveMcpConnection(this.context, settingsAdapter.fromMcpPanelConfig(connections[index]!, index) as McpConnectionData);
        }
        this.log('info', 'mcp.connections.write', `${connections.length}: ${connections.map((c) => `${c.name}(${c.transport})`).join(', ') || 'none'}`);
        for (const connection of connections) {
          if (connection.transport === 'stdio') continue;
          const problem = settingsAdapter.validatePanelMcpUrl(connection.url);
          if (problem) this.log('warn', 'mcp.url.rejected', `${connection.name}: ${connection.url ?? '(none)'} -> ${problem}`);
        }
        const persisted = await loadMcpConnections(this.context);
        this.log('info', 'mcp.connections.persisted', `${persisted.length}: ${persisted.map((c) => c.name).join(', ') || 'none'}`);
        if (persisted.length !== connections.length) {
          this.log('error', 'mcp.connections.lost', `wrote ${connections.length}, read back ${persisted.length}`);
        }
        // The stored set changed, so any cached connection is stale.
        this.mcpCache = undefined;
      },
      syncConnections: async () => {
        const connections = await loadMcpConnections(this.context);
        this.log('info', 'mcp.sync.start', `${connections.length} saved: ${connections.map((c) => `${c.name}(${c.transport ?? 'http'}${c.enabled === false ? ',off' : ''})`).join(', ') || 'none'}`);
        // Spawned servers inherit this PATH. Recording it makes "command not
        // found" diagnosable without asking the user to reproduce it.
        const resolvedPath = await loginShellEnv();
        this.log('info', 'mcp.sync.path', (resolvedPath.PATH ?? '').split(':').slice(0, 8).join(':'));
        let statuses: McpConnectionStatus[] = [];
        try {
          const result = await connectToMcpConnections(connections, this.context, (title, detail) => this.approve('command', title, detail), this.workspaceRoot()?.fsPath);
          await result.connection.close();
          statuses = result.statuses;
          if (result.connection.errors.length) this.log('warn', 'mcp.sync.errors', result.connection.errors.join(' | '));
        } catch (error) {
          // A thrown sync used to vanish into a single status named "MCP",
          // which matched no server and left every row reading "idle".
          const detail = errorMessage(error);
          this.log('error', 'mcp.sync.failed', detail);
          statuses = [];
        }
        // One row per saved server, always: never leave the panel guessing.
        return settingsAdapter.completeMcpStatuses(connections, statuses);
      },
      mcpLogin: async (name) => {
        const connection = (await loadMcpConnections(this.context)).find((item) => item.name === name);
        if (!connection) throw new Error(`MCP connection "${name}" was not found.`);
        this.log('info', 'mcp.oauth.login.start', `${name} ${connection.url ?? ''}`);
        // The ported provider runs the whole flow (PKCE, dynamic client
        // registration, loopback callback) and stores tokens in secret storage,
        // so the next connect attaches the bearer token itself. The old path
        // required a hand-configured oauth2Config that a server added in the
        // settings window never has, which is why OAuth could not work.
        await mcpOAuthLogin(
          { name: connection.name, url: connection.url, transport: connection.transport, oauth: connection.oauth },
          this.workspaceRoot()?.fsPath ?? '',
          mcpHost(this.context),
        );
        this.log('info', 'mcp.oauth.login.done', name);
        this.mcpCache = undefined;
      },
      mcpLogout: async (name) => {
        const connection = (await loadMcpConnections(this.context)).find((item) => item.name === name);
        if (connection?.url) {
          // Clear the tokens the ported provider actually wrote.
          await new McpOAuthProvider(connection.url, name, mcpHost(this.context).secrets, () => Promise.resolve(undefined))
            .invalidateCredentials('all')
            .catch(() => undefined);
        }
        await this.context.secrets.delete(`sleepycode.mcpOAuth.tokens.${name}`);
        this.log('info', 'mcp.oauth.logout', name);
        this.mcpCache = undefined;
      },
      log: (level, event, detail) => this.log(level, `panel.${event}`, detail),
      skills: async () => {
        const root = this.workspaceRoot();
        if (!root) return [];
        return listInstalledSkills(this.skillsRoot());
      },
      marketplaceSearch: (query, sortBy) => this.searchMarketplace(query, sortBy),
      marketplaceInstalled: () => this.installedSkillList(),
      marketplaceInstall: (source, skill) => this.installMarketplaceSkill(source, skill),
      marketplaceUninstall: (folder) => this.uninstallMarketplaceSkill(folder),
      memory: () => {
        const root = this.workspaceRoot();
        if (!root) return { memoryPath: MEMORY_RELATIVE_PATH, memoryExists: false };
        return { memoryPath: MEMORY_RELATIVE_PATH, memoryExists: existsSync(path.join(root.fsPath, MEMORY_RELATIVE_PATH)) };
      },
      usage: () => aggregateUsage(loadUsage(this.context)),
      refreshModels: async () => {
        await this.refreshModels();
        return this.lastModelGroups.flatMap((group) => group.models.map((model) => (typeof model === 'string' ? model : model.id)));
      },
    };
  }

  /**
   * Fold React's composer attachments into a SleepyCode `ComposerContext`.
   * Images are materialised to temp files (the run reads them from disk); file
   * attachments pass their workspace path straight through.
   */
  private async withReactAttachments(message: Extract<WebMessage, { type: 'send' }>): Promise<ComposerContext | undefined> {
    const raw = (message as { attachments?: unknown }).attachments;
    const split = adapter.reactAttachmentsOf(raw);
    if (!split.images.length && !split.files.length) return message.context;
    const images = await Promise.all(split.images.map(image => this.materializeImage(image)));
    const attachments: Attachment[] = [
      ...images.filter((image): image is Extract<Attachment, { kind: 'image' }> => Boolean(image)),
      ...split.files.map(file => ({ kind: 'file' as const, path: file.path })),
    ];
    return { ...(message.context ?? {}), attachments };
  }

  /** Write a data-URL image to a temp file the provider can read. */
  private async materializeImage(image: { name: string; mimeType: string; dataUrl: string }): Promise<Attachment | undefined> {
    const match = image.dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (!match?.[1]) return undefined;
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.byteLength > 10_000_000) {
      void vscode.window.showWarningMessage(`Skipped ${image.name}: images must be under 10 MB.`);
      return undefined;
    }
    try {
      const folder = await mkdtemp(path.join(tmpdir(), 'sleepycode-image-'));
      const extension = image.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      const filePath = path.join(folder, `pasted.${extension}`);
      await writeFile(filePath, bytes);
      return { kind: 'image', name: image.name, size: bytes.byteLength, mimeType: image.mimeType, tempPath: filePath, previewDataUrl: image.dataUrl };
    } catch {
      return undefined;
    }
  }

  /**
   * React's change-review actions name only a path. SleepyCode resolves an edit
   * through the conversation and the assistant turn that made it, so the action
   * is rewritten here using the tracked target before reaching `onMessage`.
   */
  private handleReactChangeAction(message: any): boolean {
    if (message?.type === 'acceptAllChanges' || message?.type === 'rejectAllChanges') {
      const conversationId = this.activeProject()?.activeConversationId;
      const itemId = conversationId ? this.reactChangeTarget.get(conversationId) : undefined;
      const messages = adapter.bulkChangeMessages(
        message.type,
        conversationId,
        itemId,
        conversationId ? this.reactPendingPaths.get(conversationId) : undefined,
      );
      this.log('info', `react.changes.${message.type}`, `${messages.length} action(s)`);
      for (const translated of messages) void this.onMessage(translated as WebMessage);
      return true;
    }
    const conversationId = this.activeProject()?.activeConversationId;
    const itemId = conversationId ? this.reactChangeTarget.get(conversationId) : undefined;
    if (!conversationId || !itemId || typeof message?.path !== 'string') return false;
    if (message.type === 'diffChange') {
      void this.onMessage({ type: 'gitReviewFile', conversationId, itemId, path: message.path } as WebMessage);
      return true;
    }
    if (message.type === 'acceptChange') {
      void this.onMessage({ type: 'gitStageChanges', conversationId, itemId, paths: [message.path] } as WebMessage);
      return true;
    }
    if (message.type === 'rejectChange') {
      void this.onMessage({ type: 'gitRevertFile', conversationId, itemId, path: message.path } as WebMessage);
      return true;
    }
    // Commit / Source Control / Restore, from the review bar. Handled here for the
    // same reason Keep All is: the turn is resolved host-side, so the webview does
    // not have to know it — and posting host names from the webview was dropped by
    // the adapter, which made all three do nothing.
    if (message.type === 'commitChanges') {
      void this.onMessage({ type: 'gitCommit', conversationId, itemId } as WebMessage);
      return true;
    }
    if (message.type === 'openSourceControl') {
      void this.onMessage({ type: 'reviewChanges', conversationId, itemId } as WebMessage);
      return true;
    }
    if (message.type === 'stageAllChanges') {
      const paths = Array.isArray(message.paths) ? message.paths.filter((path: unknown) => typeof path === 'string') : [];
      if (!paths.length) return true;
      void this.onMessage({ type: 'gitStageChanges', conversationId, itemId, paths } as WebMessage);
      return true;
    }
    return false;
  }

  /**
   * The React composer picks an approval preset; SleepyCode stores an approval
   * mode. Persisting it here keeps the choice across reloads and conversations.
   */
  private async applyApprovalPreset(preset: unknown): Promise<void> {
    const mode = adapter.approvalModeForPreset(preset);
    if (!mode) return;
    await this.context.globalState.update('sleepycode.approvalMode', mode);
    this.postConfig();
  }

  /** Start the SleepyAI browser sign-in, used by the command and the React nudge. */
  public signIn(): void {
    void this.onMessage({ type: 'sleepyLogin' } as WebMessage);
  }

  public toggleReactWebview(): void {
    const cur = this.context.globalState.get<boolean>('useReactWebview', true);
    void this.context.globalState.update('useReactWebview', !cur).then(() => {
      void vscode.window.showInformationMessage(`React UI ${!cur ? 'enabled' : 'disabled'}. Reload the window to apply.`);
    });
  }

  private apiKeysLoaded?: Promise<void>;

  private log(level: ExtensionLogEntry['level'], event: string, detail?: string): void {
    const entries = this.context.globalState.get<ExtensionLogEntry[]>(AgentViewProvider.LOG_KEY, []);
    entries.push({ timestamp: Date.now(), level, event, detail });
    void this.context.globalState.update(AgentViewProvider.LOG_KEY, entries.slice(-AgentViewProvider.LOG_LIMIT));
    // The React settings window has no log view, so the log is also written to
    // the standard Output panel where View -> Output -> SleepyCode reaches it.
    // Without this, a failed MCP connection had no readable trace anywhere.
    this.outputChannel().appendLine(
      `[${new Date().toISOString()}] ${level.toUpperCase()} ${event}${detail ? `: ${detail}` : ''}`,
    );
  }

  private output?: vscode.OutputChannel;

  private outputChannel(): vscode.OutputChannel {
    if (!this.output) this.output = vscode.window.createOutputChannel('SleepyCode');
    return this.output;
  }

  /** Reveal the extension log. Also registered as a command. */
  public showLogs(): void {
    this.outputChannel().show(true);
  }

  /**
   * One compact line per finished turn, so a slow memory climb can be attributed from the log
   * instead of guessed at. This measures the extension host only; the webview has its own process.
   * The per-retainer numbers are the point: heap alone says "big", not "big because of what".
   */
  private reportMemory(): void {
    const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
    let conversations = 0;
    let items = 0;
    let snapshotChars = 0;
    for (const project of this.projects) {
      conversations += project.conversations.length;
      for (const conversation of project.conversations) {
        items += conversation.items.length;
        for (const item of conversation.items) {
          for (const snapshot of item.fileSnapshot ?? []) snapshotChars += snapshot.content.length;
        }
      }
    }
    const memory = process.memoryUsage();
    const indexed = this.repoIndexCache ? this.repoIndexCache.index.files.length : 0;
    this.log('info', 'perf.memory',
      `heap ${mb(memory.heapUsed)}MB rss ${mb(memory.rss)}MB · ${this.projects.length} projects · ` +
      `${conversations} conversations · ${items} items · snapshots ${mb(snapshotChars)}MB · index ${indexed} files`);
  }

  private sendExtensionLogs(): void {
    const entries = this.context.globalState.get<ExtensionLogEntry[]>(AgentViewProvider.LOG_KEY, []);
    this.post({ type: 'extensionLogs', logs: entries.map(entry => '[' + new Date(entry.timestamp).toISOString() + '] ' + entry.level.toUpperCase() + ' ' + entry.event + (entry.detail ? ': ' + entry.detail : '')) });
  }
  private loadApiKeys(): Promise<void> {
    this.apiKeysLoaded ??= this.loadApiKeysOnce();
    return this.apiKeysLoaded;
  }

  private async loadApiKeysOnce(): Promise<void> {
    const keys: Record<string, string> = {};
    for (const provider of this.getProviders()) {
      try {
        keys[provider.id] = (await this.context.secrets.get(`sleepycode.apiKey.${provider.id}`)) ?? '';
      } catch {
        keys[provider.id] = '';
      }
    }
    this.apiKeys = keys;
    try {
      await this.context.secrets.delete('sleepycode.apiKey');
      await this.context.secrets.delete('sleepycode.apiKey.opencode');
      this.apiKeys.opencode = '';
    } catch { }
  }

  async openSettings(): Promise<void> { return this.showSettings(); }

  openPanel(panel: 'worktrees' | 'index' | 'agents' | 'tasks' | 'checkpoints'): void {
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showInformationMessage('Open a folder or workspace first.');
      return;
    }
    this.view?.show?.(true);
    this.post({ type: 'showPanel', panel });
    void this.sendPanel(panel);
  }

  private async sendPanel(panel: 'worktrees' | 'index' | 'agents' | 'tasks' | 'checkpoints'): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    // `id` is what a row's button acts on. Panels whose rows are informational
    // leave it off, and the drawer then renders no button.
    const rows: { id?: string; title: string; detail?: string }[] = [];
    let hint = '';
    try {
      if (panel === 'worktrees') {
        if (!isGitTrackedWorkspace(root.fsPath)) hint = 'This workspace is not a Git repository. Worktrees require Git.';
        else for (const tree of await listWorktrees(root.fsPath)) rows.push({ id: tree.name, title: tree.name, detail: `${tree.branch} · ${tree.commit.slice(0, 8)}${tree.isMain ? ' · main' : ''}` });
      } else if (panel === 'index') {
        const index = await this.loadRepoIndex(root);
        const symbols = index.indexSymbols();
        rows.push({ title: `${index.files.length} files indexed`, detail: `${symbols.length} symbols` });
        for (const edge of index.architectureMap().edges.slice(0, 60)) rows.push({ title: edge.from, detail: `imports ${edge.to}` });
        hint = 'Ask the agent to use repo_search or repo_symbol for symbol and semantic search.';
      } else if (panel === 'tasks') {
        const hooks = this.hookRules();
        if (!hooks.length) hint = 'No hook rules configured. Hook rules live in extension state and can allow, block, or require approval for tool calls.';
        for (const rule of hooks) rows.push({ id: rule.name, title: `${rule.name} (${rule.event})`, detail: `action: ${rule.action}${rule.matcher?.tool ? ` · tool ${rule.matcher.tool}` : ''}${rule.matcher?.pathGlob ? ` · ${rule.matcher.pathGlob}` : ''}` });
      } else if (panel === 'agents') {
        const builtIns = new Set(AGENT_DEFINITIONS.map(agent => agent.id));
        for (const agent of this.allAgents()) {
          const detail = [agent.id, agent.model || 'default model', builtIns.has(agent.id) ? 'built-in' : 'custom'].join(' · ');
          rows.push({ id: agent.id, title: agent.name, detail });
        }
        hint = 'Select an agent from the composer pill, or type @agent-id at the start of a message to route it.';
      } else if (panel === 'checkpoints') {
        const project = this.activeProject();
        const conversation = project?.conversations.find(item => item.id === project.activeConversationId);
        const withSnapshots = (conversation?.items ?? []).filter(item => item.fileSnapshot?.length || item.gitTree);
        if (!withSnapshots.length) hint = 'No restorable snapshots yet. Each assistant turn records one so undo works outside Git.';
        for (const item of withSnapshots.slice(-40)) rows.push({ id: item.id, title: item.text.slice(0, 80) || '(no text)', detail: `${item.fileSnapshot?.length ?? 0} files snapshot${item.gitTree ? ' · git checkpoint' : ''}` });
      }
    } catch (error) {
      hint = errorMessage(error);
    }
    this.post({ type: 'panel', panel, rows, hint });
  }

  private async restoreFileSnapshots(rootPath: string, snapshots: FileSnapshot[]): Promise<void> {
    const failures: string[] = [];
    for (const snap of snapshots) {
      const uri = vscode.Uri.file(path.join(rootPath, snap.path));
      try {
        if (snap.existed) {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(snap.content));
        } else {
          try { await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false }); } catch (error) {
            if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error;
          }
        }
      } catch (error) {
        failures.push(`${snap.path}: ${errorMessage(error)}`);
      }
    }
    if (failures.length) throw new Error(`Could not restore ${failures.length} file${failures.length === 1 ? '' : 's'}:\n${failures.join('\n')}`);
  }

  openUsage(): void {
    this.view?.show?.(true);
    this.post({ type: 'showUsage' });
    this.sendUsage();
    void this.sendSleepyAccountData(true);
  }

  async openMemory(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showInformationMessage('Open a folder or workspace first.');
      return;
    }
    await openProjectMemory(root);
  }

  private sendUsage(): void {
    this.post({ type: 'usage', ...aggregateUsage(loadUsage(this.context)) });
  }

  private async sendSleepyAccountData(force = false): Promise<void> {
    const account = getSleepyAccount();
    if (!account.loggedIn) {
      this.post({ type: 'sleepyStatus', loggedIn: false, busy: false, text: '' });
      return;
    }
    if (!force && Date.now() - this.lastSleepyAccountRefresh < 30_000) return;
    this.lastSleepyAccountRefresh = Date.now();
    const token = await getSleepyToken();
    if (!token) {
      this.post({ type: 'sleepyStatus', loggedIn: false, busy: false, text: '' });
      return;
    }
    try {
      const data = await fetchSleepyAccountData(token);
      this.lastSleepyModelPrices = data.modelPrices ?? [];
      this.lastSleepyPriceRefresh = Date.now();
      this.post({ type: 'sleepyStatus', ...account, ...data, busy: false, text: '' });
    } catch {
      this.post({ type: 'sleepyStatus', ...account, busy: false, text: 'Could not refresh account usage.' });
    }
  }

  openMarketplace(): void {
    this.view?.show?.(true);
    this.post({ type: 'showMarketplace' });
    this.sendMarketplaceInstalled();
  }

  private skillsRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'skills');
  }

  /**
   * Where oversized tool output is archived. Lives in global storage (not the
   * workspace) so recalling an observation never writes into the user's repo.
   */
  private observationsRoot(): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'observations').fsPath;
  }

  private async loadRepoIndex(root: vscode.Uri): Promise<RepoIndex> {
    if (this.repoIndexCache?.root === root.fsPath) {
      if (!this.repoIndexCache.symboled) {
        this.repoIndexCache.index.indexSymbols();
        this.repoIndexCache.symboled = true;
      }
      return this.repoIndexCache.index;
    }
    const index = new RepoIndex(await scanWorkspace(root.fsPath));
    index.indexSymbols();
    this.repoIndexCache = { root: root.fsPath, index, symboled: true };
    return index;
  }

  private loadRepoMemory(root: vscode.Uri): SourceCitedMemory {
    const memory = new SourceCitedMemory();
    const json = loadMemoryJson(root.fsPath);
    if (json) memory.load(json);
    return memory;
  }

  private globalSkillsReady?: Promise<void>;
  private ensureGlobalSkills(): Promise<void> {
    // Run in the background — never block a chat run waiting for skill migration.
    if (!this.globalSkillsReady) {
      this.globalSkillsReady = this.ensureGlobalSkillsOnce();
      this.globalSkillsReady.catch(() => { /* already swallowed inside */ });
    }
    // Return an immediately-resolved promise so the caller doesn't await migration.
    return Promise.resolve();
  }

  private async ensureGlobalSkillsOnce(): Promise<void> {
    try {
      if (this.context.globalState.get<boolean>('sleepycode.skillsMigrated', false)) return;
      const root = this.workspaceRoot();
      if (!root) { this.markSkillsMigrated(); return; }
      const legacy = vscode.Uri.joinPath(root, ...SKILLS_SUBDIR.split('/'));
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(legacy);
      } catch {
        this.markSkillsMigrated();
        return;
      }
      const skillFolders = entries.filter(([, type]) => (type & vscode.FileType.Directory) !== 0);
      if (!skillFolders.length) { this.markSkillsMigrated(); return; }
      // Mark migrated before copying so a slow/interrupted copy never re-runs.
      this.markSkillsMigrated();
      const target = this.skillsRoot();
      let existing: [string, vscode.FileType][] = [];
      try { existing = await vscode.workspace.fs.readDirectory(target); } catch { }
      const present = new Set(existing.map(([name]) => name));
      for (const [name] of skillFolders) {
        if (present.has(name)) continue;
        await this.copyFolder(vscode.Uri.joinPath(legacy, name), vscode.Uri.joinPath(target, name));
      }
      this.markSkillsMigrated();
    } catch { }
  }

  private markSkillsMigrated(): void {
    void this.context.globalState.update('sleepycode.skillsMigrated', true);
  }

  private async copyFolder(source: vscode.Uri, target: vscode.Uri): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(source);
    await vscode.workspace.fs.createDirectory(target);
    for (const [name, type] of entries) {
      const from = vscode.Uri.joinPath(source, name);
      const to = vscode.Uri.joinPath(target, name);
      if ((type & vscode.FileType.Directory) !== 0) await this.copyFolder(from, to);
      else await vscode.workspace.fs.writeFile(to, await vscode.workspace.fs.readFile(from));
    }
  }

  private async sendMarketplaceInstalled(): Promise<void> {
    await this.ensureGlobalSkills();
    const sources = this.context.globalState.get<Record<string, string>>('sleepycode.skillSources', {}) ?? {};
    const skills = (await listInstalledSkills(this.skillsRoot())).map(skill => ({ ...skill, source: sources[skill.folder] ?? '' }));
    this.post({ type: 'marketplaceInstalled', skills });
  }

  private async sendMcpConnections(): Promise<void> {
    this.post({ type: 'mcpConnections', connections: await loadMcpConnections(this.context) });
  }

  /** Receives `vscode://<publisher>.<extension>/mcp/oauth/callback` after an MCP OAuth authorization. */
  async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path.replace(/\/+$/, '').endsWith('/mcp/oauth/callback')) {
      try {
        const name = await finishMcpOAuth(uri, this.context);
        this.closeMcpCache();
        this.post({ type: 'toast', id: Date.now(), title: 'MCP authorized', message: `Authorization completed for ${name}.`, kind: 'info' });
        void vscode.window.showInformationMessage(`SleepyCode: MCP connection "${name}" is authorized.`);
        await this.sendMcpConnections();
      } catch (error) {
        this.post({ type: 'toast', id: Date.now(), title: 'MCP authorization failed', message: errorMessage(error), kind: 'attention' });
        void vscode.window.showErrorMessage(`SleepyCode: MCP authorization failed — ${errorMessage(error)}`);
      }
      return;
    }
    void vscode.window.showInformationMessage(`SleepyCode received an unrecognized URI: ${uri.toString()}`);
  }

  private async showSettings(initialSetup = false, section?: string): Promise<void> {
    // In React mode the settings window is the real surface: it is
    // the only structured editor for MCP servers. The classic webview keeps its
    // own settings view for the fallback path.
    if (this.reactMode) {
      // The section is forwarded, not resolved here: the window owns which
      // sections exist, so a hidden or unknown id falls back there and can say
      // so on screen.
      //
      // First run used to skip this branch and post the CLASSIC settings payload,
      // which the React view has no handler for — so a new user's setup screen
      // rendered nothing at all. The window shows its own first-run step now.
      SettingsPanel.show(this.context, this.settingsPanelHost(), section, initialSetup);
      return;
    }
    const config = this.config();
    const providers = this.getProviders();
    const sleepyAccount = getSleepyAccount();
    // Post settings immediately without waiting for server data
    this.post({
      type: 'settings',
      maxSteps: config.maxSteps,
      approvalMode: config.approvalMode,
      searxngUrl: config.searxngUrl,
      mcpServers: config.mcpServers,
      extraFreeModels: config.extraFreeModels.join(', '),
      activeProvider: config.activeProvider,
      providers,
      mcpConnections: await loadMcpConnections(this.context),
      apiKeys: Object.fromEntries(providers.map(provider => [provider.id, Boolean(this.apiKeys[provider.id])])),
      sleepy: sleepyAccount,
      onlyDefaultModels: this.config().onlyDefaultModels,
      confirmDelete: this.confirmDeleteConversations(),
      compactionModel: config.compactionModel,
      compact: this.context.globalState.get<boolean>('sleepycode.compact', false),
      maxPersistedReasoning: config.maxPersistedReasoning,
      useCli: config.useCli,
      initialSetup,
      agentId: this.context.globalState.get<string>('sleepycode.agentId', 'default'),
      subagentModels: this.subagentModels(),
    });
    // Lazily fetch account data and push an update
    if (sleepyAccount.loggedIn) {
      const token = await getSleepyToken();
      if (token) {
        try {
          const accountData = await fetchSleepyAccountData(token);
          Object.assign(sleepyAccount, accountData);
          this.post({ type: 'sleepyStatus', ...sleepyAccount, busy: false, text: '' });
        } catch {
          // ignore fetch errors
        }
      }
    }
  }

  private async maybeShowFirstLaunchSettings(): Promise<void> {
    if (this.context.globalState.get<boolean>('sleepycode.setupComplete', false)) return;
    await this.showSettings(true);
  }

  clear(): void {
    this.newConversation();
  }

  /**
   * Forward a contributed keyboard shortcut to the webview, which owns the composer and transcript.
   *
   * Routing through the extension host rather than reading the keys straight off the DOM is
   * deliberate. VS Code owns several of these chords — `Ctrl/Cmd+K` is a prefix for its own chord
   * commands — and would swallow them before the webview ever saw a keydown. Contributing them as
   * keybindings is what gives the webview the key at all.
   */
  shortcut(action: 'stop' | 'clearComposer' | 'newLine' | 'copyLast' | 'shortcuts'): void {
    this.post({ type: 'shortcut', action });
  }

  dispose(): void {
    this.terminals.dispose();
    this.browserPreview.dispose();
    this.stopBrowserPreviewPolling();
    this.disposePendingNotifies();
    if (this.projectIndexTimer) clearTimeout(this.projectIndexTimer);
    for (const folder of this.reviewTempDirs) void rm(folder, { recursive: true, force: true });
    this.reviewTempDirs.clear();
  }

  private loadProjects(): void {
    const stored = this.context.globalState.get<unknown[]>('sleepycode.projectIndex', []);
    const indexEntries = Array.isArray(stored) ? stored : [];
    // Entries that do not validate are remembered, not discarded: loadProjects ends by
    // writing the index back, and a filtered rewrite would delete their history for good.
    const split = splitProjectIndex(indexEntries, isProjectMeta);
    this.unreadableProjectEntries = split.unreadable;
    this.projects = split.usable.map(entry => {
      const data = this.context.globalState.get<{ conversations?: unknown; activeConversationId?: unknown } | undefined>(`sleepycode.project.${entry.id}`, undefined);
      const conversations = Array.isArray(data?.conversations) ? data.conversations as Conversation[] : [];
      return {
        id: entry.id,
        name: entry.name,
        path: entry.path,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
        activeConversationId: typeof data?.activeConversationId === 'string' ? data.activeConversationId : '',
        conversations: conversations.map(conversation => {
          const baseTimestamp = Number.isFinite(conversation.createdAt) ? conversation.createdAt : Date.now();
          // A single corrupt record must not abort the load: an earlier unguarded
          // `items.map` threw here, which left the panel rendering an empty chat with
          // no error at all. Degrade that one conversation and keep the rest.
          const items = loadEach(
            Array.isArray(conversation.items) ? conversation.items : [],
            (item, index) => normalizeTranscriptItem(item, baseTimestamp + index),
            () => createTranscriptItem('assistant', INTERRUPTED_TURN_TEXT, 'error'),
            error => this.log('warn', 'conversation.load.corrupt', errorMessage(error)),
          ) as TranscriptItem[];
          // A run interrupted by a reload/crash left a partial turn behind. Fold it
          // into the structured history so the next message keeps that work, then
          // mark the turn as interrupted so the user knows it did not finish.
          const pending = conversation.pending;
          conversation.messages = recoverPendingHistory(conversation.messages, pending, MAX_STORED_MESSAGES);
          if (pending) {
            const last = items[items.length - 1];
            const alreadyShown = last?.role === 'assistant' && (last.kind === 'error' || last.paused);
            const extras = interruptedFieldsFromPending(pending);
            if (!alreadyShown) {
              const interrupted = createTranscriptItem('assistant', INTERRUPTED_TURN_TEXT, 'error', extras.gitTree);
              interrupted.partialText = extras.partialText ?? (typeof last?.partialText === 'string' ? last.partialText : undefined);
              if (extras.work) interrupted.work = extras.work as WorkItem[];
              if (extras.changes) interrupted.changes = extras.changes as FileChange[];
              if (extras.fileSnapshot) interrupted.fileSnapshot = extras.fileSnapshot as FileSnapshot[];
              items.push(interrupted);
            } else {
              last.partialText ??= extras.partialText as string | undefined;
              last.work ??= extras.work as WorkItem[] | undefined;
              last.changes ??= extras.changes as FileChange[] | undefined;
              last.fileSnapshot ??= extras.fileSnapshot as FileSnapshot[] | undefined;
              last.gitTree ??= extras.gitTree;
            }
            conversation.pending = undefined;
          }
          if (!Array.isArray(conversation.turnUndo)) conversation.turnUndo = [];
          if (!Array.isArray(conversation.turnRedo)) conversation.turnRedo = [];
          return { ...conversation, items };
        }),
      };
    });
    const seenIds = new Set<string>();
    this.projects = this.projects.filter(project => seenIds.has(project.id) ? false : (seenIds.add(project.id), true));
    // Rehydrate durable compaction snapshots so undo survives an extension reload.
    for (const project of this.projects) {
      for (const conversation of project.conversations) {
        const stored = this.context.globalState.get<unknown>(`sleepycode.compactionSnapshots.${conversation.id}`, undefined);
        let stacks: ReturnType<typeof loadCompactionStacks<SessionCompactionSnapshot<TranscriptItem, ModelMessage> & { before?: TranscriptItem[]; after?: TranscriptItem[] }>>;
        try {
          stacks = loadCompactionStacks<SessionCompactionSnapshot<TranscriptItem, ModelMessage> & { before?: TranscriptItem[]; after?: TranscriptItem[] }>(stored);
        } catch (error) {
          this.log('warn', 'compactionSnapshot.load.corrupt', errorMessage(error));
          continue;
        }
        const normalize = (snapshot: SessionCompactionSnapshot<TranscriptItem, ModelMessage> & { before?: TranscriptItem[]; after?: TranscriptItem[] }) => ({
          beforeItems: snapshot.beforeItems ?? snapshot.before ?? [],
          afterItems: snapshot.afterItems ?? snapshot.after ?? [],
          beforeMessages: snapshot.beforeMessages ?? [],
          afterMessages: snapshot.afterMessages ?? [],
        });
        if (stacks.undo.length) this.compactionUndoStacks.set(conversation.id, stacks.undo.slice(-3).map(normalize));
        if (stacks.redo.length) this.compactionRedoStacks.set(conversation.id, stacks.redo.slice(-3).map(normalize));
      }
    }
    const root = this.workspaceRoot()?.fsPath;
    if (root) {
      let project = this.projects.find(item => item.path === root);
      if (!project) {
        project = this.createProject(root);
        this.projects.unshift(project);
      }
      this.migrateLegacyWorkspaceState(project);
      this.activeProjectId = project.id;
    } else {
      this.activeProjectId = this.projects[0]?.id ?? '';
    }
    this.sortProjects();
    void this.persistProjects();
  }

  private migrateLegacyWorkspaceState(project: Project): void {
    const legacy = this.context.workspaceState.get<Conversation[]>('sleepycode.conversations', []);
    const legacyTranscript = this.context.workspaceState.get<TranscriptItem[]>('sleepycode.transcript', []);
    if ((!legacy.length && !legacyTranscript.length) || project.conversations.length) return;
    // Legacy records predate current validation and can hold anything. A malformed one
    // must not abort the startup load, so it degrades to an empty transcript.
    const conversations = legacy.length
      ? legacy.map(conversation => {
        const baseTimestamp = Number.isFinite(conversation.createdAt) ? conversation.createdAt : Date.now();
        const items = loadEach(
          Array.isArray(conversation.items) ? conversation.items : [],
          (item, index) => normalizeTranscriptItem(item, baseTimestamp + index),
          () => createTranscriptItem('assistant', INTERRUPTED_TURN_TEXT, 'error'),
          error => this.log('warn', 'legacy.conversation.corrupt', errorMessage(error)),
        ) as TranscriptItem[];
        return { ...conversation, items };
      })
      : [this.createConversation(legacyTranscript.map((item, index) => normalizeTranscriptItem(item, Date.now() + index)))];
    project.conversations = conversations;
    const saved = this.context.workspaceState.get<string>('sleepycode.activeConversationId', '');
    project.activeConversationId = conversations.some(item => item.id === saved && !item.archived) ? saved : (conversations.find(item => !item.archived)?.id ?? '');
    project.updatedAt = Date.now();
    void this.context.workspaceState.update('sleepycode.conversations', undefined);
    void this.context.workspaceState.update('sleepycode.activeConversationId', undefined);
    void this.context.workspaceState.update('sleepycode.transcript', undefined);
  }

  private createProject(rootPath: string): Project {
    const now = Date.now();
    return {
      id: rootPath,
      name: rootPath ? path.basename(rootPath) || rootPath : 'No folder',
      path: rootPath,
      conversations: [],
      activeConversationId: '',
      createdAt: now,
      updatedAt: now,
    };
  }

  private createConversation(items: TranscriptItem[] = [], messages: ModelMessage[] = []): Conversation {
    const now = Date.now();
    const first = items.find(item => item.role === 'user')?.text.trim();
    return { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, title: first ? conversationTitle(first) : 'New conversation', items, messages: messages.slice(), archived: false, createdAt: now, updatedAt: now, turnUndo: [], turnRedo: [] };
  }

  private activeProject(): Project | undefined {
    return this.projects.find(item => item.id === this.activeProjectId);
  }

  private ensureProjectForRoot(): Project | undefined {
    const root = this.workspaceRoot()?.fsPath;
    if (!root) return undefined;
    let project = this.projects.find(item => item.path === root);
    if (!project) {
      project = this.createProject(root);
      this.projects.unshift(project);
    }
    this.activeProjectId = project.id;
    return project;
  }

  private sortProjects(): void {
    const root = this.workspaceRoot()?.fsPath;
    this.projects.sort((a, b) => {
      if (root) {
        if (a.path === root) return -1;
        if (b.path === root) return 1;
      }
      return b.updatedAt - a.updatedAt;
    });
  }

  private activeConversation(): Conversation | undefined {
    const project = this.activeProject();
    if (!project) return undefined;
    let conversation = project.conversations.find(item => item.id === project.activeConversationId);
    if (!conversation) {
      conversation = this.createConversation();
      project.conversations.unshift(conversation);
      project.activeConversationId = conversation.id;
    }
    return conversation;
  }

  private newConversation(): void {
    const project = this.activeProject();
    if (!project) return;
    // "New conversation" is an identity boundary, not "find an empty tab".
    // Always mint a new extension id so it cannot inherit any persisted or
    // in-flight CLI binding, even when another conversation currently looks
    // empty because its first CLI projection has not arrived yet.
    const conversation = this.createConversation();
    project.conversations.unshift(conversation);
    project.activeConversationId = conversation.id;
    project.updatedAt = Date.now();
    void this.persistProjects();
    this.syncConversations();
    // A new CLI conversation starts on a model the CLI actually has, so
    // the composer shows the model that will really run.
    void this.ensureCliSelection(conversation);
  }

  /**
   * Hard safety bound only. History is NOT routinely trimmed; this guard exists
   * solely to keep an unbounded conversation from exhausting memory. When it does
   * trim, the user is told, so loss is never silent.
   */
  private boundConversationItems(conversation: Conversation): void {
    if (conversation.items.length <= MAX_STORED_ITEMS) return;
    // Start the kept window on a user turn. A window that opens on an assistant item renders that
    // answer without the question it answers, so the turn reads as missing rather than trimmed.
    let first = conversation.items.length - MAX_STORED_ITEMS;
    while (first < conversation.items.length && conversation.items[first]?.role !== 'user') first++;
    if (first >= conversation.items.length) first = conversation.items.length - MAX_STORED_ITEMS;
    const dropped = first;
    conversation.items = conversation.items.slice(first);
    this.post({ type: 'contextNotice', conversationId: conversation.id, kind: 'trimmed', text: `Older history was trimmed (${dropped} item${dropped === 1 ? '' : 's'}) to keep this conversation within memory limits.` });
  }

  /**
   * Structured model-visible history for a conversation: the persisted assistant
   * turns (including their tool calls) and tool results, minus any leading
   * messages that are not valid to start a request with.
   *
   * The first message MUST be a user message; a history that starts with a
   * tool-result (e.g. after trimming) would be rejected by strict providers.
   *
   * Selection is token-budgeted and cut only at safe boundaries: a turn's tool
   * results are never separated from the assistant message that requested them,
   * because an orphaned tool-call id makes strict providers reject the request.
   */
  private structuredHistory(conversation: Conversation, contextWindow?: number | null, maxOutputLimit?: number | null): ModelMessage[] {
    // Same budget formula as maybeAutoCompact, including the output reserve. Budgeting the
    // send with a different number than the one compaction is measured against is what let
    // history be cut before compaction ever became due.
    const budgetTokens = structuredHistoryBudget(contextWindow, maxOutputLimit);
    const selected = selectStructuredHistory(conversation.messages, budgetTokens, estimateMessageTokens);
    // The cut is real context loss, so say so. Silently narrowing the window is what
    // makes this read as "the agent forgot" instead of "older turns were dropped".
    const dropped = droppedMessageCount(conversation.messages, selected);
    if (dropped > 0 && this.lastHistoryDropNotice.get(conversation.id) !== dropped) {
      this.lastHistoryDropNotice.set(conversation.id, dropped);
      // Name the number the cut was made against. "400 messages left this request" with no
      // figures is unactionable — it reads as a 1M-window model misbehaving when the real
      // cause was a 60k budget for a model nobody could describe.
      const within = contextWindow && contextWindow > 0
        ? `${Math.round(budgetTokens / 1_000)}k of the model's ${Math.round(contextWindow / 1_000)}k-token window`
        : `the conservative ${Math.round(budgetTokens / 1_000)}k-token budget (no context window is known for this model)`;
      this.post({
        type: 'contextNotice',
        conversationId: conversation.id,
        kind: 'trimmed',
        text: `${dropped} older message${dropped === 1 ? '' : 's'} left this request to stay within ${within}. They are still saved in this conversation.`,
      });
    }
    return backfillAssistantReasoning(selected, reasoningTextsFromItems(conversation.items));
  }

  /**
   * Append this run's structured messages to the conversation, paired with the
   * user turn that produced them. Keeps a hard count bound and always trims from
   * the front so the newest context survives.
   */
  private appendConversationMessages(conversation: Conversation, userText: string, produced: ModelMessage[], reuseUser = false): void {
    conversation.messages = appendConversationMessages(conversation.messages, userText, produced, MAX_STORED_MESSAGES, reuseUser);
  }

  /**
   * Select the transcript items to hand the model as "previous conversation".
   * Walks backwards accumulating a chars/4 token cost until the budget is hit,
   * keeping a minimum of COMPACTION_HISTORY_ITEMS so short conversations always
   * send their whole (small) history instead of a fixed 9-item slice.
   */
  private recentContextItems(conversation: Conversation, budgetTokens: number): TranscriptItem[] {
    const usable = conversation.items.filter(item => item.kind !== 'divider');
    const tail = usable.slice(0, -1); // exclude the current turn
    const picked: TranscriptItem[] = [];
    let cost = 0;
    for (let index = tail.length - 1; index >= 0; index--) {
      const item = tail[index]!;
      const textToCount = item.partialText ? `${item.text}\n${item.partialText}` : item.text;
      const itemCost = Math.ceil((textToCount?.length ?? 0) / CHARS_PER_TOKEN);
      if (picked.length >= COMPACTION_HISTORY_ITEMS && cost + itemCost > budgetTokens) break;
      picked.unshift(item);
      cost += itemCost;
    }
    return picked;
  }

  /**
   * Persist compaction undo snapshots so a compaction can be undone after an
   * extension reload (the in-memory stacks alone are lost on restart).
   */
  private async persistCompactionSnapshots(conversationId: string): Promise<void> {
    if (!conversationId) return;
    const persisted = persistCompactionStacks({
      undo: this.compactionUndoStacks.get(conversationId),
      redo: this.compactionRedoStacks.get(conversationId),
    });
    if (persisted.undo.length || persisted.redo.length) {
      await this.context.globalState.update(`sleepycode.compactionSnapshots.${conversationId}`, persisted);
    } else {
      await this.context.globalState.update(`sleepycode.compactionSnapshots.${conversationId}`, undefined);
    }
  }

  private persistProjects(): Promise<void> {
    const projects = this.projects.slice(0, MAX_PERSISTED_PROJECTS);
    this.persistChain = enqueuePersist(this.persistChain, async () => {
      // Entries that failed validation on load are re-written verbatim rather than
      // dropped: a filtered index rewrite permanently deletes that project's history.
      await this.context.globalState.update('sleepycode.projectIndex', [
        ...projects.map(({ id, name, path, createdAt, updatedAt }) => ({ id, name, path, createdAt, updatedAt })),
        ...this.unreadableProjectEntries,
      ]);
      for (const project of projects) {
        const conversations = project.conversations.slice(0, MAX_PERSISTED_CONVERSATIONS);
        if (conversations.length < project.conversations.length) {
          const dropped = project.conversations.length - conversations.length;
          this.post({ type: 'contextNotice', conversationId: project.activeConversationId, kind: 'trimmed', text: `${dropped} older conversation${dropped === 1 ? '' : 's'} in this project were not saved (limit ${MAX_PERSISTED_CONVERSATIONS}).` });
        }
        await this.context.globalState.update(`sleepycode.project.${project.id}`, {
          conversations,
          activeConversationId: project.activeConversationId,
        });
      }
    }, error => this.reportPersistFailure(error));
    return this.persistChain;
  }

  /**
   * Keep one failed write from poisoning the whole chain.
   *
   * `persistChain` is a promise chain: a single rejected `globalState.update` skipped
   * every later `.then` callback, so nothing was saved for the rest of the session and
   * the user was never told. Recover here instead: log, report once to the user, and
   * let the chain continue so the next write still lands.
   */
  private reportPersistFailure(error: unknown): void {
    const detail = errorMessage(error);
    this.log('error', 'persist.failed', detail);
    if (this.persistFailed) return;
    this.persistFailed = true;
    this.post({ type: 'error', conversationId: this.activeProject()?.activeConversationId ?? '', text: `SleepyCode could not save your conversations: ${detail}. Later changes may not survive a reload.` });
  }

  /**
   * Persist one project without rewriting the index or the other projects.
   *
   * Used by mid-run checkpoints, which fire often and only ever dirty the
   * conversation that is currently running.
   */
  private persistProject(project: Project): Promise<void> {
    this.persistChain = enqueuePersist(this.persistChain, async () => {
      const conversations = project.conversations.slice(0, MAX_PERSISTED_CONVERSATIONS);
      await this.context.globalState.update(`sleepycode.project.${project.id}`, {
        conversations,
        activeConversationId: project.activeConversationId,
      });
    }, error => this.reportPersistFailure(error));
    return this.persistChain;
  }

  /** The project that owns a conversation, so a checkpoint writes the right blob. */
  private projectForConversation(conversationId: string): Project | undefined {
    return this.projects.find(project => project.conversations.some(item => item.id === conversationId));
  }

  /**
   * Persist a mid-run checkpoint for the dirty conversation.
   *
   * A checkpoint after each completed iteration is what makes an interrupted run
   * recoverable. Serializing every project is too coarse and too heavy, so a
   * checkpoint writes only the project that owns the dirty conversation, and
   * non-forced writes are coalesced on an interval. Stop, error, and done pass
   * `force` so they flush immediately.
   */
  private checkpointConversation(conversation: Conversation, force = false): Promise<void> {
    const now = Date.now();
    const last = this.checkpointAtByConversation.get(conversation.id) ?? 0;
    if (!force && now - last < AgentViewProvider.CHECKPOINT_INTERVAL_MS) return this.persistChain;
    this.checkpointAtByConversation.set(conversation.id, now);
    conversation.updatedAt = now;
    const project = this.projectForConversation(conversation.id);
    if (!project) return this.persistChain;
    project.updatedAt = now;
    return this.persistProject(project);
  }

  private sortConversations(project: Project): void {
    project.conversations.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  private syncConversations(includeActive = true): void {
    const root = this.workspaceRoot();
    this.post({ type: 'project', name: root ? path.basename(root.fsPath) || root.fsPath : 'No folder open', path: root ? root.fsPath : '' });
    const project = this.activeProject();
    if (!project) return;
    this.sortConversations(project);
    // Group the queue once. Filtering it per conversation made this sync cost
    // conversations x queued entries on a path that runs on every state change.
    const queueByConversation = new Map<string, typeof this.queue>();
    for (const entry of this.queue) {
      const existing = queueByConversation.get(entry.conversationId);
      if (existing) existing.push(entry);
      else queueByConversation.set(entry.conversationId, [entry]);
    }
    this.post({
      type: 'conversations', conversations: project.conversations.map(({ id, title, archived, pinned, updatedAt, items }) => {
        // Scan backwards instead of copying and reversing the whole item array.
        const lastAssistant = findLastAssistant(items);
        const queued = queueByConversation.get(id) ?? [];
        return {
          id, title, archived, pinned: Boolean(pinned), updatedAt,
          hasMessages: items.length > 0,
          messageCount: items.length,
          changeCount: lastAssistant?.changes?.length ?? 0,
          status: this.runs.has(id) ? 'running' : lastAssistant?.paused ? 'paused' : lastAssistant?.kind === 'error' ? (lastAssistant.errorInfo?.code === 'interrupted' ? 'stopped' : 'failed') : lastAssistant ? 'done' : 'empty',
          running: this.runs.has(id),
          queued: queued.map(entry => entry.text),
          queuedIds: queued.map(entry => entry.id),
        };
      }), activeId: project.activeConversationId
    });
    if (includeActive) {
      const active = this.activeConversation();
      if (active) {
        const selection = this.selectionFor(active);
        const compactionUndoable = active.items[active.items.length - 1]?.kind === 'divider' && (this.compactionUndoStacks.get(active.id)?.length ?? 0) > 0;
        const compactionRedoable = (this.compactionRedoStacks.get(active.id)?.length ?? 0) > 0;
        this.post({ type: 'conversation', id: active.id, items: webviewTranscriptItems(active.items), model: selection.model, provider: selection.provider, agentId: selection.agentId, reasoningEffort: selection.reasoningEffort, compactionUndoable, compactionRedoable });
      }
    }
  }

  private confirmDeleteConversations(): boolean {
    return this.context.globalState.get<boolean>('sleepycode.confirmDelete', true) !== false;
  }

  private async onMessage(message: WebMessage): Promise<void> {
    if (message.type === 'notifyResponse') {
      const pending = this.pendingNotifies.get(message.id);
      if (pending) {
        this.pendingNotifies.delete(message.id);
        pending.resolve(message.choice);
        // Tell the card it was answered. Without this nothing ever removed it, so
        // an approval prompt stayed on screen asking for a decision already made.
        if (pending.approval) {
          this.post({
            type: 'approvalResolved',
            conversationId: pending.approval.conversationId,
            requestId: String(message.id),
            // "Allow once" is `ok`; everything else — reject, or a dismissal —
            // is a refusal, which is what the card should say happened.
            approved: message.choice === 'ok',
          });
        }
      }
      return;
    }
    if (message.type === 'ready') {
      // Settle the engine before anything reads it: the model picker and
      // routing depend on whether the CLI is available.
      await this.ensureEngine();
      this.syncConversations();
      await this.loadApiKeys();
      if (getSleepyAccount().loggedIn) {
        await this.ensureSleepyProvider();
      }
      this.postConfig();
      await this.refreshModels();
      await this.maybeShowFirstLaunchSettings();
      this.sendUsage();
      this.sendEditorContext();
      void this.ensureProjectIntelligence(false);
      if (getSleepyAccount().loggedIn) {
        void this.sendSleepyAccountData(true);
      }
      if (this.reactMode) this.sendReactBootstrap();
      return;
    }
    if (message.type === 'stop') {
      const project = this.activeProject();
      const activeId = project?.activeConversationId ?? '';
      // In CLI mode the run lives in the CLI process, so stop the CLI run rather
      // than aborting a local controller that is not driving this conversation.
      const stopping = project?.conversations.find(conversation => conversation.id === activeId);
      if (stopping && this.cliOwns(stopping, this.engineStatus) && await this.stopViaCli(activeId)) {
        this.log('info', 'cli.stop.requested', activeId);
        return;
      }
      const activeRun = this.runs.get(activeId);
      if (activeRun) {
        this.log('info', 'run.stop.requested', activeId);
        activeRun.controller.abort();
      } else {
        this.log('warn', 'run.stop.missing', `active=${activeId}; runs=${[...this.runs.keys()].join(',')}`);
        for (const run of this.runs.values()) run.controller.abort();
        this.post({ type: 'state', conversationId: activeId, running: false, label: '' });
      }
      return;
    }
    if (message.type === 'answerQuestion') {
      const resolve = this.pendingQuestions.get(message.callId);
      if (resolve) {
        this.pendingQuestions.delete(message.callId);
        this.log('info', 'question.answered', message.callId);
        // Echo it so the question card renders the chosen answers instead of
        // looking unanswered once the tool settles.
        this.post({ type: 'questionAnswered', conversationId: this.activeProject()?.activeConversationId, callId: message.callId, answers: message.answers ?? {} });
        resolve(message.answers ?? {});
      }
      return;
    }
    if (message.type === 'setMode') {
      const conversation = this.activeConversation();
      const mode = message.mode === 'ask' || message.mode === 'plan' ? message.mode : 'agent';
      if (!conversation) return;
      conversation.mode = mode;
      // Remembered globally so a new conversation inherits the user's choice
      // instead of silently reverting to `agent`, which can write.
      await this.context.globalState.update('sleepycode.lastMode', mode);
      this.log('info', 'conversation.mode', `${conversation.id} -> ${mode}`);
      await this.persistProjects();
      // The composer reflects the mode, and a read-only mode changes which tools
      // the next turn is offered, so both are republished.
      this.post({ type: 'config', mode });
      return;
    }
    if (message.type === 'cancelSubagent') {
      const controller = this.subagentControllers.get(message.callId);
      if (controller) {
        this.log('info', 'subagent.cancel', `${message.callId} (${message.reason ?? 'user'})`);
        controller.abort();
      } else {
        // Nothing to cancel: the subagent already finished, or the id is stale.
        this.log('warn', 'subagent.cancel.missing', message.callId);
      }
      return;
    }
    if (message.type === 'exportConversation') {
      await this.exportConversation(message.conversationId);
      return;
    }
    if (message.type === 'createWorktreeConversation') {
      await this.createWorktreeConversation(message.title);
      return;
    }
    if (message.type === 'saveModelOptions') {
      const values: Record<string, unknown> = {};
      for (const option of Array.isArray(message.options) ? message.options : []) {
        const entry = option as { key?: unknown; value?: unknown };
        if (typeof entry?.key === 'string') values[entry.key] = Number(entry.value);
      }
      const next = modelOptions.setModel(this.storedModelOptions(), String(message.modelId ?? ''), values);
      await this.context.globalState.update('sleepycode.modelOptions', next);
      this.log('info', 'model.options.saved', `${message.modelId}: ${JSON.stringify(next[String(message.modelId ?? '')] ?? {})}`);
      await this.refreshModels();
      return;
    }
    if (message.type === 'resetModelOptions') {
      const next = modelOptions.resetModel(this.storedModelOptions(), String(message.modelId ?? ''));
      await this.context.globalState.update('sleepycode.modelOptions', next);
      this.log('info', 'model.options.reset', String(message.modelId ?? ''));
      await this.refreshModels();
      return;
    }
    if (message.type === 'persistTurns') {
      // The webview sends this as it is torn down. Adopt it ONLY when the host has
      // nothing for that conversation: the host owns authoritative state, and
      // replacing it with the webview's lossy projection would lose tool results
      // and model history. Its real value is recovering a chat that would
      // otherwise open blank.
      const conversation = message.conversationId
        ? this.activeProject()?.conversations.find(item => item.id === message.conversationId)
        : undefined;
      const turns = Array.isArray(message.turns) ? message.turns : [];
      if (conversation && !conversation.items.length && turns.length) {
        conversation.items = adapter.turnsToItems(turns);
        this.log('info', 'conversation.recovered', `${conversation.id}: ${conversation.items.length} turn(s) from the webview`);
        await this.persistProjects();
        this.syncConversations();
      } else if (conversation && conversation.items.length) {
        this.log('info', 'persistTurns.ignored', `${conversation.id}: host already has ${conversation.items.length} item(s)`);
      }
      return;
    }
    if (message.type === 'setGoal') {
      const conversation = message.conversationId
        ? this.activeProject()?.conversations.find(item => item.id === message.conversationId)
        : this.activeConversation();
      const created = goalCore.createGoal(message.objective, message.tokenBudget);
      if (conversation && created) {
        conversation.goal = created;
        await this.persistProjects();
        this.log('info', 'conversation.goal', `${conversation.id}: ${created.objective}${created.tokenBudget ? ` (budget ${created.tokenBudget})` : ''}`);
        this.postWorkflow(conversation.id);
      }
      return;
    }
    if (message.type === 'setGoalStatus') {
      const conversation = this.activeProject()?.conversations.find(item => item.id === message.conversationId);
      if (conversation?.goal) {
        const current = conversation.goal;
        const before = current.status;
        const next = goalCore.withStatus(current, message.status);
        conversation.goal = next;
        if (next.status !== before) {
          await this.persistProjects();
          this.log('info', 'conversation.goal.status', `${conversation.id}: ${before} -> ${next.status}`);
          this.postWorkflow(conversation.id);
        }
      }
      return;
    }
    if (message.type === 'resolvePastedCode') {
      const mention = await this.locatePastedCode(message.text);
      this.post({ type: 'pasteResolved', requestId: message.requestId, ...(mention ? { mention } : {}) });
      return;
    }
    if (message.type === 'getFileIcon') {
      this.post({ type: 'fileIcon', filename: String(message.filename ?? '').toLowerCase(), icon: fileIcons.resolveFileIcon(message.filename ?? '') });
      return;
    }
    if (message.type === 'logError') {
      // A webview crash or render error is reported here; without this it was
      // invisible to anyone diagnosing a report.
      this.log('error', 'webview.error', [message.message, message.info].filter(Boolean).join(' | '));
      return;
    }
    if (message.type === 'openBrowserTab') {
      // Reveal the preview tab. It is created on the first capture, so an empty
      // preview is better than silently doing nothing.
      this.browserPreview.update(null);
      return;
    }
    if (message.type === 'requestExtensionLogs') {
      if (this.reactMode) {
        // The React base has no log view, so posting the entries would vanish.
        // Reveal the Output channel, which is where they are already written.
        this.showLogs();
        return;
      }
      this.sendExtensionLogs();
      return;
    }
    if (message.type === 'clearExtensionLogs') {
      await this.context.globalState.update(AgentViewProvider.LOG_KEY, []);
      this.sendExtensionLogs();
      return;
    }
    if (message.type === 'copyText') {
      await vscode.env.clipboard.writeText(message.text);
      this.post({ type: 'copied' });
      return;
    }
    if (message.type === 'removeQueued') {
      // Prefer the exact entry by id; fall back to the oldest queued prompt for the
      // conversation so optimistic (client-generated) ids still remove something.
      const own = this.queue.filter(entry => entry.conversationId === message.conversationId);
      const target = (message.id ? own.find(entry => entry.id === message.id) : undefined) ?? own[0];
      if (target) this.queue = queueCore.removeEntry(this.queue, target.id);
      this.postWorkflow(message.conversationId);
      return;
    }
    if (message.type === 'moveQueued') {
      const own = this.queue.filter(entry => entry.conversationId === message.conversationId);
      const target = (message.id ? own.find(entry => entry.id === message.id) : undefined) ?? own[0];
      if (target) this.queue = queueCore.moveUp(this.queue, target.id);
      this.postWorkflow(message.conversationId);
      return;
    }
    if (message.type === 'promoteQueued') {
      // "Send queued request now" / "Resume interrupted request". The entry is
      // made next for its conversation, so the drain that already exists picks
      // it — reordering only the visible list would show an order that is not
      // the one that runs.
      const own = this.queue.filter(entry => entry.conversationId === message.conversationId);
      const target = (message.id ? own.find(entry => entry.id === message.id) : undefined) ?? own[0];
      if (!target) return;
      this.queue = queueCore.promoteToFront(this.queue, target.id);
      const active = this.runs.get(message.conversationId);
      if (active) {
        // A run owns this conversation; aborting it hands control to the drain in
        // the run's `finally`, which now finds the promoted entry first.
        active.controller.abort();
        return;
      }
      // Nothing running here. Respect the global cap rather than bypassing it;
      // if we are at the cap the promoted entry runs on the next drain.
      if (this.runs.size >= MAX_CONCURRENT_RUNS) {
        this.postWorkflow(message.conversationId);
        return;
      }
      this.queue = queueCore.removeEntry(this.queue, target.id);
      this.postWorkflow(target.conversationId);
      void this.run(target.text, target.conversationId, undefined, undefined, target.context, target.promptContext);
      return;
    }
    if (message.type === 'steerQueued') {
      const run = this.runs.get(message.conversationId);
      if (!run) return;
      run.steering = true;
      run.controller.abort();
      return;
    }
    if (message.type === 'requestSettings') return void this.showSettings(false, message.section);
    if (message.type === 'compact') return this.compactConversation(message.conversationId);
    if (message.type === 'cancelCompact') {
      const compactProject = this.activeProject();
      const compactTargetId = message.conversationId ?? compactProject?.activeConversationId ?? '';
      this.compactionControllers.get(compactTargetId)?.abort();
      return;
    }
    if (message.type === 'newConversation') return this.newConversation();
    if (message.type === 'requestTranscript') {
      // The webview switched to a conversation and has no turns for it: either it
      // never saw that run's stream (reload, moved pane) or a snapshot was
      // withheld mid-run. Republishing is otherwise suppressed while streaming;
      // this one answer is exempt, and it is consumed by the message it allows.
      const project = this.activeProject();
      const requested = project?.conversations.find(entry => entry.id === (message.conversationId || project.activeConversationId));
      if (!project || !requested) return;
      project.activeConversationId = requested.id;
      this.reactSnapshotOnce = true;
      this.syncConversations();
      return;
    }
    if (message.type === 'openConversation') {
      const project = this.activeProject();
      const opened = project?.conversations.find(item => item.id === message.id);
      if (project && opened) {
        project.activeConversationId = message.id;
        project.updatedAt = Date.now();
        void this.persistProjects();
        this.syncConversations();
        this.refreshSessionStats();
        // Switching chats must leave the composer on a model this conversation's
        // engine can run; without this a model-less CLI chat would show the
        // local SleepyAI default and substitute on its first send.
        void this.ensureCliSelection(opened);
        // A reloaded window has an empty chat map, so nothing would ever attach
        // the CLI stream for this conversation. Its persisted items are only a
        // mirror of sleepy.db and go stale the moment the CLI does anything
        // else, so attach now and let the projection republish.
        if (this.cliOwns(opened, this.engineStatus)) {
          void this.cliChatFor(message.id, this.workspaceRoot()).then(chat => {
            if (!chat) {
              this.log('warn', 'cli.open.unavailable', `conversation=${message.id}`);
              return;
            }
            this.log('info', 'cli.open.attached', `conversation=${message.id}`);
          }).catch(error => {
            this.log('error', 'cli.open.failed', `conversation=${message.id}; ${errorMessage(error)}`);
          });
        }
      }
      return;
    }
    if (message.type === 'renameConversation') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.id);
      if (!project || !conversation) return;
      const proposed = message.title ?? await vscode.window.showInputBox({
        title: 'Rename SleepyCode conversation',
        value: conversation.title,
        prompt: 'Choose a short name for this conversation.',
        ignoreFocusOut: true,
      });
      const title = proposed?.replace(/\s+/g, ' ').trim().slice(0, 100) ?? '';
      if (!title) return;
      conversation.title = title;
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      return;
    }
    if (message.type === 'togglePinConversation') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.id);
      if (!project || !conversation) return;
      conversation.pinned = !conversation.pinned;
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      this.sortConversations(project);
      await this.persistProjects();
      this.syncConversations();
      return;
    }
    if (message.type === 'archiveConversation') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.id);
      if (!project || !conversation || this.runs.has(message.id)) return;
      this.queue = this.queue.filter(entry => entry.conversationId !== message.id);
      conversation.archived = !conversation.archived;
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      if (conversation.archived && project.activeConversationId === conversation.id) {
        const next = project.conversations.find(item => !item.archived && item.id !== conversation.id);
        if (next) project.activeConversationId = next.id;
        else {
          const fresh = this.createConversation();
          project.conversations.unshift(fresh);
          project.activeConversationId = fresh.id;
        }
      }
      await this.persistProjects();
      this.syncConversations();
      return;
    }
    if (message.type === 'deleteConversation') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.id);
      if (!project || !conversation || this.runs.has(message.id)) return;
      const messageCount = conversation.items.length;
      const detail = 'This permanently deletes ' + (conversation.archived ? 'the archived conversation' : 'this conversation') + (messageCount ? ' and its ' + messageCount + ' message' + (messageCount === 1 ? '' : 's') : '') + '. This cannot be undone.';
      if (this.confirmDeleteConversations()) {
        const choice = await this.prompt('Delete conversation \'' + conversation.title + '\'?', detail, { ok: 'Delete', secondary: 'Don\'t ask again', cancel: 'Cancel', danger: true });
        if (choice === 'secondary') {
          await this.context.globalState.update('sleepycode.confirmDelete', false);
          return;
        }
        if (choice !== 'ok') return;
      }
      this.queue = this.queue.filter(entry => entry.conversationId !== message.id);
      this.compactionUndoStacks.delete(message.id);
      this.compactionRedoStacks.delete(message.id);
      // Drop the CLI session binding too. The conversation's rows in sleepy.db
      // are untouched and stay reachable from the CLI, but leaving the binding
      // here would let a later conversation that reuses this id silently adopt
      // the deleted one's session.
      this.cliSessions?.forget(message.id);
      void this.context.globalState.update(`sleepycode.compactionSnapshots.${message.id}`, undefined);
      project.conversations = project.conversations.filter(item => item.id !== message.id);
      project.updatedAt = Date.now();
      if (project.activeConversationId === message.id) {
        const next = project.conversations.find(item => !item.archived) ?? this.createConversation();
        if (!project.conversations.includes(next)) project.conversations.unshift(next);
        project.activeConversationId = next.id;
      }
      await this.persistProjects();
      this.syncConversations();
      systemNotify(this.context, { subtitle: 'Conversation deleted', message: 'Conversation \'' + conversation.title + '\' was deleted.' });
      return;
    }
    if (message.type === 'restoreCheckpoint') {
      if (this.runs.size) return;
      const root = this.workspaceRoot();
      const project = this.activeProject();
      if (!root || !project || project.path !== root.fsPath || !isGitTrackedWorkspace(root.fsPath)) {
        void vscode.window.showInformationMessage('Restore is available only for the Git-tracked project that matches the current folder.');
        return;
      }
      const conversation = project.conversations.find(item => item.id === message.conversationId);
      const targetIndex = conversation?.items.findIndex(item => item.id === message.itemId && item.role === 'assistant') ?? -1;
      if (!conversation || targetIndex < 0) return;
      // Restore rewinds items and structured history together. A CLI
      // conversation has no local restore point and no structured history to
      // keep in step, so there is nothing here it can honestly rewind.
      if (this.refuseIfCliOwned(conversation, 'Restoring a checkpoint')) return;
      const target = conversation.items[targetIndex];
      if (!target?.gitTree) {
        void vscode.window.showInformationMessage('This message does not have a Git restore point. Restore points are created for newer SleepyCode responses.');
        return;
      }
      try {
        await restoreGitTree(root.fsPath, target.gitTree);
      } catch (error) {
        void vscode.window.showErrorMessage(`Git restore failed: ${errorMessage(error)}`);
        return;
      }
      conversation.items = conversation.items.slice(0, targetIndex + 1);
      conversation.messages = sliceMessagesToItems(conversation.messages, conversation.items);
      conversation.pending = undefined;
      clearForwardStacks(conversation);
      conversation.updatedAt = Date.now();
      project.activeConversationId = conversation.id;
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      void vscode.window.showInformationMessage('Git workspace and conversation restored.');
      return;
    }
    if (message.type === 'branchConversation') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation) return;
      const targetIndex = conversation.items.findIndex(item => item.id === message.itemId);
      if (targetIndex < 0) return;
      // Branching copies a prefix of items into a brand-new local conversation.
      // From a CLI conversation that copy is a display mirror with no
      // structured history, so the new chat would claim context the model never
      // saw. The CLI owns forking here, and we have no route for it.
      if (this.refuseIfCliOwned(conversation, 'Branching')) return;
      const sliced = branchConversationState(conversation, targetIndex);
      if (!sliced) return;
      const slicedItems = sliced.items.map((item, idx) => ({
        ...item,
        id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      }));
      const branchedTitle = `Branch: ${conversation.title}`;
      const branched = this.createConversation(slicedItems, sliced.messages);
      branched.title = branchedTitle;
      project.conversations.unshift(branched);
      project.activeConversationId = branched.id;
      project.updatedAt = Date.now();
      await this.persistProject(project);
      this.syncConversations();
      return;
    }
    if (message.type === 'editUserMessage') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      const targetIndex = conversation.items.findIndex(item => item.id === message.itemId && item.role === 'user');
      if (targetIndex < 0) return;
      // Editing rewinds the transcript and re-runs the turn. On a CLI
      // conversation that truncates a mirror the CLI still holds and then
      // resumes it with the local agent, mixing the two histories.
      if (this.refuseIfCliOwned(conversation, 'Editing a past message')) return;
      const root = this.workspaceRoot();
      const gitTracked = root && project.path === root.fsPath && isGitTrackedWorkspace(root.fsPath);
      // One pass over the rewound tail. This used to be three separate
      // `slice(targetIndex)` copies plus two scans, each allocating a full copy
      // of the transcript tail on the exact path a user reaches for when the UI
      // already feels slow.
      let hasSnapshot = false;
      let assistantCheckpoint: TranscriptItem | undefined;
      let snapshotItem: TranscriptItem | undefined;
      for (let index = targetIndex; index < conversation.items.length; index++) {
        const item = conversation.items[index]!;
        if (!item.fileSnapshot?.length) continue;
        hasSnapshot = true;
        if (item.role === 'assistant' && !snapshotItem) snapshotItem = item;
      }
      if (!snapshotItem) {
        for (let index = targetIndex; index < conversation.items.length; index++) {
          const item = conversation.items[index]!;
          if (item.role === 'assistant' && item.gitTree) { assistantCheckpoint = item; break; }
        }
      }
      // Ask before reverting workspace files: editing a past message can either
      // rewind the code to the checkpoint or keep the current workspace as-is.
      const hasRestorableState = Boolean(root) && (gitTracked || hasSnapshot);
      let restoreState = false;
      if (hasRestorableState) {
        const choice = await this.prompt(
          'Restore workspace state?',
          'Editing this message resends from that point. Restore workspace files to the state before it, or keep your current files?',
          { ok: 'Restore state', secondary: 'Keep current files', cancel: 'Cancel' },
        );
        if (choice === 'cancel') return;
        restoreState = choice === 'ok';
        if (restoreState && gitTracked) {
          if (assistantCheckpoint?.gitTree) {
            try {
              await restoreGitTree(root!.fsPath, assistantCheckpoint.gitTree);
            } catch { }
          }
        } else if (restoreState && root) {
          if (snapshotItem?.fileSnapshot?.length) await this.restoreFileSnapshots(root.fsPath, snapshotItem.fileSnapshot);
        }
      }
      conversation.items = conversation.items.slice(0, targetIndex);
      conversation.messages = sliceMessagesToItems(conversation.messages, conversation.items);
      conversation.pending = undefined;
      clearForwardStacks(conversation);
      const editedItem = createTranscriptItem('user', message.text.trim());
      editedItem.attachments = message.context?.attachments;
      conversation.items.push(editedItem);
      if (conversation.items.length === 1) conversation.title = conversationTitle(message.text.trim());
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      // Only this project changed, so only this project needs rewriting. The
      // coarse whole-workspace persist re-serializes every project key, which
      // on a long conversation means re-writing megabytes of snapshots in
      // order to change one of them.
      await this.persistProject(project);
      this.syncConversations();
      const editorContext = root ? await this.composerContextBlock(root, message.context) : '';
      const projectContext = root && message.context?.includeProjectIndex !== false ? await this.projectContextBlock(root, message.text.trim()) : '';
      const promptContext = [editorContext, projectContext].filter(Boolean).join('\n\n');
      void this.run(message.text.trim(), conversation.id, undefined, undefined, message.context, promptContext, true);
      return;
    }
    if (message.type === 'undoLastTurn') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      if (!conversation.items.length) return;
      // A CLI conversation rewinds through CLI revert. Popping its items here
      // would edit a transcript the CLI still holds and leave reverted files
      // unreverted, so hand the whole turn back to the engine that owns it.
      if (await this.undoViaCli(conversation, this.workspaceRoot())) {
        this.log('info', 'cli.undo.requested', `conversation=${conversation.id}`);
        return;
      }
      // A compaction boundary (divider marker) undoes the whole compaction.
      if (conversation.items[conversation.items.length - 1]?.kind === 'divider') {
        if (!this.undoCompaction(conversation)) return;
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.persistProject(project);
        this.syncConversations();
        return;
      }
      const popped = popLastTurn(conversation);
      if (!popped) return;
      const root = this.workspaceRoot();
      const assistantItem = [...popped.popped].reverse().find(item => item.role === 'assistant');
      if (root && assistantItem?.fileSnapshot?.length) {
        popped.snapshot.redoFiles = assistantItem.fileSnapshot.map(snap => {
          try {
            return { path: snap.path, existed: true, content: readFileSync(path.join(root.fsPath, snap.path), 'utf8') };
          } catch {
            return { path: snap.path, existed: false, content: '' };
          }
        });
      }
      const gitTracked = root && project.path === root.fsPath && isGitTrackedWorkspace(root.fsPath);
      if (gitTracked && root) {
        try { popped.snapshot.redoGitTree = await captureGitTree(root.fsPath); } catch { }
      }
      if (assistantItem) {
        const undoTree = workspaceGitRestoreFromSnapshot(popped.snapshot, 'undo');
        try {
          if (gitTracked && root && undoTree) {
            await restoreGitTree(root.fsPath, undoTree);
          } else if (root && assistantItem.fileSnapshot?.length) {
            await this.restoreFileSnapshots(root.fsPath, assistantItem.fileSnapshot);
          }
        } catch (error) {
          // Do not claim the turn was undone when its files could not be
          // restored. Put the transcript and model history back exactly as-is.
          applyTurnSnapshot(conversation, popped.snapshot as SessionTurnSnapshot<TranscriptItem, ModelMessage>);
          void vscode.window.showErrorMessage(`Could not restore turn files: ${errorMessage(error)}`);
          return;
        }
      }
      conversation.turnUndo = [...(conversation.turnUndo ?? []), popped.snapshot].slice(-5);
      conversation.turnRedo = [];
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      await this.persistProject(project);
      this.syncConversations();
      return;
    }
    if (message.type === 'redoLastTurn') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      // Mirror of undo: a CLI conversation un-reverts through the CLI, which
      // restores the turn it rewound. The local stack is a different record and
      // would put the two engines out of step.
      if (await this.redoViaCli(conversation, this.workspaceRoot())) {
        this.log('info', 'cli.redo.requested', `conversation=${conversation.id}`);
        return;
      }
      // Redo a compaction first when one is pending at this boundary.
      if (this.redoCompaction(conversation)) {
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.persistProject(project);
        this.syncConversations();
        return;
      }
      const snapshot = takeTurnRedo(conversation);
      if (!snapshot) return;
      applyTurnSnapshot(conversation, snapshot as SessionTurnSnapshot<TranscriptItem, ModelMessage>);
      const root = this.workspaceRoot();
      const redoTree = workspaceGitRestoreFromSnapshot(snapshot, 'redo');
      try {
        if (root && redoTree && isGitTrackedWorkspace(root.fsPath)) {
          await restoreGitTree(root.fsPath, redoTree);
        } else {
          const redoFiles = workspaceRestoreFromSnapshot(snapshot, 'redo') as FileSnapshot[] | undefined;
          if (root && redoFiles?.length) await this.restoreFileSnapshots(root.fsPath, redoFiles);
        }
      } catch (error) {
        // `takeTurnRedo` moved the snapshot to turnRedo and `applyTurnSnapshot`
        // restored the transcript. Reverse both if workspace restoration fails.
        popLastTurn(conversation);
        conversation.turnRedo = conversation.turnRedo?.slice(0, -1) ?? [];
        conversation.turnUndo = [...(conversation.turnUndo ?? []), snapshot].slice(-5);
        void vscode.window.showErrorMessage(`Could not redo turn files: ${errorMessage(error)}`);
        return;
      }
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      await this.persistProject(project);
      this.syncConversations();
      return;
    }
    if (message.type === 'signIn') {
      // The chat's banner action. Without a handler the banner's button was the
      // same class of dead control as everything else in the audit.
      this.signIn();
      return;
    }
    if (message.type === 'openPanel') {
      // The drawer's own entry point. Without this handler the message the
      // webview posted had nowhere to land, so the panels were reachable only
      // from the command palette.
      this.openPanel(message.panel);
      return;
    }
    if (message.type === 'requestPanel') {
      void this.sendPanel(message.panel);
      return;
    }
    if (message.type === 'requestUsage') {
      this.sendUsage();
      void this.sendSleepyAccountData(false);
      return;
    }
    if (message.type === 'requestMarketplace') return this.openMarketplace();
    if (message.type === 'requestMarketplaceInstalled') return void this.sendMarketplaceInstalled();
    if (message.type === 'marketplaceTop') {
      try {
        const { skills, total } = await this.searchMarketplace('skill', message.sortBy);
        this.post({ type: 'marketplaceResults', query: '', total, skills });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplaceSearch') {
      try {
        const { skills, total } = await this.searchMarketplace(message.query, message.sortBy);
        this.post({ type: 'marketplaceResults', query: message.query, total, skills });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplaceListRepo') {
      try {
        const reference = resolveInstallPath(message.source, '', message.branch ?? 'main');
        const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch);
        this.post({ type: 'marketplaceRepoSkills', owner: reference.owner, repo: reference.repo, branch: reference.branch, skills });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplacePreview') {
      try {
        const reference = resolveInstallPath(message.source, '', message.branch ?? 'main');
        const folderPath = message.path ?? reference.folderPath ?? '';
        if (!folderPath) {
          const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch);
          this.post({ type: 'marketplaceRepoSkills', owner: reference.owner, repo: reference.repo, branch: reference.branch, skills });
          return;
        }
        const { content } = await readSkillMarkdown(reference.owner, reference.repo, reference.branch, folderPath);
        // Display-only preview: cap the rendered markdown but say so, rather than
        // silently presenting a shortened skill as if it were complete.
        const previewCap = 40_000;
        const markdown = content.length > previewCap
          ? `${content.slice(0, previewCap)}\n\n…(${content.length - previewCap} bytes not shown in this preview)…`
          : content;
        this.post({ type: 'marketplacePreview', title: reference.owner + '/' + reference.repo + ' / ' + folderPath, markdown, source: message.source, path: folderPath });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplaceInstall') {
      const key = message.key ?? '';
      const result = await this.installMarketplaceSkill(message.source, message.skill ?? undefined, (done, total) => {
        this.post({ type: 'marketplaceInstallProgress', key, done, total });
      });
      this.post({ type: 'marketplaceResult', ok: result.ok, text: result.text, key });
      if (result.ok) await this.sendMarketplaceInstalled();
      return;
    }
    if (message.type === 'marketplaceUninstall') {
      const result = await this.uninstallMarketplaceSkill(message.folder);
      this.post({ type: 'marketplaceResult', ok: result.ok, text: result.text });
      if (result.ok) await this.sendMarketplaceInstalled();
      return;
    }

    if (message.type === 'saveSettings') {
      try {
        const searxngUrl = message.searxngUrl.trim().replace(/\/$/, '');
        if (searxngUrl && !/^https?:\/\//i.test(searxngUrl)) throw new Error('SearXNG URL must start with http:// or https://.');
        parseMcpServers(message.mcpServers ?? '{}');
        const rawMaxSteps = Number(message.maxSteps);
        const maxSteps = rawMaxSteps === 0 ? 0 : Math.max(1, Math.min(200, Math.round(rawMaxSteps) || 200));
        const maxPersistedReasoning = normalizePersistedReasoningLimit(message.maxPersistedReasoning, DEFAULT_PERSISTED_REASONING);

        // Validate and normalize providers before persisting webview input.
        const previousProviders = this.getProviders();
        const providers = (message.providers ?? []).map(rawProvider => {
          const id = rawProvider.id?.trim();
          const name = rawProvider.name?.trim();
          const baseURL = rawProvider.baseURL?.trim().replace(/\/+$/, '');
          if (!id || !/^[a-z0-9_-]+$/.test(id)) throw new Error(`Provider ID must be kebab-case: "${id || '(empty)'}".`);
          if (!name) throw new Error(`Provider "${id}" needs a name.`);
          if (!baseURL || !/^https?:\/\//i.test(baseURL)) throw new Error(`Provider "${id}" base URL must start with http:// or https://.`);
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(rawProvider.customHeaders ?? {})) {
            if (!key.trim() || typeof value !== 'string') throw new Error(`Provider "${id}" custom headers must contain string values.`);
            headers[key.trim()] = value;
          }
          const modelList = rawProvider.modelList?.map(model => model.trim()).filter(Boolean);
          return {
            id,
            name,
            baseURL,
            ...(Object.keys(headers).length ? { customHeaders: headers } : {}),
            ...(modelList?.length ? { modelList: [...new Set(modelList)] } : {}),
            ...(id === 'sleepyai' && rawProvider.isSleepy ? { isSleepy: true } : {}),
          } satisfies Provider;
        });
        const seenIds = new Set<string>();
        for (const provider of providers) {
          if (seenIds.has(provider.id)) throw new Error(`Duplicate provider ID: "${provider.id}".`);
          seenIds.add(provider.id);
          if (provider.id === 'sleepyai' && !provider.isSleepy) throw new Error('The provider ID "sleepyai" is reserved for the SleepyAI account provider.');
        }

        const sleepyIndex = providers.findIndex(provider => provider.id === 'sleepyai' && provider.isSleepy);
        if (sleepyIndex >= 0) providers.splice(sleepyIndex, 1);
        providers.unshift({ id: 'sleepyai', name: 'SleepyAI', baseURL: sleepyApiBase(), isSleepy: true });

        let activeProvider = message.activeProvider;
        if (!providers.some(p => p.id === activeProvider)) {
          activeProvider = providers[0]?.id ?? '';
        }

        const config = vscode.workspace.getConfiguration('sleepycode');
        await config.update('maxSteps', maxSteps, vscode.ConfigurationTarget.Global);
        await config.update('maxPersistedReasoning', maxPersistedReasoning, vscode.ConfigurationTarget.Global);
        await config.update('extraFreeModels', message.extraFreeModels ?? '', vscode.ConfigurationTarget.Global);
        await config.update('useCli', Boolean(message.useCli), vscode.ConfigurationTarget.Global);
        await this.context.globalState.update('sleepycode.providers', providers);
        await this.context.globalState.update('sleepycode.activeProvider', activeProvider);
        const currentProviderIds = new Set(providers.map(provider => provider.id));
        for (const removed of previousProviders.filter(provider => !currentProviderIds.has(provider.id))) {
          await this.context.secrets.delete(`sleepycode.apiKey.${removed.id}`);
          delete this.apiKeys[removed.id];
          this.post({ type: 'apiKeyState', provider: removed.id, hasApiKey: false });
        }
        await this.context.globalState.update('sleepycode.approvalMode', normalizeApprovalMode(message.approvalMode));
        await this.context.globalState.update('sleepycode.searxngUrl', searxngUrl);
        await this.context.globalState.update('sleepycode.mcpServers', message.mcpServers?.trim() || '{}');
        await this.context.globalState.update('sleepycode.onlyDefaultModels', Boolean(message.onlyDefaultModels));
        await this.context.globalState.update('sleepycode.confirmDelete', message.confirmDelete !== false);
        await this.context.globalState.update('sleepycode.compactionModel', (message.compactionModel ?? '').trim());
        await this.context.globalState.update('sleepycode.compact', Boolean(message.compact));
        await this.context.globalState.update('sleepycode.subagentModels', {
          explorer: (message.subagentModels?.explorer ?? '').trim(),
          reviewer: (message.subagentModels?.reviewer ?? '').trim(),
          worker: (message.subagentModels?.worker ?? '').trim(),
        });
        await this.context.globalState.update('sleepycode.setupComplete', true);

        if (message.apiKey.trim()) {
          await this.context.secrets.store(`sleepycode.apiKey.${activeProvider}`, message.apiKey.trim());
          this.apiKeys[activeProvider] = message.apiKey.trim();
        }
        this.post({ type: 'settingsResult', ok: true, text: 'Settings saved.' });
        await this.ensureEngine();
        await this.refreshModels();
      } catch (error) {
        this.post({ type: 'settingsResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'fetchProviderModels') {
      // Preview discovery for the provider form. Nothing typed into the form is
      // persisted here: the transient provider and the in-memory key are only
      // used for this one request, so a brand-new (unsaved) provider can still
      // list its models before Save.
      try {
        const existing = message.id ? this.getProviders().find(provider => provider.id === message.id) : undefined;
        const provider: Provider = {
          id: message.id || '__form__',
          name: message.name?.trim() || 'Provider',
          baseURL: message.baseURL.trim().replace(/\/+$/, ''),
          customHeaders: message.customHeaders,
          modelList: undefined,
        };
        const apiKey = message.apiKey?.trim() || (existing ? this.providerApiKey(existing) : '');
        const models = sortModelsA2Z(await fetchProviderModels(provider, apiKey, this.config().extraFreeModels));
        this.post({ type: 'providerModels', id: message.id, ok: true, text: `Found ${models.length} model${models.length === 1 ? '' : 's'}.`, models: models.map(model => model.id) });
        if (existing) void this.refreshModels();
      } catch (error) {
        this.post({ type: 'providerModels', id: message.id, ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'saveProviderApiKey') {
      const providerId = message.providerId;
      if (!this.getProviders().some(provider => provider.id === providerId)) return;
      try {
        const apiKey = message.apiKey.trim();
        if (apiKey) {
          await this.context.secrets.store(`sleepycode.apiKey.${providerId}`, apiKey);
          this.apiKeys[providerId] = apiKey;
        } else {
          await this.context.secrets.delete(`sleepycode.apiKey.${providerId}`);
          delete this.apiKeys[providerId];
        }
        this.post({ type: 'apiKeyState', provider: providerId, hasApiKey: Boolean(this.apiKeys[providerId]) });
        await this.refreshModels();
      } catch (error) {
        this.post({ type: 'settingsResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'removeApiKey') {
      const providerId = message.providerId || this.config().activeProvider;
      try {
        await this.context.secrets.delete(`sleepycode.apiKey.${providerId}`);
      } catch { }
      delete this.apiKeys[providerId];
      this.post({ type: 'apiKeyState', provider: providerId, hasApiKey: Boolean(this.apiKeys[providerId]) });
      await this.refreshModels();
      return;
    }
    if (message.type === 'sleepyLogin' || message.type === 'sleepyDeviceLogin') {
      const postStatus = (text: string) => this.post({ type: 'sleepyStatus', ...getSleepyAccount(), busy: true, text });
      try {
        postStatus(message.type === 'sleepyLogin' ? 'Starting OAuth login…' : 'Starting device login…');
        const account = message.type === 'sleepyLogin'
          ? await loginWithBrowser(postStatus)
          : await loginWithDevice(postStatus);
        if (!account.loggedIn) throw new Error('Login did not complete.');
        await this.context.globalState.update('sleepycode.setupComplete', true);
        const sleepyProvider = await this.ensureSleepyProvider();
        this.post({ type: 'sleepyStatus', ...getSleepyAccount(), provider: sleepyProvider, busy: false, text: '' });
        this.post({ type: 'settingsResult', ok: true, text: `Signed in to SleepyAI${account.email ? ` as ${account.email}` : ''}.` });
        await this.refreshModels();
      } catch (error) {
        this.post({ type: 'sleepyStatus', ...getSleepyAccount(), busy: false, text: '' });
        this.post({ type: 'settingsResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'sleepyLogout') {
      await clearGatewayConfig();
      if (this.config().activeProvider === 'sleepyai') {
        await vscode.workspace.getConfiguration('sleepycode').update('model', '', vscode.ConfigurationTarget.Global);
      }
      this.post({ type: 'sleepyStatus', loggedIn: false, busy: false, text: '' });
      this.post({ type: 'settingsResult', ok: true, text: 'Signed out of SleepyAI.' });
      this.postConfig();
      await this.refreshModels();
      return;
    }
    if (message.type === 'sleepyAccountData') {
      await this.sendSleepyAccountData(true);
      return;
    }
    if (message.type === 'openSleepyDashboard') {
      await vscode.env.openExternal(vscode.Uri.parse(SLEEPY_ACCOUNT_URL));
      return;
    }
    if (message.type === 'openSleepyWebsite') {
      await vscode.env.openExternal(vscode.Uri.parse(SLEEPY_WEBSITE_URL));
      return;
    }
    if (message.type === 'saveMcpConnection') {
      try {
        const name = message.connection?.name?.trim();
        const url = message.connection?.url?.trim();
        if (!name) throw new Error('MCP connection name is required.');
        if (!url || !/^https?:\/\//i.test(url)) throw new Error('MCP connection URL must start with http:// or https://.');
        const auth = message.connection.auth ?? { type: 'none' as const };
        for (const [key, value] of Object.entries(auth.customHeaders ?? {})) {
          if (!key.trim() || typeof value !== 'string') throw new Error('Custom headers must be a JSON object with string values.');
        }
        const stored = await loadMcpConnections(this.context);
        const existing = stored.find(connection => connection.name === name);
        await saveMcpConnection(this.context, {
          name,
          description: message.connection.description ?? '',
          url,
          transport: message.connection.transport === 'sse' ? 'sse' : 'http',
          auth,
          enabled: message.connection.enabled !== false,
          order: typeof message.connection.order === 'number' ? message.connection.order : (existing?.order ?? stored.length),
        });
        this.post({ type: 'mcpConnectionResult', ok: true, text: 'Saved.' });
        await this.sendMcpConnections();
      } catch (error) {
        this.post({ type: 'mcpConnectionResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'deleteMcpConnection') {
      try {
        const name = message.name?.trim();
        if (!name) throw new Error('MCP connection name is required.');
        await deleteMcpConnection(this.context, name);
        this.post({ type: 'mcpConnectionResult', ok: true, text: `Removed "${name}".` });
        await this.sendMcpConnections();
      } catch (error) {
        this.post({ type: 'mcpConnectionResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'testMcpConnection') {
      const name = message.name?.trim();
      const connection = (await loadMcpConnections(this.context)).find(item => item.name === name);
      if (!connection) {
        this.post({ type: 'mcpConnectionResult', ok: false, text: `MCP connection "${name ?? ''}" was not found.` });
        await this.sendMcpConnections();
        return;
      }
      let testable: McpConnectionData = connection;
      try {
        if (!connection.enabled) {
          testable = { ...connection, enabled: true };
          this.post({ type: 'mcpConnectionResult', ok: true, text: 'Testing a disabled connection…' });
        }
        const result = await connectToMcpConnections([testable], this.context, (title, detail) => this.approve('command', title, detail), this.workspaceRoot()?.fsPath);
        await result.connection.close();
        const status = result.statuses.find(item => item.name === connection.name) ?? result.statuses[0];
        const ok = status?.state === 'ok';
        const text = ok
          ? `Connected. ${status?.toolCount ?? 0} tool${status?.toolCount === 1 ? '' : 's'} available.`
          : (status?.state === 'auth_required'
            ? `${connection.name} requires authorization. Edit this connection and choose Connect OAuth.`
            : (status?.error ? `${connection.name}: ${status.error}` : `${connection.name} could not be reached.`));
        this.post({ type: 'mcpConnectionResult', ok, text, status });
        await this.sendMcpConnections();
      } catch (error) {
        this.post({ type: 'mcpConnectionResult', ok: false, text: errorMessage(error) });
        await this.sendMcpConnections();
      }
      return;
    }
    if (message.type === 'connectMcpOAuth') {
      const name = message.name?.trim();
      const connection = (await loadMcpConnections(this.context)).find(item => item.name === name);
      if (!connection) {
        this.post({ type: 'mcpConnectionResult', ok: false, text: `MCP connection "${name ?? ''}" was not found.` });
        return;
      }
      try {
        await beginMcpOAuth({ name: connection.name, auth: connection.auth }, this.context);
        this.post({ type: 'mcpConnectionResult', ok: true, text: 'Waiting for OAuth authorization in your browser…' });
      } catch (error) {
        this.post({ type: 'mcpConnectionResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'resetSettings') {
      const previousProviders = this.getProviders();
      const config = vscode.workspace.getConfiguration('sleepycode');
      const defaults = cloneProviders();
      await config.update('maxSteps', 200, vscode.ConfigurationTarget.Global);
      await config.update('maxPersistedReasoning', DEFAULT_PERSISTED_REASONING, vscode.ConfigurationTarget.Global);
      await config.update('extraFreeModels', '', vscode.ConfigurationTarget.Global);
      await config.update('model', '', vscode.ConfigurationTarget.Global);
      await config.update('useCli', false, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update('sleepycode.providers', defaults);
      await this.context.globalState.update('sleepycode.activeProvider', defaults[0]?.id ?? '');
      await this.context.globalState.update('sleepycode.approvalMode', 'ask');
      await this.context.globalState.update('sleepycode.searxngUrl', undefined);
      await this.context.globalState.update('sleepycode.systemPrompt', undefined);
      await this.context.globalState.update('sleepycode.mcpServers', undefined);
      await this.context.globalState.update('sleepycode.onlyDefaultModels', undefined);
      await this.context.globalState.update('sleepycode.confirmDelete', undefined);
      await this.context.globalState.update('sleepycode.compactionModel', undefined);
      await this.context.globalState.update('sleepycode.subagentModels', undefined);
      await this.context.globalState.update('sleepycode.mcpConnections', undefined);
      await this.context.globalState.update('sleepycode.customAgents', undefined);
      await this.context.globalState.update('sleepycode.hooks', undefined);
      await this.context.globalState.update('sleepycode.scheduledTasks', undefined);
      for (const provider of previousProviders) {
        await this.context.secrets.delete(`sleepycode.apiKey.${provider.id}`);
      }
      this.apiKeys = {};
      await this.context.secrets.delete('sleepycode.apiKey');
      await this.showSettings();
      await this.refreshModels();
      return;
    }
    if (message.type === 'selectModel') {
      const config = vscode.workspace.getConfiguration('sleepycode');
      await config.update('model', message.model, vscode.ConfigurationTarget.Global);
      if (message.provider && this.getProviders().some(provider => provider.id === message.provider)) {
        await this.context.globalState.update('sleepycode.activeProvider', message.provider);
      }
      const conversation = this.activeConversation();
      if (conversation) {
        conversation.model = message.model;
        if (message.provider) conversation.provider = message.provider;
        conversation.updatedAt = Date.now();
        const project = this.activeProject();
        if (project) project.updatedAt = Date.now();
        await this.persistProjects();
      }
      this.postConfig();
      void this.refreshModels();
      return;
    }
    if (message.type === 'refreshModels') {
      // The picker's own retry: refetch catalogs without re-running the whole
      // `ready` boot sequence.
      await this.refreshModels();
      return;
    }
    if (message.type === 'selectReasoningEffort') {
      // Per-conversation, not global: two chats can legitimately want
      // different budgets. Unknown values coerce to the default.
      const effort = normalizeReasoningEffort(message.effort);
      const conversation = this.activeConversation();
      if (conversation) {
        conversation.reasoningEffort = effort;
        conversation.updatedAt = Date.now();
        const project = this.activeProject();
        if (project) project.updatedAt = Date.now();
        await this.persistProjects();
      }
      this.postConfig();
      return;
    }
    if (message.type === 'selectAgent') {
      await this.context.globalState.update('sleepycode.agentId', message.agentId);
      this.agentPromptCache.clear();
      const conversation = this.activeConversation();
      if (conversation) {
        conversation.agentId = message.agentId;
        conversation.updatedAt = Date.now();
        const project = this.activeProject();
        if (project) project.updatedAt = Date.now();
        await this.persistProjects();
      }
      this.postConfig();
      return;
    }
    if (message.type === 'saveAgent') {
      const incoming = message.agent;
      const id = (incoming?.id ?? '').trim();
      const name = (incoming?.name ?? '').trim();
      if (!id || !name || !/^[A-Za-z0-9_-]+$/.test(id)) {
        void vscode.window.showWarningMessage('Agent id may only contain letters, numbers, hyphens, and underscores.');
        return;
      }
      const sanitizeList = (values?: string[]): string[] | undefined => {
        const cleaned = (Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean);
        return cleaned.length ? cleaned : undefined;
      };
      const tools = { allow: sanitizeList(incoming.tools?.allow), deny: sanitizeList(incoming.tools?.deny) };
      const entry: CustomAgentConfig = {
        id,
        name,
        ...(incoming.color?.trim() ? { color: incoming.color.trim() } : {}),
        ...(incoming.prompt?.trim() ? { prompt: incoming.prompt.trim() } : {}),
        ...(incoming.model?.trim() ? { model: incoming.model.trim() } : {}),
        ...(tools.allow || tools.deny ? { tools } : {}),
        ...(sanitizeList(incoming.skills) ? { skills: sanitizeList(incoming.skills) } : {}),
      };
      // Upsert in place so saving an existing agent keeps its position (and therefore its pill order).
      const list = this.customAgents();
      const index = list.findIndex(agent => agent.id === id);
      if (index >= 0) list[index] = entry;
      else list.push(entry);
      await this.saveCustomAgents(list);
      this.agentPromptCache.delete(id);
      this.post({ type: 'agents', agents: this.customAgents() });
      void this.sendPanel('agents');
      return;
    }
    if (message.type === 'deleteAgent') {
      const list = this.customAgents().filter(agent => agent.id !== message.id);
      await this.saveCustomAgents(list);
      this.agentPromptCache.delete(message.id);
      const fallback = AGENT_DEFINITIONS[0]!.id;
      let dirty = false;
      for (const project of this.projects) {
        for (const conversation of project.conversations) {
          if (conversation.agentId !== message.id) continue;
          conversation.agentId = fallback;
          conversation.updatedAt = Date.now();
          project.updatedAt = Date.now();
          dirty = true;
        }
      }
      if (this.context.globalState.get<string>('sleepycode.agentId', '') === message.id) {
        await this.context.globalState.update('sleepycode.agentId', fallback);
      }
      if (dirty) await this.persistProjects();
      this.post({ type: 'agents', agents: this.customAgents() });
      this.postConfig();
      void this.sendPanel('agents');
      return;
    }
    if (message.type === 'startReview') {
      // A review is its own read-only conversation scoped by the prompt, so the
      // scope the menu offers is the scope the agent reads. It used to be routed
      // to `reviewChanges`, which resolves the newest response's tracked files —
      // so "Uncommitted changes" reported "no workspace file changes were
      // recorded for this response" whenever the work came from an earlier chat.
      const project = this.ensureProjectForRoot();
      if (!project) {
        void vscode.window.showInformationMessage(adapter.noWorkspaceMessage());
        return;
      }
      const conversation = this.createConversation();
      conversation.title = String(message.title || 'Code review').slice(0, 100);
      // Ask mode is read-only, which is what the dialog promises.
      conversation.mode = 'ask';
      project.conversations.unshift(conversation);
      project.activeConversationId = conversation.id;
      project.updatedAt = Date.now();
      void this.persistProjects();
      this.syncConversations();
      await this.ensureCliSelection(conversation);
      await this.onMessage({ type: 'send', text: message.prompt, conversationId: conversation.id, mode: 'ask' } as WebMessage);
      return;
    }
    if (message.type === 'reviewChanges') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      const item = conversation?.items.find(entry => entry.id === message.itemId && entry.role === 'assistant');
      if (!item?.changes?.length) {
        void vscode.window.showInformationMessage('No workspace file changes were recorded for this response.');
        return;
      }
      try {
        await vscode.commands.executeCommand('workbench.view.scm');
      } catch {
        const first = item.changes.find(change => change.action !== 'Deleted');
        if (first) {
          try { await vscode.window.showTextDocument(this.resolveWorkspacePath(first.path)); } catch { }
        }
      }
      return;
    }
    if (message.type === 'gitReviewFile') {
      try { await this.reviewTaskFile(message.conversationId, message.itemId, message.path); }
      catch (error) { void vscode.window.showErrorMessage(`Could not open task diff: ${errorMessage(error)}`); }
      return;
    }
    if (message.type === 'gitRevertFile') {
      try { await this.revertTaskFile(message.conversationId, message.itemId, message.path); }
      catch (error) { void vscode.window.showErrorMessage(`Could not revert task file: ${errorMessage(error)}`); }
      return;
    }
    if (message.type === 'gitStageChanges') {
      try { await this.stageTaskChanges(message.conversationId, message.itemId, message.paths); }
      catch (error) { void vscode.window.showErrorMessage(`Could not stage task changes: ${errorMessage(error)}`); }
      return;
    }
    if (message.type === 'gitCommit') {
      try { await this.commitTaskChanges(message.conversationId, message.itemId); }
      catch (error) { void vscode.window.showErrorMessage(`Could not commit task changes: ${errorMessage(error)}`); }
      return;
    }
    if (message.type === 'reindexProject') {
      this.projectIndex.invalidate(this.workspaceRoot()?.fsPath);
      await this.ensureProjectIntelligence(true);
      return;
    }
    if (message.type === 'openFile') {
      try {
        const uri = this.resolveWorkspacePath(message.path);
        // A reference written as src/a.ts:42:7 should land the caret there, not at the top of the
        // file. Editor positions are zero-based and a written reference is one-based, so both are
        // decremented together; a reference with no line keeps the previous behaviour exactly.
        const options: vscode.TextDocumentShowOptions = {};
        if (message.line) {
          const row = Math.max(0, message.line - 1);
          const col = Math.max(0, (message.column ?? 1) - 1);
          options.selection = new vscode.Range(row, col, row, col);
        }
        await vscode.window.showTextDocument(uri, options);
      } catch (error) {
        vscode.window.showErrorMessage(errorMessage(error));
      }
      return;
    }
    if (message.type === 'chooseContext') {
      const root = this.workspaceRoot();
      if (!root) return;
      const chosen = await vscode.window.showOpenDialog({
        defaultUri: root,
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: 'Add context',
      });
      const attachments = [];
      for (const uri of chosen ?? []) {
        if (!pathInside(root.fsPath, uri.fsPath)) continue;
        const stat = await vscode.workspace.fs.stat(uri);
        attachments.push({
          kind: (stat.type & vscode.FileType.Directory) !== 0 ? 'folder' : 'file',
          path: path.relative(root.fsPath, uri.fsPath),
        });
      }
      this.post({ type: 'contextAttachments', attachments });
      return;
    }
    if (message.type === 'requestFilePicker') {
      const root = this.workspaceRoot();
      if (!root) return;
      const chosen = await vscode.window.showOpenDialog({
        defaultUri: root,
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: 'Add context',
      });
      const attachments: Attachment[] = [];
      for (const uri of chosen ?? []) {
        if (!pathInside(root.fsPath, uri.fsPath)) continue;
        const stat = await vscode.workspace.fs.stat(uri);
        attachments.push({
          kind: (stat.type & vscode.FileType.Directory) !== 0 ? 'folder' : 'file',
          path: path.relative(root.fsPath, uri.fsPath),
        });
      }
      this.post({ type: 'contextAttachments', attachments });
      return;
    }
    if (message.type === 'pasteImage') {
      if (!message.dataUrl.startsWith('data:image/') || message.size > 10_000_000) {
        void vscode.window.showWarningMessage('Images must be under 10 MB.');
        return;
      }
      const match = message.dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
      if (!match) return;
      const folder = await mkdtemp(path.join(tmpdir(), 'sleepycode-image-'));
      const extension = message.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      const filePath = path.join(folder, `pasted.${extension}`);
      await writeFile(filePath, Buffer.from(match[1]!, 'base64'));
      this.post({ type: 'contextAttachments', attachments: [{ kind: 'image', name: message.name || `pasted.${extension}`, size: message.size, mimeType: message.mimeType, tempPath: filePath, previewDataUrl: message.dataUrl }] });
      return;
    }
    if (message.type === 'dropFiles') {
      const root = this.workspaceRoot();
      if (!root) return;
      const attachments: Attachment[] = [];
      for (const rawPath of message.paths.slice(0, 16)) {
        const candidate = path.resolve(rawPath);
        if (!pathInside(root.fsPath, candidate)) continue;
        try {
          const uri = vscode.Uri.file(candidate);
          const stat = await vscode.workspace.fs.stat(uri);
          attachments.push({
            kind: (stat.type & vscode.FileType.Directory) !== 0 ? 'folder' : 'file',
            path: path.relative(root.fsPath, candidate),
          });
        } catch { }
      }
      this.post({ type: 'contextAttachments', attachments });
      return;
    }
    if (message.type === 'removeAttachment') {
      return;
    }
    if (message.type === 'fileMentionQuery') {
      const root = this.workspaceRoot();
      if (!root) return;
      const query = message.query.trim().toLowerCase();
      const index = this.projectIndex.snapshot?.root === root.fsPath ? this.projectIndex.snapshot : await this.ensureProjectIntelligence(false);
      if (index) {
        const ranked = query
          ? retrieveProjectContext(index, query, 20).map(hit => hit.path)
          : index.files.slice(0, 20).map(file => file.path);
        this.post({ type: 'fileMentionResults', results: ranked.map(filePath => ({ path: filePath, kind: 'file' as const })) });
        return;
      }
      const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out}/**', 40);
      const results = uris
        .map(uri => ({ path: path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/'), kind: 'file' as const }))
        .filter(item => !query || item.path.toLowerCase().includes(query))
        .slice(0, 20);
      this.post({ type: 'fileMentionResults', results });
      return;
    }
    if (message.type === 'openMemory') {
      const root = this.workspaceRoot();
      if (root) await openProjectMemory(root);
      return;
    }
    if (message.type === 'revealInOS') {
      const root = this.workspaceRoot();
      if (!root) {
        void vscode.window.showInformationMessage('Open a folder or workspace first.');
        return;
      }
      try {
        await vscode.commands.executeCommand('revealFileInOS', root);
      } catch {
        void vscode.window.showInformationMessage('Could not open the folder in your file explorer.');
      }
      return;
    }
    if (message.type === 'revealSkill') {
      const raw = (message.folder || '').trim();
      if (!raw || raw.includes('/') || raw.includes('\\') || raw === '.' || raw === '..') {
        void vscode.window.showInformationMessage('Invalid skill folder.');
        return;
      }
      const folderUri = vscode.Uri.joinPath(this.skillsRoot(), raw);
      try {
        const stat = await vscode.workspace.fs.stat(folderUri);
        if ((stat.type & vscode.FileType.Directory) === 0) throw new Error('not a folder');
      } catch {
        void vscode.window.showInformationMessage(`Skill '${raw}' is not installed.`);
        return;
      }
      let target = folderUri;
      for (const fileName of SKILL_FILE_NAMES) {
        const candidate = vscode.Uri.joinPath(folderUri, fileName);
        try {
          const stat = await vscode.workspace.fs.stat(candidate);
          if ((stat.type & vscode.FileType.File) !== 0) { target = candidate; break; }
        } catch { }
      }
      try {
        await vscode.commands.executeCommand('revealFileInOS', target);
      } catch {
        void vscode.window.showInformationMessage('Could not open the skill in your file explorer.');
      }
      return;
    }
    if (message.type === 'send' && message.text.trim()) {
      this.log('info', 'message.send.received', `conversation=${message.conversationId ?? '(active)'}; chars=${message.text.length}`);
      const previousActive = this.activeProjectId;
      const project = this.ensureProjectForRoot();
      if (!project) {
        // No folder: there is no project, no conversation and no run, so nothing
        // streamed and nothing was said. Explain it in the chat.
        this.log('warn', 'message.send.noWorkspace', 'no folder open');
        this.post({ type: 'error', conversationId: message.conversationId, text: adapter.noWorkspaceMessage() });
        void vscode.window.showInformationMessage('SleepyCode needs a folder open to work. Use File → Open Folder, then send again.');
        return;
      }
      if (previousActive !== project.id) this.syncConversations();
      let conversationId = message.conversationId || project.activeConversationId;
      if (!project.conversations.some(conversation => conversation.id === conversationId)) {
        const active = this.activeConversation();
        if (!active) {
          // Returning silently here meant a send produced no run, no stream and
          // no message: the message simply disappeared.
          this.log('error', 'message.send.noConversation', `asked=${conversationId || '(none)'}; project=${project.id}; conversations=${project.conversations.length}`);
          this.post({ type: 'error', text: 'This conversation is no longer open. Start a new chat and try again.' });
          return;
        }
        this.log('warn', 'message.send.recovered', `asked=${conversationId || '(none)'} -> ${active.id}`);
        conversationId = active.id;
      }
      // The React composer renders the user's turn immediately in a placeholder
      // session. Tell it which conversation the message really landed in, or the
      // optimistic turn is orphaned and the chat looks like it swallowed the text.
      if (this.reactMode && (message as { requestId?: string }).requestId) {
        this.post({
          type: 'requestAccepted',
          requestId: (message as { requestId?: string }).requestId,
          convId: conversationId,
          created: !message.conversationId,
        });
      }
      // The mode the composer was showing applies to this turn. Stamp it on the
      // conversation so the run, and any later turn in this chat, agree.
      if (message.mode) {
        const target = project.conversations.find(conversation => conversation.id === conversationId);
        if (target && target.mode !== message.mode) {
          target.mode = message.mode;
          await this.context.globalState.update('sleepycode.lastMode', message.mode);
          await this.persistProjects();
        }
      }
      const root = this.workspaceRoot();
      const mention = this.parseAgentMention(message.text);
      const sendText = mention.text.trim() || message.text.trim();

      const targetConversation = project.conversations.find(conversation => conversation.id === conversationId);
      const isContinuation = /^(?:continue|keep going|go on|please continue|continue from where you stopped|proceed|finish)\.?$/i.test(sendText.trim());
      if (isContinuation && targetConversation && !this.runs.has(conversationId)) {
        const resumeFrom = resumeFromLastAssistant(targetConversation.items);
        if (resumeFrom && (resumeFrom.resume.partialText || resumeFrom.resume.work?.length)) {
          const engine = await this.ensureEngine();
          if (this.cliOwns(targetConversation, engine)) {
            const resumed = await this.continueViaCli(conversationId, root);
            this.log('info', 'cli.continuation.send', `conversation=${conversationId}; resumed=${resumed}`);
            return;
          }
          targetConversation.items.pop();
          project.activeConversationId = targetConversation.id;
          project.updatedAt = Date.now();
          await this.persistProjects();
          this.syncConversations();
          await this.run(resumeFrom.userText, targetConversation.id, {
            work: resumeFrom.resume.work as WorkItem[] | undefined,
            errorText: resumeFrom.resume.message,
            changes: resumeFrom.resume.changes as FileChange[] | undefined,
            fileSnapshot: resumeFrom.resume.fileSnapshot as FileSnapshot[] | undefined,
            partialText: resumeFrom.resume.partialText,
            originalUserText: resumeFrom.userText,
          }, resumeFrom.resume.gitTree);
          return;
        }
      }

      if (mention.agentId) {
        await this.context.globalState.update('sleepycode.agentId', mention.agentId);
        this.agentPromptCache.clear();
        const target = project.conversations.find(conversation => conversation.id === conversationId);
        if (target && target.agentId !== mention.agentId) {
          target.agentId = mention.agentId;
          target.updatedAt = Date.now();
          project.updatedAt = Date.now();
          await this.persistProjects();
        }
        this.postConfig();
      }
      // The React composer sends its own attachment shape. Images arrive as data
      // URLs, so they are written to temp files here before the run reads them.
      // Named stages plus a watchdog: a preflight that never finishes used to
      // look like "nothing happens" with no evidence of where it stopped.
      const stage = this.beginSendStage(conversationId);
      stage('attachments');
      const composerContext = await this.withReactAttachments(message);
      stage('editor-context');
      const editorContext = root ? await this.composerContextBlock(root, composerContext) : '';
      stage('project-context');
      const projectContext = root && composerContext?.includeProjectIndex !== false ? await this.projectContextBlock(root, sendText) : '';
      stage('engine');
      const promptContext = [editorContext, projectContext].filter(Boolean).join('\n\n');

      // The CLI owns the loop, tools, permissions, and history for a conversation
      // that has none of its own yet, so the local ToolLoopAgent must not also
      // run this send. A chat with leftover local history stays local instead.
      const engine = await this.ensureEngine();
      stage('dispatch');
      const sending = project.conversations.find(conversation => conversation.id === conversationId);
      if (sending && this.cliOwns(sending, engine)) {
        void this.sendViaCli(conversationId, sendText, root).catch(error => {
          const detail = errorMessage(error);
          this.log('error', 'cli.send.unhandled', detail);
          this.post({ type: 'error', conversationId, text: detail });
        });
        return;
      }

      stage('done');
      if (this.runs.has(conversationId) || this.runs.size >= MAX_CONCURRENT_RUNS) {
        this.log('info', 'message.send.queued', `conversation=${conversationId}; activeRuns=${this.runs.size}`);
        this.enqueue(sendText, conversationId, composerContext, promptContext);
      } else {
        this.log('info', 'message.send.starting', `conversation=${conversationId}; contextChars=${promptContext.length}`);
        void this.run(sendText, conversationId, undefined, undefined, composerContext, promptContext).catch(error => {
          const detail = errorMessage(error);
          this.log('error', 'run.unhandled', detail);
          // The user turn is persisted before the run starts, so a failure escaping the
          // run left a turn that nothing ever answered. Both the streamed partial text
          // and this error lived only in the DOM, so a reload erased the evidence. Persist
          // a structured error instead, which renders with a retry action and survives.
          const conversation = this.findConversation(conversationId);
          if (conversation) {
            const errorItem = createTranscriptItem('assistant', detail, 'error');
            errorItem.errorInfo = classifyAgentError(error);
            errorItem.errorInfo.retryable = true;
            conversation.items.push(errorItem);
            this.boundConversationItems(conversation);
            conversation.updatedAt = Date.now();
            void this.persistProjects();
          }
          this.post({ type: 'error', conversationId, text: detail, keepTurn: true });
          this.runs.delete(conversationId);
          this.post({ type: 'state', conversationId, running: false, label: '' });
        });
      }
      return;
    }
    if (message.type === 'retryMessage') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      // The CLI resumes the interrupted assistant by id. Retrying there must not
      // pop a local item or resend text as a new user turn.
      if (this.cliOwns(conversation, this.engineStatus)) {
        const resumed = await this.continueViaCli(message.conversationId);
        this.log('info', 'cli.retry.requested', `conversation=${message.conversationId}; resumed=${resumed}`);
        return;
      }
      const resumeFrom = resumeFromLastAssistant(conversation.items);
      if (!resumeFrom) return;
      conversation.items.pop();
      project.activeConversationId = conversation.id;
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      await this.run(resumeFrom.userText, conversation.id, {
        work: resumeFrom.resume.work as WorkItem[] | undefined,
        errorText: resumeFrom.resume.message,
        changes: resumeFrom.resume.changes as FileChange[] | undefined,
        fileSnapshot: resumeFrom.resume.fileSnapshot as FileSnapshot[] | undefined,
        partialText: resumeFrom.resume.partialText,
        originalUserText: resumeFrom.userText,
      }, resumeFrom.resume.gitTree);
      return;
    }
    if (message.type === 'continueIteration') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      const last = conversation.items[conversation.items.length - 1];
      if (!last?.paused || last.id !== message.itemId) return;
      // A paused card on a CLI-owned conversation is a projection of an
      // unfinished CLI assistant row, so continuing belongs to the CLI too:
      // resuming locally would replay the turn against a transcript the CLI
      // still holds. The CLI resolves its own resume target from sleepy.db.
      if (this.cliOwns(conversation, this.engineStatus)) {
        const resumed = await this.continueViaCli(message.conversationId);
        this.log('info', 'cli.continue.requested', `conversation=${message.conversationId}; resumed=${resumed}`);
        return;
      }
      // Continuing a paused iteration pops the item and re-runs it with the
      // local agent.
      const resumeFrom = resumeFromLastAssistant(conversation.items);
      if (!resumeFrom) return;
      const truncatedPause = last.pauseReason === 'max_tokens';
      const pausePlaceholder = truncatedPause
        ? '(Response reached the model output limit before producing text.)'
        : `Iteration paused after reaching the ${last.pauseLimit ?? this.config().maxSteps}-step limit.`;
      conversation.items.pop();
      project.activeConversationId = conversation.id;
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      await this.run(resumeFrom.userText, conversation.id, {
        work: last.work,
        changes: last.changes,
        fileSnapshot: last.fileSnapshot,
        errorText: truncatedPause
          ? 'The previous response reached the model output limit and is incomplete. Continue from where it stopped, finishing only what remains.'
          : `The previous iteration paused after reaching its ${last.pauseLimit ?? this.config().maxSteps}-step limit. Continue only the unfinished work.`,
        partialText: last.text.trim() && last.text !== pausePlaceholder ? last.text : last.partialText,
        originalUserText: resumeFrom.userText,
      }, last.gitTree);
      return;
    }
  }

  private enqueue(text: string, conversationId: string, context?: ComposerContext, promptContext?: string): void {
    // Multiple follow-ups may be queued for the same conversation; they run in FIFO order.
    this.queue.push({ id: `q${++this.queueSeq}`, text, conversationId, context, promptContext });
    this.postWorkflow(conversationId);
  }

  /**
   * Publish the whole workflow state — queued prompts and goals, for every
   * conversation.
   *
   * React REPLACES both maps from the one `workflowState` message, so a partial
   * publish is a delete: sending a goal emptied every queued row, and sending the
   * queue called `setGoals(undefined)` and dropped the goal banner. The classic
   * webview reads one conversation at a time, so it keeps the two narrow
   * messages.
   */
  private postWorkflow(conversationId?: string): void {
    if (!this.reactMode) {
      const entries = this.queue.filter(item => item.conversationId === conversationId);
      this.post({ type: 'queuedPrompt', conversationId, prompts: entries.map(entry => entry.text), ids: entries.map(entry => entry.id) });
      const active = this.activeProject()?.conversations.find(item => item.id === conversationId);
      if (active) this.postGoal(active);
      return;
    }
    const queues: Record<string, { id: string; text: string }[]> = {};
    for (const entry of this.queue) (queues[entry.conversationId] ??= []).push({ id: entry.id, text: entry.text });
    const goals: Record<string, unknown> = {};
    for (const conversation of this.activeProject()?.conversations ?? []) {
      if (conversation.goal) goals[conversation.id] = conversation.goal;
    }
    this.post({ type: 'workflow', queues, goals });
  }

  private async run(userText: string, conversationId: string, resume?: { work?: WorkItem[]; errorText?: string; changes?: FileChange[]; fileSnapshot?: FileSnapshot[]; partialText?: string; originalUserText?: string }, carryTree?: string, composerContext?: ComposerContext, preparedPromptContext?: string, userAlreadyPersisted = false): Promise<void> {
    this.log('info', 'run.enter', `conversation=${conversationId}; chars=${userText.length}`);
    const root = this.workspaceRoot();
    if (!root) {
      this.post({ type: 'error', text: adapter.noWorkspaceMessage() });
      return;
    }
    const project = this.ensureProjectForRoot();
    if (!project) {
      this.post({ type: 'error', text: adapter.noWorkspaceMessage() });
      return;
    }
    const promptContext = resume ? '' : preparedPromptContext ?? await this.composerContextBlock(root, composerContext);

    let conversation = project.conversations.find(item => item.id === conversationId);
    if (!conversation) {
      conversation = this.createConversation();
      project.conversations.unshift(conversation);
      conversationId = conversation.id;
    }
    const historyUserText = resume ? (resume.originalUserText || userText) : userText;
    const gitTracked = isGitTrackedWorkspace(root.fsPath);
    const run: ActiveRun = { conversationId, controller: new AbortController(), steering: false };
    this.runs.set(conversationId, run);
    this.log('info', 'run.registered', conversationId);
    // A pre-turn Git tree captures every workspace mutation, including files
    // changed by shell commands that do not emit the edit tools' `changed`
    // event. This is the authoritative undo checkpoint for tracked projects.
    let runGitTree = gitTracked ? carryTree : undefined;
    if (gitTracked && !runGitTree) {
      const versionAtSend = this.fsVersion;
      if (this.lastGitTree?.root === root.fsPath && this.lastGitTree.version === versionAtSend) {
        // Workspace unchanged since the last capture: reuse the tree instead of
        // running `git add -A` again.
        runGitTree = this.lastGitTree.tree;
      } else {
        // Capture the undo checkpoint without blocking send: `runGitTree` is only
        // consumed after the stream (undo checkpointing and post-run diffs), never on
        // the first-byte path. Awaiting it here made every send wait on `git add -A`.
        void captureGitTree(root.fsPath, { signal: run.controller.signal, timeoutMs: 15_000 })
          .then(tree => {
            runGitTree = tree;
            this.lastGitTree = { root: root.fsPath, tree, version: versionAtSend };
          })
          .catch(error => this.log('warn', 'run.checkpoint.unavailable', errorMessage(error)));
      }
    }
    // Only steering carries this turn's original checkpoint into the replacement
    // prompt. Ordinary queued follow-ups are new turns and must capture the
    // workspace as it exists after this one.
    let carriedGitTree: string | undefined;
    if (resume) {
      this.post({ type: 'resume', conversationId, partialText: resume.partialText ?? '' });
    } else if (!userAlreadyPersisted) {
      clearForwardStacks(conversation);
      const userItem = createTranscriptItem('user', userText);
      userItem.attachments = composerContext?.attachments;
      conversation.items.push(userItem);
      if (conversation.items.length === 1) conversation.title = conversationTitle(userText);
      this.post({ type: 'user', conversationId, item: userItem });
      this.notifyHooks('onMessage', { text: userText });
    } else {
      this.notifyHooks('onMessage', { text: userText });
    }
    conversation.updatedAt = Date.now();
    project.updatedAt = Date.now();
    // Fire-and-forget: the user message is already in-memory and visible in the webview.
    // Awaiting the persist chain here blocked every send on the previous turn's write
    // (often several seconds of globalState I/O for a large conversation).
    void this.persistProjects();
    this.syncConversations(false);
    this.post({ type: 'state', conversationId, running: true, label: 'Thinking' });

    const work: WorkItem[] = resume ? [...(resume.work ?? [])] : [];
    const runChanges = new Map<string, FileChange>((resume?.changes ?? []).map(change => [change.path, change]));
    // Written after each completed iteration so an interrupted run is recoverable.
    let runMessages: ModelMessage[] = [];
    const snapshotByPath = new Map<string, FileSnapshot>((resume?.fileSnapshot ?? []).map(snap => [snap.path, snap]));
    const postToolEvent = (message: unknown): void => {
      if (!message || typeof message !== 'object') {
        this.post(message);
        return;
      }
      const record = message as Record<string, unknown>;
      let next: Record<string, unknown> = { ...record, conversationId: record.conversationId ?? conversationId };
      if (record.type === 'changed' && typeof record.path === 'string') {
        try {
          const uri = this.resolveWorkspacePath(record.path);
          if (!pathInside(root.fsPath, uri.fsPath)) return;
          const relative = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
          const action: FileChange['action'] = record.action === 'Created' || record.action === 'Deleted' ? record.action : 'Modified';
          const previous = runChanges.get(relative);
          if (previous?.action === 'Created' && action === 'Deleted') {
            runChanges.delete(relative);
            snapshotByPath.delete(relative);
            next = { ...next, path: relative, action, additions: 0, deletions: 0, preview: [] };
          } else {
            if (!snapshotByPath.has(relative)) {
              snapshotByPath.set(relative, captureFileSnapshot(root.fsPath, relative, record.before, action !== 'Created'));
            }
            const snapshot = snapshotByPath.get(relative);
            const beforeText = typeof record.before === 'string'
              ? record.before
              : (snapshot?.existed ? snapshot.content : '');
            const afterText = action === 'Deleted'
              ? ''
              : (typeof record.after === 'string' ? record.after : readWorkspaceText(root.fsPath, relative));
            const live = fileChangeStats(beforeText, afterText);
            const net = fileChangeStats(snapshot?.existed ? snapshot.content : '', afterText);
            const mergedAction: FileChange['action'] = previous?.action === 'Created' ? 'Created' : action;
            runChanges.set(relative, {
              path: relative,
              action: mergedAction,
              staged: previous?.staged,
              reverted: previous?.reverted,
              additions: net.additions,
              deletions: net.deletions,
              preview: net.preview,
            });
            next = { ...next, path: relative, action, additions: live.additions, deletions: live.deletions, preview: live.preview };
          }
        } catch {
          return;
        }
      }
      this.post(next);
      if (record.type === 'changed') updatePending(true);
    };
    const activeTasks = new Map<string, WorkItem>();
    // Tool start timestamps, so the card can show a real duration instead of nothing. Scoped to the
    // run: a map that outlived it would leak one entry per tool call for the session's lifetime.
    const toolStartedAt = new Map<string, number>();
    const reasoningLimit = this.config().maxPersistedReasoning;
    let reasoningBuffer = '';
    // Longest streamed text before an interruption; preserved on error items so
    // a manual retry can continue from the halfway point instead of restarting.
    let partialAnswer = '';
    let workStartedAt = 0;
    let planItem: WorkItem | undefined;
    let planState: PlanState | undefined;
    // Seeded with an empty connection so the run path always has a usable
    // object; every branch below replaces it with a real one when it can.
    let mcpConnection: McpConnection = emptyMcpConnection();
    let mcpCached = false;
    // Keep the in-progress record durable while text is streaming and whenever
    // a tool starts/finishes or changes a file. Completed SDK response messages
    // are merged by onStepFinish below, so tool calls/results survive a later
    // server interruption as model-visible history too.
    const updatePending = (force = false): void => {
      conversation.pending = {
        userText: historyUserText,
        messages: runMessages.slice(),
        startedAt: workStartedAt || Date.now(),
        partialText: (partialAnswer || resume?.partialText) || undefined,
        work: work.slice(-80),
        changes: [...runChanges.values()],
        fileSnapshot: [...snapshotByPath.values()],
        gitTree: runGitTree,
      };
      void this.checkpointConversation(conversation, force);
    };
    const completeRunChanges = async (): Promise<FileChange[]> => {
      if (gitTracked && runGitTree) {
        try {
          const postTree = await captureGitTree(root.fsPath, { timeoutMs: 15_000 });
          const treeChanges = await gitTreeChanges(root.fsPath, runGitTree, postTree);
          if (treeChanges.length) return treeChanges.map(change => ({ ...change, preview: runChanges.get(change.path)?.preview }));
        } catch (error) {
          this.log('warn', 'run.changes.unavailable', errorMessage(error));
        }
      }
      return [...runChanges.values()];
    };
    const describePlan = (): string => {
      const current = planState;
      if (!current) return 'No plan yet: call the plan tool with title and steps to create one.';
      if (!current.steps.length) return `Current plan: ${current.title}`;
      const lines = current.steps.map((step, index) => {
        const status = current.done.has(index) ? 'done' : index === current.active ? 'current' : 'pending';
        return `${index}. [${status}] ${step}`;
      });
      return `Current plan (${current.title}):\n${lines.join('\n')}`;
    };
    const postPlan = (): void => {
      if (!planState) return;
      const allDone = planState.done.size === planState.steps.length;
      if (planItem) {
        planItem.doneSteps = [...planState.done].sort((a, b) => a - b);
        planItem.activeStep = allDone ? -1 : planState.active;
        planItem.interrupted = planState.interrupted;
        planItem.done = allDone;
      }
      this.post({
        type: 'plan', conversationId, title: planState.title, steps: planState.steps,
        activeStep: allDone ? -1 : planState.active,
        doneSteps: [...planState.done].sort((a, b) => a - b),
        done: allDone,
        interrupted: planState.interrupted,
      });
    };
    const finalizePlan = (): void => {
      if (!planState) return;
      planState.done = new Set(planState.steps.map((_, index) => index));
      planState.active = -1;
      planState.manual = true;
      postPlan();
    };
    if (resume) {
      const priorPlan = [...work].reverse().find(item => item.kind === 'plan');
      if (priorPlan) {
        const steps = priorPlan.steps ?? [];
        const done = new Set<number>((priorPlan.doneSteps ?? []).filter(index => Number.isInteger(index)));
        let active = Number.isInteger(priorPlan.activeStep) && (priorPlan.activeStep ?? -1) >= 0 ? (priorPlan.activeStep as number) : 0;
        if (active >= steps.length) active = -1;
        planState = { title: priorPlan.title ?? 'Plan', steps, active, done, manual: Boolean(priorPlan.manual), interrupted: false };
        planItem = priorPlan;
        planItem.done = done.size === steps.length && steps.length > 0;
        planItem.doneSteps = [...done].sort((a, b) => a - b);
        planItem.activeStep = active;
        planItem.interrupted = false;
        planItem.manual = planState.manual;
        postPlan();
      }
    }
    if (await this.ensureSelectedAgent()) {
      // Fire-and-forget: agent fallback is already applied in-memory.
      void this.persistProjects();
    }
    const conversationAgent = this.agentConfig(conversation.agentId ?? this.config().agentId);
    const selection = this.selectionFor(conversation);
    // Resolved once, here, and used for the prompt, the run's tools and every
    // subagent's tools. Resolving it twice is how the UI and the run disagree.
    const runMode = modeRules.resolveRunMode({
      conversationMode: conversation.mode,
      lastMode: this.context.globalState.get<string>('sleepycode.lastMode'),
    });
    this.log('info', 'run.mode', `${runMode} (conversation=${conversation.mode ?? 'unset'})`);
    if (!conversation.model && conversationAgent?.model && !resume) {
      selection.model = conversationAgent.model;
      this.post({ type: 'modelRoute', conversationId, requested: conversationAgent.model, model: conversationAgent.model, reason: `${conversationAgent.name} agent model` });
    }
    const providerConfig = getProvider(this.getProviders(), selection.provider) ?? this.getProviders()[0];
    let reconnectAttempt = 0;
    let model = selection.model;
    try {
      this.log('info', 'run.preflight.start', `conversation=${conversationId}; provider=${providerConfig?.id ?? '(none)'}`);
      if (!providerConfig) throw new Error('No active provider configured. Open Settings and select SleepyAI or an explicitly configured compatibility provider.');
      // Automatic Git snapshots used to run here. Even fire-and-forget filesystem
      // calls can synchronously block a VS Code filesystem provider before yielding
      // a Promise, which prevents both chat requests and Stop. Keep send preflight
      // free of workspace scans; file snapshots still protect individual edits.
      let { maxSteps } = this.config();
      let configuredModel = selection.model;
      if (!configuredModel) {
        await this.refreshModels();
        configuredModel = this.selectionFor(conversation).model;
        if (!configuredModel) throw new Error('No model is selected. Choose a model from the composer and retry.');
      }
      model = configuredModel;
      const { apiKey, baseUrl } = this.providerCredentials(providerConfig);
      if (configuredModel === SLEEPY_AUTO_MODEL_ID) {
        if (!this.resolveAutoModel(providerConfig.id)) await this.refreshModels();
        const route = this.resolveAutoModel(providerConfig.id);
        if (!route) throw new Error('SleepyAI Auto could not find an eligible model. Refresh models or choose a model manually.');
        model = route.id;
        this.post({ type: 'modelRoute', conversationId, requested: SLEEPY_AUTO_MODEL_ID, model, reason: route.reason });
      }
      // The send budget has to follow the window of the model that will actually run.
      // Resolving it from the unresolved id (or before `refreshModels` filled the
      // catalog) is how a 1M-window model was budgeted at the 60k fallback and dropped
      // hundreds of stored messages per request.
      const modelInfo = this.getEffectiveModelInfo(selection.provider, model);
      // The single retry budget for this turn. The request layer below and the
      // run loop after it both draw from it, so retries can no longer multiply
      // per layer, and both report the same attempt numbering.
      const retryBudget = createRetryBudget();
      let sleepyToken: string | undefined;
      if (providerConfig.isSleepy) {
        this.log('info', 'run.auth.start', providerConfig.id);
        sleepyToken = getSleepyTokenSync() ?? (await abortableTimeout(getSleepyToken(), 15_000, run.controller.signal, 'SleepyAI authentication')) ?? undefined;
        this.log('info', 'run.auth.done', providerConfig.id);
        if (!sleepyToken) throw new Error('SleepyAI session is missing or expired. Sign in again from Settings.');
      }
      const provider = createOpenAICompatible({
        name: providerConfig.id,
        baseURL: baseUrl,
        ...(apiKey ? { apiKey } : {}),
        headers: {
          ...providerConfig.customHeaders,
          ...(sleepyToken ? { Authorization: `Bearer ${sleepyToken}` } : {}),
        },
        fetch: async (input, init) => {
          const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET') ?? 'GET').toUpperCase();
          const replayable = method === 'GET' || method === 'HEAD';
          const headersAtSend = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
          // A request carries the token captured in the headers closure at send time.
          // After a rotation the same Request object would keep replaying the rejected
          // token, so rebuild it (and the message-carrying init) with the new header.
          const withAuthorization = (bearer: string): { input: typeof input; init: typeof init } => {
            const authHeaders = new Headers(headersAtSend);
            authHeaders.set('Authorization', `Bearer ${bearer}`);
            if (typeof Request !== 'undefined' && input instanceof Request) {
              input = new Request(input, { headers: authHeaders });
            }
            init = { ...(init ?? {}), headers: authHeaders };
            return { input, init };
          };
          const report = (attempt: number, max: number, errorMsg: string, backoffMs: number): void => {
            reconnectAttempt = attempt;
            this.post({ type: 'retry', conversationId, attempt, max, error: errorMsg, backoffMs });
          };
          const endReport = (ok: boolean): void => {
            if (!reconnectAttempt) return;
            const attempt = reconnectAttempt;
            reconnectAttempt = 0;
            this.post({ type: 'retryEnd', conversationId, ok, attempt, max: retryBudget.max });
          };
          for (; ;) {
            try {
              const requestInput = typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
              const response = await fetch(requestInput, init);
              // Every retryable status is judged by the shared policy: a rejected
              // credential is recovered by rotating the token, a 404 on a read waits
              // for the edge to settle, and 408/409/429/5xx backs off. When the turn's
              // budget is spent the response is surfaced untouched, so the error card
              // reflects the real failure instead of a synthetic "logged out".
              const kind = retryKindForStatus(response.status, { replayable, isFirstParty: providerConfig.isSleepy });
              if (!kind) {
                // The exchange completed, so the retry streak starts over: a later
                // failure in this same turn gets the full budget again instead of
                // inheriting what an earlier flaky request already spent.
                retryBudget.succeed();
                if (response.ok) endReport(true);
                return response;
              }
              let renewed: string | null = null;
              if (kind === 'auth') renewed = await refreshSleepyToken().catch(() => null);
              const decision = retryBudget.take(kind, retryMessage({ kind, status: response.status, detail: response.statusText || 'Server error', recovered: Boolean(renewed) }));
              // Budget spent: surface the response exactly as the gateway sent it, so
              // the error card names the real status instead of a recovery message.
              if (!decision) return response;
              this.log('warn', `run.retry.${decision.kind}`, `status=${response.status}; attempt=${decision.attempt}/${decision.max}; renewed=${Boolean(renewed)}`);
              report(decision.attempt, decision.max, decision.message, decision.backoffMs);
              if (renewed) withAuthorization(renewed);
              await waitForRetry(decision.backoffMs, run.controller.signal);
            } catch (error) {
              // A transport failure is transient by definition. An aborted run is not.
              if (run.controller.signal.aborted) throw error;
              const decision = retryBudget.take('transient', retryMessage({ kind: 'transient', detail: errorMessage(error) }));
              if (!decision) throw error;
              this.log('warn', 'run.retry.transient', `attempt=${decision.attempt}/${decision.max}; ${decision.message}`);
              report(decision.attempt, decision.max, decision.message, decision.backoffMs);
              await waitForRetry(decision.backoffMs, run.controller.signal);
            }
          }
        },
      });

      // Skills and project memory are loaded on demand by tools. Do not touch a
      // filesystem provider before the first /chat/completions request.
      const skillBlock = '';
      const projectMemory = '';
      this.log('info', 'run.fastlane.ready', 'automatic scans disabled');
      const rawMcpServers = this.config().mcpServers;
      let savedLoadError = '';
      const savedConnections = await loadMcpConnections(this.context).catch(error => {
        savedLoadError = `Saved MCP connections could not be read: ${errorMessage(error)}`;
        this.log('error', 'run.mcp.load.failed', errorMessage(error));
        return [] as McpConnectionData[];
      });
      const mcpKey = JSON.stringify({
        legacy: rawMcpServers,
        saved: savedConnections.map(connection => ({ name: connection.name, url: connection.url, transport: connection.transport, enabled: connection.enabled, auth: connection.auth })),
      });
      if (this.mcpCache?.key === mcpKey) {
        mcpConnection = this.mcpCache.connection;
        mcpCached = true;
        this.log('info', 'run.mcp.cached', 'reusing cached MCP connection');
      } else {
        this.log('info', 'run.mcp.legacy.start', rawMcpServers.trim() && rawMcpServers.trim() !== '{}' ? 'configured' : 'none');
        const baseConnection = rawMcpServers.trim() && rawMcpServers.trim() !== '{}'
          ? await Promise.race([
            connectMcpServers(rawMcpServers, root.fsPath, (title, detail) => this.approve('command', title, detail), mcpHost(this.context)).catch(error => emptyMcpConnection([`MCP configuration: ${errorMessage(error)}`])),
            new Promise<McpConnection>(resolve => setTimeout(() => resolve(emptyMcpConnection(['MCP servers did not finish connecting within 10s.'])), 10_000)),
          ])
          : emptyMcpConnection();
        this.log('info', 'run.mcp.legacy.done');
        this.log('info', 'run.mcp.connections', `legacy=${this.config().mcpServers !== '{}'}; saved=${savedConnections.length}; enabled=${savedConnections.filter(connection => connection.enabled).length}`);
        if (savedConnections.some((c) => c.enabled)) {
          this.log('info', 'run.mcp.saved.start');
          const extra = await Promise.race([
            connectToMcpConnections(savedConnections, this.context, (title, detail) => this.approve('command', title, detail)),
            new Promise<{ connection: McpConnection; statuses: McpConnectionStatus[] }>(resolve => setTimeout(() => resolve({ connection: emptyMcpConnection(['Saved MCP timed out']), statuses: [] }), 10_000)),
          ]);
          this.log('info', 'run.mcp.saved.done');
          mcpConnection = {
            tools: { ...baseConnection.tools, ...extra.connection.tools },
            instructions: [...baseConnection.instructions, ...extra.connection.instructions],
            errors: [...baseConnection.errors, ...extra.connection.errors],
            toolCounts: { ...baseConnection.toolCounts, ...extra.connection.toolCounts },
            toolNames: { ...baseConnection.toolNames, ...extra.connection.toolNames },
            authStates: { ...baseConnection.authStates, ...extra.connection.authStates },
            // Resources are looked up by server name, so the merged view asks
            // each side and takes whichever knows the server.
            listResources: async (serverName: string) => {
              const fromBase = await baseConnection.listResources(serverName).catch(() => []);
              if (fromBase.length) return fromBase;
              return extra.connection.listResources(serverName).catch(() => []);
            },
            readResource: async (serverName: string, uri: string) => {
              const fromBase = await baseConnection.readResource(serverName, uri).catch(() => '');
              if (fromBase) return fromBase;
              return extra.connection.readResource(serverName, uri).catch(() => '');
            },
            close: async () => {
              await Promise.allSettled([baseConnection.close(), extra.connection.close()]);
            },
          };
        } else {
          mcpConnection = baseConnection;
        }
        if (savedLoadError) mcpConnection.errors.push(savedLoadError);
        this.closeMcpCache();
        if (mcpConnection.errors.length === 0) {
          this.mcpCache = { key: mcpKey, connection: mcpConnection };
          mcpCached = true;
        }
      }
      if (mcpConnection.errors.length) {
        // A server that fails to connect used to leave one line buried in the
        // system prompt, so "MCP is not working" had no visible cause. Say it
        // once per distinct failure instead of every turn.
        const signature = mcpConnection.errors.join('\n');
        if (this.mcpNoticeSignatures.get(conversationId) !== signature) {
          this.mcpNoticeSignatures.set(conversationId, signature);
          this.post({ type: 'contextNotice', conversationId, kind: 'mcp', text: `MCP: ${mcpConnection.errors.join(' · ')}` });
        }
      } else {
        this.mcpNoticeSignatures.delete(conversationId);
      }
      const instructions = [
        modeRules.modeGuidance(runMode),
        goalCore.goalGuidance(conversation.goal),
        await this.systemPrompt(root, selection.agentId),
        projectMemory ? `Durable project memory from ${MEMORY_RELATIVE_PATH}:\n${projectMemory}` : '',
        `- Skills: installed skill metadata is listed below. Treat it as a discoverable capability inventory. Use skillsmp_list_installed when you need the authoritative current list. If the user invokes /skill, names a skill, or the task clearly matches an installed skill description, call skillsmp_read_installed before planning or acting and follow that local SKILL.md within SleepyCode safety rules. Use skillsmp_search / skillsmp_get_skill / skillsmp_install_skill only when the user needs a skill that is not already installed.`,
        mcpConnection.instructions.length ? `Connected MCP server instructions:\n${mcpConnection.instructions.join('\n')}` : '',
        mcpConnection.errors.length ? `Some configured MCP servers could not connect:\n- ${mcpConnection.errors.join('\n- ')}` : '',
        skillBlock,
      ].filter(Boolean).join('\n\n');
      const memoryAccess = {
        path: MEMORY_RELATIVE_PATH,
        read: () => readProjectMemory(root),
        write: async (content: string, reason?: string) => {
          const before = await readProjectMemory(root);
          await this.reviewEdit(MEMORY_RELATIVE_PATH, before, content, reason ?? 'Store durable project context for future conversations.');
          await writeProjectMemory(root, content);
        },
      };
      // Never scan the repository synchronously during send. Reuse a cache if one
      // already exists (e.g. from the explicit Index panel), otherwise omit tools.
      const repoIndex = this.repoIndexCache?.root === root.fsPath ? this.repoIndexCache.index : undefined;
      const repoMemory = repoIndex ? this.loadRepoMemory(root) : undefined;
      this.log('info', 'run.preflight.ready', `conversation=${conversationId}; indexedFiles=${repoIndex?.files.length ?? 0}`);

      const delegate = async (role: 'explorer' | 'reviewer' | 'worker', task: string, context?: string): Promise<string> => {
        const cleanTask = task.trim();
        if (!cleanTask) throw new Error('Subagent task cannot be empty.');
        const subagentId = `subagent-${Date.now().toString(36)}-${(++this.subagentSequence).toString(36)}`;
        const subagentAbort = new AbortController();
        this.subagentControllers.set(subagentId, subagentAbort);
        // Linked, not replaced: cancelling the run must still cancel every
        // subagent it started.
        const linkRunAbort = () => subagentAbort.abort();
        run.controller.signal.addEventListener('abort', linkRunAbort, { once: true });
        const releaseSubagent = () => {
          run.controller.signal.removeEventListener('abort', linkRunAbort);
          this.subagentControllers.delete(subagentId);
        };
        const subagentPost = (message: unknown): void => {
          if (!message || typeof message !== 'object') {
            postToolEvent(message);
            return;
          }
          postToolEvent({ ...(message as Record<string, unknown>), parentId: subagentId, subagentRole: role });
        };
        const subagentTools = buildTools({
          root,
          skillsDir: this.skillsRoot(),
          config: () => this.config(),
          approve: (kind, title, detail, destructive, approvalKey) => this.approve(kind, title, detail, destructive, approvalKey, conversationId),
          reviewEdit: (filePath, before, after, reason, destructive) => this.reviewEdit(filePath, before, after, reason, destructive, conversationId),
          post: subagentPost,
          resolvePath: filePath => this.resolveWorkspacePath(filePath),
          observationsDir: () => this.observationsRoot(),
          describePlan: () => 'Subagents do not publish a parent plan. Work directly on the assigned task.',
          abortSignal: run.controller.signal,
          terminals: this.terminals,
          memory: memoryAccess,
        });
        // A subagent may not exceed its parent. Permissions flow down only: a
        // worker in a read-only run gets no write tools, which is the difference
        // between "the model was told not to" and "the tool is not there".
        const roleTools = role === 'worker'
          ? subagentTools
          : Object.fromEntries(Object.entries(subagentTools).filter(([name]) => !modeRules.isMutatingTool(name)));
        delete roleTools.delegate_task;
        // Run-only grants are stripped by the subagent ceiling: a subagent has no
        // plan to save, and the grant must not flow down.
        const ceiling = modeRules.applySubagentCeiling(roleTools, runMode);
        if (runMode !== 'agent') {
          const dropped = modeRules.withheldByCeiling(roleTools, runMode);
          this.log('info', 'subagent.ceiling', `${role} in ${runMode}: withheld ${dropped.length} (${dropped.join(',')})`);
        }
        const subagentToolSetBase = filterAgentTools(ceiling as Record<string, any>, conversationAgent?.tools);
        const roleInstruction = role === 'explorer'
          ? 'Research the repository read-only. Return findings with precise workspace-relative file paths and line references.'
          : role === 'reviewer'
            ? 'Review independently and read-only. Look for correctness, regressions, security issues, and missing verification. Return only actionable findings or state that none were found.'
            : 'Complete the bounded implementation or verification task. Inspect before editing, preserve unrelated changes, and verify the result.';
        const label = `Subagent (${role}): ${cleanTask.slice(0, 96)}${cleanTask.length > 96 ? '…' : ''}`;
        this.post({ type: 'subagent', conversationId, id: subagentId, role, task: cleanTask, name: label, phase: 'start' });
        const subagentInstructions = [
          modeRules.subagentGuidance(runMode),
          await this.systemPrompt(root, selection.agentId),
          `You are a ${role} subagent. ${roleInstruction}`,
          'You have an isolated context window. The parent conversation is not available unless context is explicitly included below.',
          'Do not delegate further. The delegate_task tool is intentionally unavailable.',
          projectMemory ? `Durable project memory:\n${projectMemory}` : '',
          role === 'worker' && mcpConnection?.instructions.length ? `Connected MCP instructions:\n${mcpConnection.instructions.join('\n')}` : '',
          skillBlock,
        ].filter(Boolean).join('\n\n');
        const subagentModelId = this.subagentModels()[role] || model;
        let subagentProvider = provider;
        let subagentProviderId = providerConfig.id;
        if (subagentModelId && subagentModelId !== model) {
          const targetGroup = this.lastModelGroups.find(group => (group.models ?? []).some(m => (typeof m === 'string' ? m : m.id) === subagentModelId));
          if (targetGroup && targetGroup.providerId !== providerConfig.id) {
            const targetProviderConfig = getProvider(this.getProviders(), targetGroup.providerId);
            if (targetProviderConfig) {
              const creds = this.providerCredentials(targetProviderConfig);
              let token: string | undefined;
              if (targetProviderConfig.isSleepy) token = getSleepyTokenSync() ?? (await getSleepyToken()) ?? undefined;
              subagentProvider = createOpenAICompatible({
                name: targetProviderConfig.id,
                baseURL: creds.baseUrl,
                ...(creds.apiKey ? { apiKey: creds.apiKey } : {}),
                headers: {
                  ...targetProviderConfig.customHeaders,
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              });
              subagentProviderId = targetProviderConfig.id;
            }
          }
        }
        // MCP tools are gated too: an MCP server can write files.
        const mcpForRole = role === 'worker' ? modeRules.applyCeiling((mcpConnection?.tools ?? {}) as Record<string, unknown>, runMode) : {};
        const subagentToolSet = { ...subagentToolSetBase, ...mcpForRole } as Record<string, any>;
        const subagentSystem = subagentInstructions;
        const maxSubagentSteps = maxSteps === 0 ? 12 : Math.max(2, Math.min(12, maxSteps));
        const subagentMessages: ModelMessage[] = [{ role: 'user', content: `${cleanTask}${context?.trim() ? `\n\nContext from the parent agent:\n${context.trim()}` : ''}` }];
        let textToolSequence = 0;
        try {
          let subagentText = '';
          let leftoverText = '';
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          for (let step = 0; step < maxSubagentSteps; step++) {
            const result = await streamText({
              model: subagentProvider(subagentModelId),
              system: subagentSystem,
              messages: subagentMessages,
              tools: subagentToolSet,
              maxRetries: 3,
              abortSignal: run.controller.signal,
              onToolExecutionStart: ({ toolCall }) => {
                this.notifyHooks('beforeTool', { tool: toolCall.toolName });
                this.post({ type: 'tool', conversationId, parentId: subagentId, subagentRole: role, phase: 'start', id: `${subagentId}:tool:${toolCall.toolCallId}`, tool: toolCall.toolName, name: toolTask(toolCall.toolName, toolCall.input) });
              },
              onToolExecutionEnd: ({ toolCall, toolOutput }) => {
                this.notifyHooks('afterTool', { tool: toolCall.toolName });
                const failed = toolOutput?.type === 'tool-error';
                this.post({ type: 'tool', conversationId, parentId: subagentId, subagentRole: role, phase: 'end', failed, id: `${subagentId}:tool:${toolCall.toolCallId}`, tool: toolCall.toolName, name: toolTask(toolCall.toolName, toolCall.input) });
              },
            });
            const stepText = await result.text;
            const usage = await result.usage;
            totalInput += usage?.inputTokens ?? 0;
            totalOutput += usage?.outputTokens ?? 0;
            totalCacheRead += usage?.inputTokenDetails?.cacheReadTokens ?? 0;
            totalCacheWrite += usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
            const nativeCallCount = (await result.toolCalls)?.length ?? 0;
            const xmlCalls = nativeCallCount > 0 ? [] : parseInvokeBlocks(stepText);
            const decision = classifySubagentStep(stepText, nativeCallCount, xmlCalls.length);
            leftoverText = rememberVisibleText(leftoverText, decision.visibleText);
            const stepThinking = extractThinkBlocks(stepText);
            if (decision.kind === 'native-tools') {
              // Native tool calls (already executed by streamText): hand the resulting messages back to the model.
              const responseMessages = (await result.responseMessages) ?? [];
              subagentMessages.push(...(responseMessages as ModelMessage[]).filter(message => message.role !== 'system'));
              attachReasoningToLatestAssistant(subagentMessages, stepThinking);
              continue;
            }
            if (decision.kind === 'xml-tools') {
              // Claude-Code style text tool calls: execute them directly and feed the results back.
              const xmlResults: string[] = [];
              for (const call of xmlCalls) {
                const tool = subagentToolSet[call.name];
                const input = Object.fromEntries(call.params.map(([name, value]) => [name, coerceXmlParam(value)]));
                const id = `${subagentId}:text-tool:${++textToolSequence}`;
                if (!tool) {
                  xmlResults.push(`## ${call.name}\nTool is not available to a ${role} subagent.`);
                  continue;
                }
                this.notifyHooks('beforeTool', { tool: call.name });
                this.post({ type: 'tool', conversationId, parentId: subagentId, subagentRole: role, phase: 'start', id, tool: call.name, name: toolTask(call.name, input) });
                try {
                  const output = await executeTool({ tool, input, options: { toolCallId: id, messages: subagentMessages, abortSignal: subagentAbort.signal, context: undefined as never } });
                  let finalOutput: unknown = '';
                  for await (const part of output) if (part.type === 'final') finalOutput = part.output;
                  xmlResults.push(`## ${call.name}\n${typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput)}`);
                  this.post({ type: 'tool', conversationId, parentId: subagentId, subagentRole: role, phase: 'end', failed: false, id, tool: call.name, name: toolTask(call.name, input) });
                } catch (error) {
                  xmlResults.push(`## ${call.name}\nerror: ${errorMessage(error)}`);
                  this.post({ type: 'tool', conversationId, parentId: subagentId, subagentRole: role, phase: 'end', failed: true, id, tool: call.name, name: toolTask(call.name, input) });
                }
                this.notifyHooks('afterTool', { tool: call.name });
              }
              attachReasoningToLatestAssistant(subagentMessages, stepThinking);
              subagentMessages.push({ role: 'user', content: `Tool results:\n${xmlResults.join('\n\n')}\n\nContinue the task. When finished, give the final answer as plain text without XML tool tags.` });
              continue;
            }
            if (decision.kind === 'final') {
              attachReasoningToLatestAssistant(subagentMessages, stepThinking);
              subagentText = decision.visibleText;
              break;
            }
            // Think-only / whitespace-only step: keep going so the model can
            // emit a parent-visible answer instead of returning the placeholder.
            attachReasoningToLatestAssistant(subagentMessages, stepThinking);
            subagentMessages.push({
              role: 'user',
              content: leftoverText
                ? `You produced no parent-visible final answer. Convert the findings below into a concise plain-text result for the parent agent. Do not call tools unless required to finish.\n\nFindings so far:\n${leftoverText}`
                : 'You produced no parent-visible final answer. Reply now with the concise plain-text result for the parent agent. Do not call tools unless required to finish.',
            });
          }
          const harvested = harvestSubagentText(subagentText, leftoverText);
          subagentText = harvested.text;
          if (totalInput || totalOutput) {
            if (this.shouldRecordUsage()) recordUsage(this.context, { conversationId, model: subagentModelId, provider: subagentProviderId, inputTokens: totalInput, outputTokens: totalOutput, cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite });
          }
          const text = subagentText;
          releaseSubagent();
          this.post({ type: 'subagent', conversationId, id: subagentId, role, task: cleanTask, name: label, phase: 'end', ok: true, result: text.slice(0, 500) });
          return text;
        } catch (error) {
          releaseSubagent();
          const message = errorMessage(error);
          // A cancelled subagent did not fail; say what happened so the parent
          // does not treat a user's decision as a defect.
          const cancelled = subagentAbort.signal.aborted && !run.controller.signal.aborted;
          this.post({ type: 'subagent', conversationId, id: subagentId, role, task: cleanTask, name: label, phase: 'end', ok: false, error: cancelled ? 'Cancelled.' : message });
          throw new Error(cancelled ? `Subagent (${role}) was cancelled.` : `Subagent (${role}) failed: ${message}`);
        }
      };

      const agentTools = filterAgentTools({
        ...buildTools({
          root,
          skillsDir: this.skillsRoot(),
          config: () => this.config(),
          approve: (kind, title, detail, destructive, approvalKey) => this.approve(kind, title, detail, destructive, approvalKey, conversationId),
          reviewEdit: (filePath, before, after, reason, destructive) => this.reviewEdit(filePath, before, after, reason, destructive, conversationId),
          post: postToolEvent,
          resolvePath: filePath => this.resolveWorkspacePath(filePath),
          describePlan,
          abortSignal: run.controller.signal,
          terminals: this.terminals,
          delegate,
          // Only offered when there is a UI to answer through.
          ask: (header, questions, callId) => this.askUser(conversationId, header, questions, callId, run.controller.signal),
          // Plan mode's single narrow write. The path is derived from the title
          // here, so the model never chooses where a file goes.
          writePlan: runMode === 'plan'
            ? async (title, content) => {
              const relative = planFile.planRelativePath(title);
              const uri = this.resolveWorkspacePath(relative);
              await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.workspaceRoot()!, planFile.PLAN_DIR));
              await vscode.workspace.fs.writeFile(uri, Buffer.from(planFile.planDocument(title, content), 'utf8'));
              this.log('info', 'plan.saved', relative);
              return { path: relative };
            }
            : undefined,
          memory: memoryAccess,
          repoIndex,
          repoMemory,
          browser: this.browser,
          observationsDir: () => this.observationsRoot(),
        }),
        ...mcpConnection.tools,
      }, conversationAgent?.tools);

      // Read-only modes withhold the tools that would need approval, which is how
      // `ask` and `plan` are enforced: approval is a property of agent mode, so a
      // mode that cannot act never reaches the gate. The same ceiling is applied
      // to subagents above, so delegating cannot widen it.
      const runTools = modeRules.applyCeiling(agentTools, runMode) as typeof agentTools;
      if (runMode !== 'agent') {
        this.log('info', 'run.mode.readonly', `${runMode}: withheld ${modeRules.withheldByCeiling(agentTools, runMode).join(',')}`);
      }

      // Reasoning effort rides along as provider options so it reaches the
      // wire only for models that accept it; an unsupported model gets `{}`
      // and therefore no unexpected 400.
      const effortBody = reasoningEffortBody(selection.reasoningEffort, model);
      const agent = new ToolLoopAgent({
        model: provider(model),
        // Retry policy lives in the run loop below, which classifies the error first and
        // backs off deliberately. The SDK's own retries ran ahead of that gate, so a
        // payload the loop would never resend was still retried up to 4 times per
        // attempt — 20 identical requests for one failure. Keep a single SDK attempt
        // so the loop decides.
        maxRetries: 1,
        instructions,
        tools: runTools,
        stopWhen: maxSteps === 0 ? isLoopFinished() : isStepCount(maxSteps),
        ...(Object.keys(effortBody).length ? { providerOptions: { [providerConfig.id]: effortBody } } : {}),
      });

      let streamPrompt: string;
      let resumeContext = '';
      if (resume) {
        const plan = planState;
        const planLines = plan?.steps
          ? plan.steps.map((step, index) => `- ${plan.done.has(index) ? '[done]' : index === plan.active ? '[current]' : '[pending]'} ${step}`).join('\n')
          : '';
        const inProgressLines = work.filter(item => item.kind === 'task' && item.done === false)
          .map(item => `- ${item.text.replace(/\s+/g, ' ')}`)
          .join('\n');
        const doneLines = work.filter(item => item.kind === 'task' && item.done !== false).slice(-10)
          .map(item => `- ${item.text.replace(/\s+/g, ' ')}`)
          .join('\n');
        const priorThinking = persistedReasoningBody(collectReasoningText(work));
        resumeContext = [
          planLines ? `Task plan:\n${planLines}` : '',
          inProgressLines ? `Current task (continue from here):\n${inProgressLines}` : '',
          doneLines ? `Work already completed (do not redo):\n${doneLines}` : '',
          priorThinking ? `Your previous thinking (continue from it; do not repeat it):\n${priorThinking.slice(-this.config().maxPersistedReasoning)}` : '',
          resume?.errorText ? `The last attempt ended with:\n${resume.errorText}` : '',
          resume?.partialText ? `You had already written this partial response before the interruption. Continue it from exactly where it stops: do NOT restart the response and do NOT reproduce this text. Pick up mid-sentence and finish naturally.\n\nPartial response:\n${resume.partialText.slice(-6000)}` : '',
        ].filter(Boolean).join('\n\n');
        const resumeDirection = resume?.partialText
          ? 'The previous attempt was interrupted mid-response. A partial response was already written (see below). Continue from exactly where it stopped: do NOT redo completed work, do NOT restart the response. Finish the remaining work and complete the response naturally.'
          : 'The previous attempt of this task was interrupted. Continue from exactly where it stopped, using the plan and last task below: do NOT redo completed work or replay the original request. Work through only the remaining steps, verify the result, then give only the concise final summary.';
        streamPrompt = resumeContext
          ? `${resumeDirection}\n\n${resumeContext}`
          : userText;
      } else {
        // Prefer the structured model history (assistant turns + tool calls + tool
        // results). Fall back to the flattened text window only for conversations
        // that predate structured history or were compacted to text summaries.
        const structured = this.structuredHistory(conversation, modelInfo.contextWindow, modelInfo.maxOutputLimit);
        if (structured.length) {
          streamPrompt = `${userText}${promptContext}`;
        } else {
          const budgetTokens = Math.max(2_000, Math.floor((DEFAULT_CONTEXT_WINDOW * AUTO_COMPACT_RATIO) / 2));
          const recent = this.recentContextItems(conversation, budgetTokens)
            .map(item => {
              const text = item.partialText ? `${item.partialText}\n[${item.text}]` : item.text;
              return `${item.role.toUpperCase()}: ${text}`;
            })
            .join('\n\n');
          streamPrompt = recent
            ? `Previous conversation:\n${recent}\n\nCurrent request:\n${userText}${promptContext}`
            : `${userText}${promptContext}`;
        }
      }
      const baseStreamPrompt = streamPrompt;
      // Retries this loop has reported, so it closes the row it opened. The budget
      // itself is a streak that a success resets, so it cannot be used for that.
      let runRetries = 0;
      const baseWork = work.slice();
      while (true) {
        // Each attempt restarts the stream from `baseStreamPrompt`, so the messages
        // produced by the previous attempt must not be carried over: keeping them
        // re-stacked the whole turn onto `structuredHistory` on every retry until the
        // request overflowed the context window.
        runMessages = [];
        let answer = '';
        let finishReason = '';
        let stepCount = 0;
        let lastIterationStepCount = 0;
        let continuationCount = 0;
        let liveInput = 0;
        let liveOutput = 0;
        let liveCacheRead = 0;
        let liveCacheWrite = 0;
        let runInput = 0;
        let runOutput = 0;
        let runCacheRead = 0;
        let runCacheWrite = 0;
        let lastStepInput = 0;
        let liveStartTime = Date.now();
        let streamStartTime = Date.now();
        try {
          do {
            finishReason = '';
            let iterationStepCount = 0;
            streamStartTime = Date.now();
            const imageAttachments = (composerContext?.attachments ?? []).filter((attachment): attachment is Extract<Attachment, { kind: 'image' }> => attachment.kind === 'image' && Boolean(attachment.tempPath));
            const prompt: string | ModelMessage[] = imageAttachments.length
              ? [{
                role: 'user', content: [
                  { type: 'text', text: streamPrompt },
                  ...await Promise.all(imageAttachments.map(async attachment => ({ type: 'file' as const, mediaType: attachment.mimeType, data: await readFile(attachment.tempPath!) }))),
                ]
              }]
              : streamPrompt;
            // Keep prior conversation history AND this turn's already-produced
            // tool calls/results. Resume/auto-continue used to drop that live
            // slice, which is how partial context disappeared mid-iteration.
            const history = this.structuredHistory(conversation, modelInfo.contextWindow, modelInfo.maxOutputLimit);
            let agentMessages: ModelMessage[] | undefined;
            if (history.length || runMessages.length) {
              agentMessages = iterationRequestMessages(history, runMessages, streamPrompt);
              if (imageAttachments.length) {
                const imageParts = await Promise.all(imageAttachments.map(async attachment => ({ type: 'image' as const, image: await readFile(attachment.tempPath!), mediaType: attachment.mimeType })));
                const last = agentMessages[agentMessages.length - 1];
                if (last) last.content = [{ type: 'text' as const, text: streamPrompt }, ...imageParts];
              }
            }
            this.notifyHooks('onAgentStart', { text: streamPrompt });
            this.log('info', 'run.stream.start', `conversation=${conversationId}; model=${model}`);
            const result = await agent.stream({
              ...(agentMessages ? { messages: agentMessages } : { prompt }),
              abortSignal: run.controller.signal,
              onToolExecutionStart: ({ toolCall }) => {
                this.enforceHooks('beforeTool', { tool: toolCall.toolName, text: JSON.stringify(toolCall.input ?? {}) });
                if (toolCall.toolName === 'plan') {
                  const input = toolCall.input as { title?: string; steps?: string[]; activeStep?: number; doneSteps?: number[] };
                  const parsedSteps = Array.isArray(input?.steps)
                    ? input.steps.filter((step): step is string => typeof step === 'string' && step.trim().length > 0).map(step => step.trim())
                    : [];
                  const passedDone = new Set<number>();
                  for (const index of input?.doneSteps ?? []) {
                    if (Number.isInteger(index) && (index as number) >= 0) passedDone.add(index as number);
                  }
                  if (parsedSteps.length) {
                    const title = typeof input?.title === 'string' && input.title.trim() ? input.title.trim() : planState?.title ?? 'Plan';
                    const done = new Set<number>();
                    for (const index of passedDone) if (index < parsedSteps.length) done.add(index);
                    for (const index of planState?.done ?? []) if (index < parsedSteps.length) done.add(index);
                    let active = Number.isInteger(input?.activeStep) ? (input.activeStep as number) : (planState && planState.active >= 0 ? planState.active : 0);
                    if (active >= parsedSteps.length) active = parsedSteps.length - 1;
                    planState = { title, steps: parsedSteps, active: Math.max(0, active), done, manual: true, interrupted: false };
                  } else if (planState) {
                    for (const index of passedDone) {
                      if (index < planState.steps.length) planState.done.add(index);
                    }
                    if (typeof input?.title === 'string' && input.title.trim()) planState.title = input.title.trim();
                    if (Number.isInteger(input?.activeStep) && (input.activeStep as number) >= 0) {
                      planState.active = Math.min(planState.steps.length - 1, input.activeStep as number);
                    }
                    planState.manual = true;
                    planState.interrupted = false;
                  }
                  if (planState) {
                    planItem = { kind: 'plan', text: planState.title, title: planState.title, steps: planState.steps, doneSteps: [], activeStep: planState.active, interrupted: false };
                    let lastPlanIndex = -1;
                    for (let index = work.length - 1; index >= 0; index--) {
                      if (work[index]?.kind === 'plan') { lastPlanIndex = index; break; }
                    }
                    if (lastPlanIndex >= 0) work[lastPlanIndex] = planItem; else work.push(planItem);
                    postPlan();
                  }
                  return;
                }
                const taskEntry: WorkItem = { kind: 'task', text: toolTask(toolCall.toolName, toolCall.input), done: false, tool: toolCall.toolName };
                activeTasks.set(toolCall.toolCallId, taskEntry);
                work.push(taskEntry);
                workStartedAt ||= Date.now();
                toolStartedAt.set(toolCall.toolCallId, Date.now());
                this.post({ type: 'tool', conversationId, phase: 'start', id: toolCall.toolCallId, tool: toolCall.toolName, name: taskEntry.text, args: toolArgsText(toolCall.input) });
                this.post({ type: 'state', conversationId, running: true, label: humanToolName(toolCall.toolName) });
                updatePending(true);
              },
              onToolExecutionEnd: ({ toolCall, toolOutput }) => {
                this.notifyHooks('afterTool', { tool: toolCall.toolName });
                if (toolCall.toolName === 'plan') return;
                const taskEntry = activeTasks.get(toolCall.toolCallId);
                if (taskEntry) taskEntry.done = true;
                const elapsed = durationMs(toolStartedAt.get(toolCall.toolCallId));
                toolStartedAt.delete(toolCall.toolCallId);
                this.post({ type: 'tool', conversationId, phase: 'end', id: toolCall.toolCallId, tool: toolCall.toolName, name: toolTask(toolCall.toolName, toolCall.input), args: toolArgsText(toolCall.input), result: toolResultText(toolOutput), durationMs: elapsed, failed: toolOutput?.type === 'tool-error' });
                updatePending(true);
              },
              onStepFinish: step => {
                const completed = (step.response.messages ?? []) as ModelMessage[];
                if (completed.length) runMessages.push(...completed.filter(message => message.role !== 'system'));
                updatePending(true);
              },
            });

            const thinkSplit = createThinkSplitter();
            for await (const part of result.stream) {
              if (part.type === 'text-delta') {
                const { content, thinking } = thinkSplit(part.text);
                if (content) {
                  answer += content;
                  if (answer.length > partialAnswer.length) partialAnswer = answer;
                  this.post({ type: 'delta', conversationId, text: content });
                  updatePending();
                }
                if (thinking) {
                  reasoningBuffer = rememberReasoningText(reasoningBuffer, thinking, reasoningLimit).text;
                  this.post({ type: 'reasoningDelta', conversationId, text: thinking });
                }
              } else if (part.type === 'reasoning-delta') {
                workStartedAt ||= Date.now();
                reasoningBuffer = rememberReasoningText(reasoningBuffer, part.text, reasoningLimit).text;
                this.post({ type: 'reasoningDelta', conversationId, text: part.text });
              } else if (part.type === 'reasoning-end') {
                if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer });
                reasoningBuffer = '';
                this.post({ type: 'reasoningEnd' });
              } else if (part.type === 'start-step') {
                workStartedAt ||= Date.now();
                iterationStepCount++;
                const first = stepCount++ === 0;
                this.post({ type: 'workPhase', conversationId, first });
              } else if (part.type === 'finish-step') {
                const usage = part.usage;
                const input = usage?.inputTokens ?? 0;
                const output = usage?.outputTokens ?? 0;
                const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
                const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
                // The most recent step's prompt_tokens is the true context size the
                // provider counted for the last call — the closest measured proxy for
                // current context-window occupancy.
                lastStepInput = input;
                if (input || output) {
                  liveInput += input;
                  liveOutput += output;
                  liveCacheRead += cacheRead;
                  liveCacheWrite += cacheWrite;
                  const liveSpeed = Math.round((liveOutput / Math.max(1, Date.now() - liveStartTime)) * 1000);
                  // contextTokens is the LATEST step's prompt_tokens — the true
                  // context size the provider counted for the current call. It is
                  // pushed live so the context-window pill updates during the run,
                  // not only after the assistant item is committed.
                  this.post({ type: 'liveUsage', conversationId, model, provider: providerConfig.id, inputTokens: liveInput, outputTokens: liveOutput, cacheReadTokens: liveCacheRead, cacheWriteTokens: liveCacheWrite, speed: liveSpeed, contextTokens: input });
                }
              } else if (part.type === 'error') {
                throw part.error;
              } else if (part.type === 'finish') {
                finishReason = part.finishReason;
              }
            }
            lastIterationStepCount = iterationStepCount;
            // Capture the structured turn (assistant message with tool calls + the
            // tool results) so it can be persisted for the next user turn.
            if (!run.controller.signal.aborted) {
              // onStepFinish already checkpoints each completed step. Keep the
              // aggregate result only as a compatibility fallback for providers
              // that do not emit step callbacks; otherwise it would duplicate
              // tool calls and results in the next request.
              if (!runMessages.length) {
                const responseMessages = (await result.responseMessages) ?? [];
                runMessages.push(...(responseMessages as ModelMessage[]).filter(message => message.role !== 'system'));
              }
              // Some reasoning models must reread their previous thinking. Keep the
              // live buffer (native deltas + XML <think>) on the latest assistant
              // message so the next step/continue/resume still has it.
              attachReasoningToLatestAssistant(runMessages, reasoningBuffer.trim() || collectReasoningText(work));
              // Checkpoint after every completed iteration. If VS Code reloads, the
              // connection drops, or the model errors mid-run, this partial turn is
              // recoverable instead of being lost and re-read from scratch.
              // Coalesced: a long run must not rewrite storage on every token;
              // tools and terminal outcomes force their own flushes.
              updatePending();
            }
            const usage = await result.usage;
            if (usage?.inputTokens || usage?.outputTokens) {
              const uin = usage.inputTokens ?? 0;
              const uout = usage.outputTokens ?? 0;
              const ucacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
              const ucacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
              runInput += uin;
              runOutput += uout;
              runCacheRead += ucacheRead;
              runCacheWrite += ucacheWrite;
              const durationMs = Date.now() - streamStartTime;
              const tokensPerSecond = durationMs > 0 ? Math.round((uout / durationMs) * 1000) : 0;
              if (this.shouldRecordUsage()) recordUsage(this.context, { conversationId, model, provider: providerConfig.id, inputTokens: uin, outputTokens: uout, cacheReadTokens: ucacheRead, cacheWriteTokens: ucacheWrite, durationMs, tokensPerSecond });
              this.postSessionStats(conversationId);
              // Count the step against the conversation's goal, so a bounded goal
              // actually limits the run instead of being decorative.
              if (conversation.goal) {
                const before = conversation.goal.status;
                conversation.goal = goalCore.addTokens(conversation.goal, uin + uout);
                if (conversation.goal.status !== before) {
                  this.log('warn', 'conversation.goal.budgetExhausted', `${conversation.id}: ${conversation.goal.tokensUsed}/${conversation.goal.tokenBudget ?? '-'}`);
                  this.postWorkflow(conversation.id);
                }
              }
            }
            if (finishReason === 'error') throw new Error('The model stopped because the provider reported a generation error.');
            if (finishReason === 'content-filter') throw new Error('The model stopped because the provider blocked the response.');
            if (!shouldAutoContinue(answer, finishReason, continuationCount)) break;
            continuationCount++;
            const priorThinking = persistedReasoningBody(reasoningBuffer.trim() || collectReasoningText(work));
            streamPrompt = `Continue the original coding request from exactly where you stopped. Do not mention this instruction, do not repeat prior text, and do not stop after describing the next action. Use tools to complete all remaining work, verify it, and only then give the concise final summary.\n\nOriginal request:\n${userText}\n\nWork shown so far:\n${answer.slice(-8_000)}${priorThinking ? `\n\nYour previous thinking (do not repeat it; continue from it):\n${priorThinking.slice(-reasoningLimit)}` : ''}`;
          } while (continuationCount < 2 && !run.controller.signal.aborted);
          this.sendUsage();
          const paused = pausedByStepLimit(maxSteps, lastIterationStepCount, finishReason);
          // The model hit its output limit and cut the answer mid-sentence. That is
          // not a finished turn: committing it as a clean success is exactly how the
          // "stopped midway but looks fine" symptom appears. Treat it as a recoverable
          // pause so the partial text stays visible and can be continued.
          const truncated = finishReason === 'length';
          if (!answer.trim()) answer = paused ? `Iteration paused after reaching the ${maxSteps}-step limit.` : truncated ? '(Response reached the model output limit before producing text.)' : '(No response)';
          if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer });
          if (paused) {
            if (planState) { planState.interrupted = true; postPlan(); }
          } else {
            finalizePlan();
          }
          const keptWork = work.slice(-80);
          const workSeconds = workStartedAt ? Math.max(1, Math.round((Date.now() - workStartedAt) / 1000)) : 0;
          // When continuing a partial response, prepend the preserved half so the
          // committed message reads as one uninterrupted answer.
          const finalAnswer = resume?.partialText ? resume.partialText + answer : answer;
          const assistantItem = createTranscriptItem('assistant', finalAnswer, undefined, runGitTree, keptWork, workSeconds, runInput || liveInput, runOutput || liveOutput, runCacheRead || liveCacheRead, runCacheWrite || liveCacheWrite);
          if (model) assistantItem.model = model;
          if (lastStepInput) assistantItem.contextTokens = lastStepInput;
          if (paused) {
            assistantItem.paused = true;
            assistantItem.pauseReason = 'max_steps';
            assistantItem.pauseLimit = maxSteps;
          } else if (truncated) {
            assistantItem.paused = true;
            assistantItem.pauseReason = 'max_tokens';
          }
          const finalChanges = await completeRunChanges();
          if (truncated && !paused) assistantItem.partialText = finalAnswer;
          if (finalChanges.length) assistantItem.changes = finalChanges;
          if (snapshotByPath.size) assistantItem.fileSnapshot = [...snapshotByPath.values()];
          // Persist the structured model history so the next turn keeps prior tool
          // calls and their results in context instead of re-reading files.
          if (runMessages.length) this.appendConversationMessages(conversation, historyUserText, runMessages, Boolean(resume));
          conversation.pending = undefined;
          conversation.turnRedo = [];
          conversation.items.push(assistantItem);
          this.boundConversationItems(conversation);
          conversation.updatedAt = Date.now();
          project.updatedAt = Date.now();
          await this.checkpointConversation(conversation, true);
          if (runRetries) this.post({ type: 'retryEnd', conversationId, ok: true, attempt: runRetries, max: retryBudget.max });
          this.reportMemory();
          this.post({ type: 'done', conversationId, item: assistantItem });
          systemNotify(this.context, {
            subtitle: paused ? 'Iteration paused' : truncated ? 'Response truncated' : 'Task complete',
            message: paused ? `Reached the ${maxSteps}-step limit. Continue when ready.` : truncated ? 'The model hit its output limit, so the answer is incomplete. Continue when ready.' : (notificationSummary(finalAnswer) || conversation.title),
            kind: paused || truncated ? 'attention' : 'info',
          });
          break;
        } catch (attemptError) {
          if (run.controller.signal.aborted) throw attemptError;
          const attemptInfo = classifyAgentError(attemptError, providerConfig);
          // One policy for every reason a turn is resent. A stream rejected with a
          // 401/403 (sleep/wake, gateway rollout) is not a sign-out: rotate the token,
          // then continue from the text already streamed instead of restarting from
          // nothing. Transient failures resume the same way, which is strictly better
          // than throwing the partial answer away.
          const kind = isAuthRejection(attemptError) && providerConfig.isSleepy ? 'auth' : attemptInfo.retryable && attemptInfo.code !== 'action_denied' ? 'transient' : undefined;
          if (!kind) {
            if (runRetries) this.post({ type: 'retryEnd', conversationId, ok: false, attempt: runRetries, max: retryBudget.max });
            throw attemptError;
          }
          const renewed = kind === 'auth' ? await refreshSleepyToken().catch(() => null) : null;
          const decision = retryBudget.take(kind, kind === 'auth'
            ? retryMessage({ kind, status: statusCodeOf(attemptError), recovered: Boolean(renewed) })
            : attemptInfo.message);
          if (!decision) {
            if (runRetries) this.post({ type: 'retryEnd', conversationId, ok: false, attempt: runRetries, max: retryBudget.max });
            throw attemptError;
          }
          runRetries = decision.attempt;
          this.log('warn', `run.stream.retry.${decision.kind}`, `attempt=${decision.attempt}/${decision.max}; renewed=${Boolean(renewed)}`);
          this.post({ type: 'retry', conversationId, attempt: decision.attempt, max: decision.max, error: decision.message, backoffMs: decision.backoffMs });
          await waitForRetry(decision.backoffMs, run.controller.signal);
          const carriedText = answer.trim() || partialAnswer.trim() || resume?.partialText || '';
          streamPrompt = carriedText
            ? `Continue the original coding request from exactly where you stopped. Do not mention this instruction, do not repeat prior text, and do not stop after describing the next action. Use tools to complete all remaining work, verify it, and only then give the concise final summary.\n\nOriginal request:\n${userText}\n\nWork shown so far:\n${carriedText.slice(-8_000)}`
            : baseStreamPrompt;
          work.length = 0;
          work.push(...baseWork);
          planState = undefined;
          planItem = undefined;
          activeTasks.clear();
          reasoningBuffer = '';
          workStartedAt = 0;
        }
      }
    } catch (error) {
      if (run.controller.signal.aborted) {
        // Keep whatever the turn accomplished before it was stopped so a later
        // message continues from real context instead of re-reading files.
        appendPartialAnswer(runMessages, partialAnswer || resume?.partialText);
        if (runMessages.length) this.appendConversationMessages(conversation, historyUserText, runMessages, Boolean(resume));
        conversation.pending = undefined;
        if (planState) { planState.interrupted = true; postPlan(); }
        if (run.steering) {
          carriedGitTree = runGitTree;
          this.post({ type: 'steered', conversationId });
        } else {
          if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer });
          // A stop is the same shape as an error: one retryable assistant item that
          // keeps the streamed partial, the work, and the workspace snapshot. The
          // card text is the retryable sentence; the partial lives in partialText so
          // the transcript shows it once instead of twice.
          const stoppedItem = createTranscriptItem('assistant', INTERRUPTED_TURN_TEXT, 'error', runGitTree, work.slice(-80), workStartedAt ? Math.max(1, Math.round((Date.now() - workStartedAt) / 1000)) : 0);
          // The user asked for this. Tag it so the sidebar reports "Stopped" rather than
          // "Failed", which is what a deliberate stop used to be labelled as.
          stoppedItem.errorInfo = { code: 'interrupted', retryable: true, title: 'Stopped', message: 'You stopped this turn. Its partial output is saved.', primaryAction: 'retry' };
          if (model) stoppedItem.model = model;
          const stoppedChanges = await completeRunChanges();
          const fields = interruptedAssistantFields({
            userText: historyUserText,
            reason: 'stop',
            message: INTERRUPTED_TURN_TEXT,
            work,
            changes: stoppedChanges,
            fileSnapshot: [...snapshotByPath.values()],
            gitTree: runGitTree,
            partialText: partialAnswer.trim() || resume?.partialText,
          });
          stoppedItem.partialText = fields.partialText;
          if (stoppedChanges.length) stoppedItem.changes = fields.changes as FileChange[];
          if (snapshotByPath.size) stoppedItem.fileSnapshot = fields.fileSnapshot as FileSnapshot[];
          conversation.items.push(stoppedItem);
          this.boundConversationItems(conversation);
          this.post({ type: 'generationError', conversationId, item: stoppedItem });
        }
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.checkpointConversation(conversation, true);
      } else {
        if (reconnectAttempt) this.post({ type: 'retryEnd', conversationId, ok: false, attempt: reconnectAttempt, max: 5 });
        const errorInfo = classifyAgentError(error, providerConfig);
        // Never replace an interruption with a generated wrap-up. The transcript
        // must show the exact provider/tool/server error that terminated the run.
        const message = providerErrorMessage(error);
        errorInfo.message = message;
        if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer });
        const errorItem = createTranscriptItem('assistant', message, 'error', runGitTree, work.slice(-80), workStartedAt ? Math.max(1, Math.round((Date.now() - workStartedAt) / 1000)) : 0);
        if (model) errorItem.model = model;
        errorItem.errorInfo = errorInfo;
        const failedChanges = await completeRunChanges();
        const fields = interruptedAssistantFields({
          userText: historyUserText,
          reason: 'error',
          message,
          work,
          changes: failedChanges,
          fileSnapshot: [...snapshotByPath.values()],
          gitTree: runGitTree,
          partialText: partialAnswer.trim() || undefined,
        });
        errorItem.partialText = fields.partialText;
        if (failedChanges.length) errorItem.changes = fields.changes as FileChange[];
        if (snapshotByPath.size) errorItem.fileSnapshot = fields.fileSnapshot as FileSnapshot[];
        // Keep the work already done: merge the partial turn's tool calls,
        // streamed text, and results into the structured history so a retry continues
        // instead of re-reading every file.
        appendPartialAnswer(runMessages, fields.partialText || partialAnswer || resume?.partialText);
        if (runMessages.length) this.appendConversationMessages(conversation, historyUserText, runMessages, Boolean(resume));
        conversation.pending = undefined;
        conversation.items.push(errorItem);
        this.boundConversationItems(conversation);
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.checkpointConversation(conversation, true);
        finalizePlan();
        this.post({ type: 'generationError', conversationId, item: errorItem });
        systemNotify(this.context, { subtitle: 'Task failed', message: notificationSummary(message) || conversation.title, kind: 'attention' });
      }
    } finally {
      this.log('info', 'run.finally.start', conversationId);
      if (!mcpCached) await mcpConnection?.close();
      this.post({ type: 'liveUsage', conversationId, model: '', provider: '', inputTokens: 0, outputTokens: 0 });
      this.runs.delete(conversationId);
      this.log('info', 'run.finally.done', conversationId);
      this.post({ type: 'state', conversationId, running: false, label: '' });
      this.syncConversations(false);
      this.notifyHooks('onAgentEnd', { text: userText });
      // Auto-compaction must run after this.runs.delete above: compactConversation
      // refuses to compact while a run is active for the conversation.
      if (providerConfig) this.maybeAutoCompact(conversation, providerConfig.id, this.selectionFor(conversation).model);
      const own = this.queue.find(entry => entry.conversationId === conversationId);
      const next = own ?? this.queue[0];
      if (next && this.runs.size < MAX_CONCURRENT_RUNS) {
        this.queue = this.queue.filter(entry => entry !== next);
        this.postWorkflow(next.conversationId);
        void this.run(next.text, next.conversationId, undefined, carriedGitTree, next.context, next.promptContext);
      } else if (own) {
        this.postWorkflow(conversationId);
      }
    }
  }

  private responseItem(conversationId: string, itemId: string): { project: Project; conversation: Conversation; item: TranscriptItem } | undefined {
    const project = this.activeProject();
    const conversation = project?.conversations.find(entry => entry.id === conversationId);
    const item = conversation?.items.find(entry => entry.id === itemId && entry.role === 'assistant');
    if (!project || !conversation || !item) return undefined;
    return { project, conversation, item };
  }

  /**
   * Compacts a conversation into a summary + carried tail. Emits compactProgress
   * phases (start → summarizing → done | cancelled | error) so the webview can
   * show live progress and offer cancellation. Conversation items and title are
   * only mutated after a successful summary; failures leave state untouched.
   */
  private async compactConversation(conversationId?: string, options?: { auto?: boolean }): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    const targetId = conversationId ?? project.activeConversationId;
    const conversation = project.conversations.find(entry => entry.id === targetId);
    const progress = (phase: 'start' | 'summarizing' | 'done' | 'cancelled' | 'error', extra: { auto?: boolean; text?: string; beforeTokens?: number; afterTokens?: number; contextWindow?: number; itemCount?: number } = {}): void => {
      this.post({ type: 'compactProgress', conversationId: targetId ?? '', phase, ...extra });
    };
    if (!conversation) return; // deleted mid-flight — nothing to report
    if (conversation.items.length < 4) {
      progress('error', { text: 'Nothing to compact yet.', auto: options?.auto === true });
      return;
    }
    if (this.runs.has(targetId ?? '')) {
      progress('error', { text: 'Wait until the current run finishes.', auto: options?.auto === true });
      return;
    }
    // Compaction summarises with the local model and rewrites items plus
    // structured history. On a CLI conversation the summary would be invented
    // here and stored nowhere the CLI can see, so the two would disagree about
    // the same session. The CLI runs its own compaction; the sidebar is a
    // projector and must not summarise on its behalf.
    if (conversation && this.refuseIfCliOwned(conversation, 'Compacting')) {
      progress('error', { text: 'The Sleepy CLI manages context for this conversation.', auto: options?.auto === true });
      return;
    }
    if (this.compactionControllers.has(targetId ?? '')) return; // already compacting
    const controller = new AbortController();
    this.compactionControllers.set(targetId ?? '', controller);
    const beforeTokens = contextOccupancy(conversation.items).tokens;
    progress('start', { auto: options?.auto === true });
    try {
      progress('summarizing', { auto: options?.auto === true });
      const selection = this.selectionFor(conversation);
      const before = conversation.items;
      const summarized = await this.summarizeConversation(before, selection, controller.signal, targetId);
      conversation.items = summarized.items;
      // The structured model history must follow the compacted transcript, otherwise
      // the next turn would replay the pre-compaction tool calls we just summarized.
      const afterMessages: ModelMessage[] = [
        { role: 'user', content: `Conversation summary (earlier context was compacted):\n\n${summarized.summaryText}` },
      ];
      const undo = this.compactionUndoStacks.get(targetId ?? '') ?? [];
      undo.push({
        beforeItems: before.slice(),
        afterItems: summarized.items.slice(),
        beforeMessages: (conversation.messages ?? []).slice(),
        afterMessages: afterMessages.slice(),
      });
      conversation.messages = afterMessages;
      this.compactionUndoStacks.set(targetId ?? '', undo.slice(-3));
      this.compactionRedoStacks.delete(targetId ?? '');
      void this.persistCompactionSnapshots(targetId ?? '');
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      // Note: usage was already recorded per attempt inside summarizeConversation
      // (including rejected empty responses — reasoning burn is real spend).
      const afterTokens = contextOccupancy(conversation.items).tokens;
      const modelInfo = this.getEffectiveModelInfo(selection.provider, selection.model);
      progress('done', {
        auto: options?.auto === true,
        beforeTokens,
        afterTokens,
        contextWindow: modelInfo.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        itemCount: conversation.items.length,
      });
    } catch (error) {
      if (controller.signal.aborted) progress('cancelled', { auto: options?.auto === true });
      else progress('error', { text: errorMessage(error), auto: options?.auto === true });
    } finally {
      this.compactionControllers.delete(targetId ?? '');
    }
  }

  /**
   * Auto-compaction entry point, invoked from the run() finally block — i.e. only
   * after the run has been removed from this.runs, otherwise compactConversation's
   * active-run guard would always reject it. Cooldown prevents pathological loops
   * when a conversation stays above the threshold even after compaction.
   */
  private maybeAutoCompact(conversation: Conversation, providerId: string, model: string): void {
    if (conversation.items.length < 8) return;
    // A queued follow-up for this conversation is about to start; compacting now
    // would swap the transcript while that run reads it.
    if (this.queue.some(entry => entry.conversationId === conversation.id)) return;
    const contextTokens = contextOccupancy(conversation.items).tokens;
    const modelInfo = this.getEffectiveModelInfo(providerId, model);
    // Measure the stored history the way the send path will budget it, so compaction
    // fires before the budget starts dropping messages. Without this the conversation
    // could grow past the send budget and silently lose turns with no compaction ever
    // running, because the old trigger only watched the model window.
    const budgetTokens = structuredHistoryBudget(modelInfo.contextWindow, modelInfo.maxOutputLimit);
    const historyTokens = estimateHistoryTokens(conversation.messages, estimateMessageTokens);
    if (!shouldAutoCompact(contextTokens, modelInfo.contextWindow, historyTokens, budgetTokens)) return;
    const now = Date.now();
    if (now - (this.lastAutoCompactAt.get(conversation.id) ?? 0) < 120_000) return;
    this.lastAutoCompactAt.set(conversation.id, now);
    void this.compactConversation(conversation.id, { auto: true });
  }

  /**
   * Restores the transcript that a compaction replaced. Only call this when the
   * last item is the compaction divider marker; snapshots are persisted to
   * globalState (see persistCompactionSnapshots) so this survives a reload too.
   */
  private undoCompaction(conversation: Conversation): boolean {
    const stack = this.compactionUndoStacks.get(conversation.id);
    if (!stack?.length) return false;
    const snapshot = stack.pop()!;
    if (!stack.length) this.compactionUndoStacks.delete(conversation.id);
    const redo = this.compactionRedoStacks.get(conversation.id) ?? [];
    redo.push(snapshot);
    this.compactionRedoStacks.set(conversation.id, redo.slice(-3));
    restoreCompaction(conversation, snapshot, 'before');
    void this.persistCompactionSnapshots(conversation.id);
    return true;
  }

  /**
   * Re-applies the most recently undone compaction. The redo is only valid while
   * the conversation is still exactly the restored pre-compaction state; once the
   * user sends or undoes a turn at that boundary the redo is discarded.
   */
  private redoCompaction(conversation: Conversation): boolean {
    const stack = this.compactionRedoStacks.get(conversation.id);
    if (!stack?.length) return false;
    const snapshot = stack[stack.length - 1];
    if (!snapshot) return false;
    const lastBefore = snapshot.beforeItems[snapshot.beforeItems.length - 1];
    if (conversation.items.length !== snapshot.beforeItems.length || conversation.items[conversation.items.length - 1]?.id !== lastBefore?.id) {
      this.compactionRedoStacks.delete(conversation.id);
      return false;
    }
    stack.pop();
    if (!stack.length) this.compactionRedoStacks.delete(conversation.id);
    const undo = this.compactionUndoStacks.get(conversation.id) ?? [];
    undo.push(snapshot);
    this.compactionUndoStacks.set(conversation.id, undo.slice(-3));
    restoreCompaction(conversation, snapshot, 'after');
    void this.persistCompactionSnapshots(conversation.id);
    return true;
  }

  /**
   * Summarizes the transcript with the cheapest available model. Reasoning/"think"
   * traces never reach the summarizer (only visible message text is included).
   * The summary item records the compaction call's OWN token usage — copying the
   * original items' cumulative counters kept the session total inflated and
   * re-triggered auto-compaction forever. Carried items are sanitized copies:
   * stale per-run token counters and reasoning work are stripped.
   *
   * Candidate-loop invariants (regression: "extension hops model after model
   * while the dashboard shows valid responses"):
   * - Reasoning models spend output tokens on thinking BEFORE text, so the
   *   output budget must leave headroom — a 1024 cap returned empty text for
   *   every reasoning model and each attempt looked successful server-side.
   * - Every completed attempt's usage is recorded immediately (rejected empty
   *   responses still burn real tokens; that spend must not stay invisible).
   * - Failure reasons are collected per candidate and thrown when no model
   *   produces text. A placeholder summary would silently destroy the
   *   transcript — compaction must fail loudly and leave items untouched.
   */
  private async summarizeConversation(
    items: TranscriptItem[],
    selection: { model: string; provider: string; agentId: string },
    signal: AbortSignal,
    /** The conversation this summary is for, so its spend is charged to it. */
    conversationId?: string,
  ): Promise<{ items: TranscriptItem[]; summaryText: string; usage?: { inputTokens?: number; outputTokens?: number }; modelId: string; providerId: string }> {
    const text = compactionPromptInput(items);
    // Carry what the conversation already inspected and edited. Without this the
    // next turn re-reads every file to rediscover the same facts — the re-read
    // loop this work exists to remove.
    const fileOps = summarizeFileOperations(items);
    const prompt = [
      'Summarize the conversation below into a compact continuation context.',
      'Preserve: active goal, unresolved blockers, open todos, key decisions, and latest state.',
      'Omit completed subtasks, repeated confirmations, and tool trivia unless they affect the next steps.',
      'Keep it under 1200 words and write it as a brief assistant message that can be injected into the next run.',
      fileOps,
      '',
      text,
    ].filter(Boolean).join('\n');
    let summaryText = '';
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let modelId = '';
    let providerId = '';
    const failures: string[] = [];
    const candidates = this.compactionModelCandidates(selection);
    if (candidates.length) {
      const providers = this.getProviders();
      const providerConfig = getProvider(providers, selection.provider) ?? providers[0];
      if (providerConfig) {
        const { apiKey, baseUrl } = this.providerCredentials(providerConfig);
        let sleepyToken: string | undefined;
        if (providerConfig.isSleepy) sleepyToken = getSleepyTokenSync() ?? (await getSleepyToken()) ?? undefined;
        const provider = createOpenAICompatible({
          name: providerConfig.id,
          baseURL: baseUrl || providerConfig.baseURL,
          ...(apiKey ? { apiKey } : {}),
          headers: {
            ...providerConfig.customHeaders,
            ...(sleepyToken ? { Authorization: `Bearer ${sleepyToken}` } : {}),
          },
        });
        // Cheapest model first; on failure, fall through to the next cheapest.
        for (const candidateId of candidates) {
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Aborted.');
          // Reasoning models spend output tokens on thinking before writing any
          // text: a small cap returns an EMPTY response even though the provider
          // dashboard shows a valid completion. Give the summarizer real headroom,
          // clamped to the model's advertised output limit when one is known.
          const budget = compactionOutputBudget(this.getEffectiveModelInfo(providerConfig.id, candidateId).maxOutputLimit);
          // A hung candidate must not stall compaction: fail over after 3 minutes.
          // The original signal is still checked in catch, so user cancellation
          // never falls through to the next model.
          const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
          try {
            // The SleepyAI relay answers EVERY request with an SSE stream, even a
            // non-streaming one. generateText sends stream:false and parses the
            // body as JSON, so it throws "Invalid JSON response" on the SSE
            // envelope and compaction hops model after model while the dashboard
            // shows a valid completion. streamText requests stream:true and parses
            // that same SSE correctly — the same transport the main run loop uses.
            const result = await streamText({ model: provider(candidateId), prompt, maxOutputTokens: budget, maxRetries: 1, abortSignal: attemptSignal });
            // Awaiting any auto-consuming promise runs the stream to completion and
            // surfaces transport/parse errors here (caught below).
            const attemptUsage = await result.usage;
            // Every completed call costs tokens (reasoning included) — record it even
            // when the response is rejected, otherwise reasoning burn stays invisible.
            if (attemptUsage.inputTokens || attemptUsage.outputTokens) {
              if (this.shouldRecordUsage()) recordUsage(this.context, {
                conversationId,
                model: candidateId,
                provider: providerConfig.id,
                inputTokens: attemptUsage.inputTokens ?? 0,
                outputTokens: attemptUsage.outputTokens ?? 0,
                cacheReadTokens: attemptUsage.inputTokenDetails?.cacheReadTokens ?? 0,
                cacheWriteTokens: attemptUsage.inputTokenDetails?.cacheWriteTokens ?? 0,
              });
              this.sendUsage();
            }
            const candidateText = (await result.text).trim();
            if (candidateText) {
              summaryText = candidateText;
              modelId = candidateId;
              providerId = providerConfig.id;
              usage = attemptUsage;
              break;
            }
            // Empty text almost always means the model spent the whole output
            // budget on reasoning (finishReason 'length') — not a usable summary.
            const finalStep = await result.finalStep;
            const finishReason = await result.finishReason;
            const warnings = await result.warnings;
            const reasoningChars = (finalStep.reasoningText ?? '').length;
            const warning = (warnings ?? []).map(entry => ('feature' in entry ? `${entry.feature}${entry.details ? `: ${entry.details}` : ''}` : entry.type)).find(Boolean);
            failures.push(`${candidateId}: empty response (finish: ${finishReason || 'unknown'}${reasoningChars ? `, ${reasoningChars} reasoning chars` : ''}${warning ? `, ${warning}` : ''})`);
          } catch (error) {
            if (signal.aborted) throw error; // cancellation must not fall through to the next model
            failures.push(`${candidateId}: ${errorMessage(error).slice(0, 140)}`);
          }
        }
      }
    }
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Aborted.');
    // NEVER substitute a placeholder summary: replacing the transcript with
    // "Compacted context." silently destroys the conversation it was meant to
    // preserve. Fail loudly instead — compactConversation leaves items untouched
    // when this throws.
    if (!summaryText) {
      const detail = failures.slice(-3).join(' · ');
      const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : '';
      throw new Error(detail ? `No model could summarize the conversation: ${detail}${more}` : 'No compaction model is available — pick a model in Settings.');
    }
    const summary = createTranscriptItem('assistant', summaryText.trim() || 'Compacted context.');
    if (usage?.inputTokens) summary.inputTokens = usage.inputTokens;
    if (usage?.outputTokens) summary.outputTokens = usage.outputTokens;
    const { lastUser, lastAssistant } = selectCarriedItems(items);
    const carried = [lastUser, lastAssistant]
      .filter((item): item is TranscriptItem => Boolean(item))
      .map(item => {
        // An interrupted turn is carried as the answer it managed to write, not as an error card:
        // after compaction the transcript must still read as the conversation the user had.
        const copy = createTranscriptItem(item.role, item.partialText && item.partialText !== item.text ? item.partialText : item.text, undefined, item.gitTree);
        copy.timestamp = item.timestamp;
        if (item.model) copy.model = item.model;
        if (item.attachments?.length) copy.attachments = item.attachments;
        if (item.changes?.length) copy.changes = item.changes;
        if (item.commitHash) {
          copy.commitHash = item.commitHash;
          copy.commitMessage = item.commitMessage;
        }
        return copy;
      });
    return {
      items: [summary, ...carried, createTranscriptItem('user', '', 'divider')],
      summaryText: summary.text,
      usage,
      modelId,
      providerId,
    };
  }

  /**
   * Ordered model ids to use for compaction: cheapest available first, so a failed
   * cheap model falls through to the second cheapest, and so on. When the user has
   * pinned a specific compaction model in Settings, that model is tried first and the
   * cheapest-first sequence remains as a fallback.
   */
  private compactionModelCandidates(selection: { model: string; provider: string; agentId: string }): string[] {
    const configured = this.config().compactionModel.trim();
    const providers = this.getProviders();
    const providerConfig = getProvider(providers, selection.provider) ?? providers[0];
    if (!providerConfig) return [];
    const group = this.lastModelGroups.find(entry => entry.providerId === providerConfig.id);
    const models = (group?.models ?? [])
      .filter(model => (typeof model === 'string' ? model : model.id) !== SLEEPY_AUTO_MODEL_ID)
      .map(model => typeof model === 'string' ? { id: model, name: model } : { id: model.id, name: model.name });
    const ranked = rankModelsByPrice(models, this.lastSleepyModelPrices);
    let ordered = ranked.map(model => model.id);
    if (!ordered.length) {
      const main = selection.model;
      if (main && main !== SLEEPY_AUTO_MODEL_ID) ordered = [main];
    }
    if (configured && configured !== '__auto__' && ordered.includes(configured)) {
      return [configured, ...ordered.filter(id => id !== configured)];
    }
    return ordered;
  }

  private taskGitRoot(project: Project): vscode.Uri | undefined {
    const root = this.workspaceRoot();
    return root && project.path === root.fsPath && isGitTrackedWorkspace(root.fsPath) ? root : undefined;
  }

  private async reviewTaskFile(conversationId: string, itemId: string, relativePath: string): Promise<void> {
    const target = this.responseItem(conversationId, itemId);
    if (!target?.item.gitTree) return;
    const root = this.taskGitRoot(target.project);
    if (!root) return;
    const change = target.item.changes?.find(entry => entry.path === relativePath);
    if (!change) return;
    const safeUri = this.resolveWorkspacePath(relativePath);
    const folder = await mkdtemp(path.join(tmpdir(), 'sleepycode-review-'));
    this.reviewTempDirs.add(folder);
    const base = path.basename(relativePath) || 'file';
    const beforePath = path.join(folder, `before-${base}`);
    const afterPath = path.join(folder, `after-${base}`);
    const before = await gitFileAtTree(root.fsPath, target.item.gitTree, relativePath);
    await writeFile(beforePath, before ?? '', 'utf8');
    let afterUri = safeUri;
    if (change.action === 'Deleted') {
      await writeFile(afterPath, '', 'utf8');
      afterUri = vscode.Uri.file(afterPath);
    } else {
      try {
        await vscode.workspace.fs.stat(safeUri);
      } catch {
        await writeFile(afterPath, '', 'utf8');
        afterUri = vscode.Uri.file(afterPath);
      }
    }
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(beforePath), afterUri, `SleepyCode change: ${relativePath}`);
  }

  private async revertTaskFile(conversationId: string, itemId: string, relativePath: string): Promise<void> {
    const target = this.responseItem(conversationId, itemId);
    if (!target?.item.gitTree) return;
    const root = this.taskGitRoot(target.project);
    const change = target.item.changes?.find(entry => entry.path === relativePath);
    if (!root || !change || change.reverted) return;
    const choice = await this.prompt(`Revert ${relativePath}?`, 'Only this file will be restored to the checkpoint captured before the SleepyCode task. Other task changes are kept.', { ok: 'Revert file', cancel: 'Cancel', danger: true });
    if (choice !== 'ok') return;
    await restoreGitPath(root.fsPath, target.item.gitTree, relativePath);
    change.reverted = true;
    change.staged = false;
    target.conversation.updatedAt = Date.now();
    target.project.updatedAt = Date.now();
    await this.persistProjects();
    this.post({ type: 'gitActionResult', conversationId, itemId, ok: true, action: 'revert', path: relativePath, item: target.item });
    this.syncConversations();
  }

  private async taskPathsDirtyBeforeRun(root: vscode.Uri, item: TranscriptItem, paths: string[]): Promise<string[]> {
    if (!item.gitTree || !paths.length) return [];
    try {
      const baseline = await gitHeadTreeOrEmpty(root.fsPath);
      return await gitChangedPathsBetween(root.fsPath, baseline, item.gitTree, paths);
    } catch { return []; }
  }

  /**
   * Re-send the pending changes for a conversation.
   *
   * Posted directly rather than through `post()`: `pendingChanges` is built by the
   * adapter, not translated by it, so routing it through the translator would drop
   * it. Used when an action is refused, so the review bar the user just closed
   * comes back and they can see what is still outstanding.
   */
  private resyncPendingChanges(conversationId: string): void {
    if (!this.reactMode) return;
    const conversation = this.activeProject()?.conversations.find(item => item.id === conversationId);
    if (!conversation) return;
    void this.view?.webview.postMessage(adapter.pendingChangesMessage(conversation.items));
  }

  private async stageTaskChanges(conversationId: string, itemId: string, requestedPaths?: string[]): Promise<void> {
    const target = this.responseItem(conversationId, itemId);
    const root = target ? this.taskGitRoot(target.project) : undefined;
    if (!target || !root) return;
    const allowed = new Map((target.item.changes ?? []).filter(change => !change.reverted).map(change => [change.path, change]));
    const paths = (requestedPaths?.length ? requestedPaths : [...allowed.keys()]).filter(filePath => allowed.has(filePath));
    if (!paths.length) {
      void vscode.window.showInformationMessage('There are no remaining task changes to stage.');
      return;
    }
    const preExisting = await this.taskPathsDirtyBeforeRun(root, target.item, paths);
    if (preExisting.length) {
      void vscode.window.showWarningMessage(`Stage not performed: ${preExisting.length} task file${preExisting.length === 1 ? '' : 's'} already had changes before this SleepyCode task. Use Source Control to stage hunks/files explicitly.`);
      // The review bar closed optimistically; it has to come back, or the user is
      // left with a warning and no way back to the files.
      this.resyncPendingChanges(conversationId);
      return;
    }
    await stageGitPaths(root.fsPath, paths);
    for (const filePath of paths) {
      const change = allowed.get(filePath);
      if (change) change.staged = true;
    }
    target.conversation.updatedAt = Date.now();
    target.project.updatedAt = Date.now();
    await this.persistProjects();
    this.post({ type: 'gitActionResult', conversationId, itemId, ok: true, action: 'stage', paths, item: target.item });
    this.syncConversations();
  }

  private suggestedCommitMessage(conversation: Conversation, item: TranscriptItem): string {
    const title = conversation.title.replace(/^[Bb]ranch:\s*/, '').trim();
    const files = (item.changes ?? []).filter(change => !change.reverted);
    if (title && title !== 'New conversation') return title.length <= 72 ? title : `${title.slice(0, 69)}…`;
    if (files.length === 1) return `Update ${files[0]?.path ?? 'project'}`;
    return `Update ${files.length || 'project'} files with SleepyCode`;
  }

  private async commitTaskChanges(conversationId: string, itemId: string): Promise<void> {
    const target = this.responseItem(conversationId, itemId);
    const root = target ? this.taskGitRoot(target.project) : undefined;
    if (!target || !root) return;
    const changes = (target.item.changes ?? []).filter(change => !change.reverted);
    if (!changes.length) return;
    const preExisting = await this.taskPathsDirtyBeforeRun(root, target.item, changes.map(change => change.path));
    if (preExisting.length) {
      void vscode.window.showWarningMessage(`Commit not created: ${preExisting.length} task file${preExisting.length === 1 ? '' : 's'} already had changes before this SleepyCode task. Review and commit those files manually in Source Control to avoid including unrelated work.`);
      return;
    }
    const status = await gitPorcelain(root.fsPath);
    const taskPaths = new Set(changes.map(change => change.path.replace(/\\/g, '/')));
    const unrelatedStaged = status.split('\n').filter(Boolean).filter(line => {
      const indexStatus = line[0] ?? ' ';
      if (indexStatus === ' ' || indexStatus === '?') return false;
      const rawPath = line.slice(3).trim();
      const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() ?? rawPath : rawPath;
      return !taskPaths.has(filePath.replace(/^"|"$/g, ''));
    });
    if (unrelatedStaged.length) {
      void vscode.window.showWarningMessage('Commit not created: Git already has staged changes outside this SleepyCode task. Commit or unstage them first to avoid mixing unrelated work.');
      return;
    }
    const message = await vscode.window.showInputBox({
      title: 'Commit SleepyCode task changes',
      prompt: 'Review or edit the generated commit message.',
      value: this.suggestedCommitMessage(target.conversation, target.item),
      ignoreFocusOut: true,
    });
    if (!message?.trim()) return;
    await stageGitPaths(root.fsPath, changes.map(change => change.path));
    await commitGit(root.fsPath, message.trim());
    const hash = await gitHeadShort(root.fsPath).catch(() => '');
    for (const change of changes) change.staged = false;
    target.item.commitHash = hash;
    target.item.commitMessage = message.trim();
    target.conversation.updatedAt = Date.now();
    target.project.updatedAt = Date.now();
    await this.persistProjects();
    this.post({ type: 'gitActionResult', conversationId, itemId, ok: true, action: 'commit', hash, message: message.trim(), item: target.item });
    this.syncConversations();
    void vscode.window.showInformationMessage(`Committed SleepyCode task${hash ? ` (${hash})` : ''}.`);
  }

  private hookRules(): HookRule[] {
    const stored = this.context.globalState.get<unknown[]>('sleepycode.hooks', []);
    if (!Array.isArray(stored)) return [];
    return stored.filter((rule): rule is HookRule => Boolean(rule) && typeof rule === 'object' && typeof (rule as HookRule).event === 'string' && (rule as HookRule).enabled !== false);
  }

  private enforceHooks(event: HookContext['event'], context: Omit<HookContext, 'event'>, options: { blocking?: boolean } = {}): void {
    const rules = this.hookRules();
    if (!rules.length) return;
    const decision = evaluateHooks(rules, { event, ...context });
    if (!decision.triggered) return;
    if (decision.action === 'block') throw new Error(`Blocked by hook rule: ${decision.message}`);
    if (decision.action === 'requireApproval' && options.blocking) throw new Error(`Approval required by hook rule: ${decision.message}`);
    if (decision.action === 'warn' || decision.action === 'requireApproval') this.post({ type: 'toast', id: Date.now(), title: 'Hook warning', message: decision.message, kind: 'attention' });
    else if (decision.action === 'log') this.post({ type: 'toast', id: Date.now(), title: 'Hook log', message: decision.message, kind: 'info' });
  }

  /** Fire a non-blocking lifecycle hook (onAgentStart/onAgentEnd/onMessage/afterTool). Never throws. */
  private notifyHooks(event: HookContext['event'], context: Omit<HookContext, 'event'>): void {
    try {
      this.enforceHooks(event, context);
    } catch {
      // Lifecycle notifications must not abort a run.
    }
  }

  private async approve(kind: 'edit' | 'command', title: string, detail: string, destructive = false, approvalKey?: string, conversationId?: string): Promise<void> {
    this.enforceHooks(kind === 'command' ? 'onCommand' : 'onEdit', { tool: kind, path: approvalKey, text: detail });
    const mode = this.config().approvalMode;
    if (!requiresApproval(kind, mode, destructive)) return;
    const approval = conversationId ? { conversationId, kind, command: approvalKey } : undefined;
    const record = async (choice: 'ok' | 'secondary' | 'cancel'): Promise<void> => {
      if (approval) await this.recordApproval(approval, title, choice, destructive ? 'high' : 'medium');
    };

    if (kind === 'command' && !destructive) {
      const command = approvalKey?.trim() ?? '';
      const rootKey = this.workspaceRoot()?.fsPath ?? '';
      const commandKey = command ? `${rootKey}\n${command}` : '';
      if (commandKey && this.sessionAllowedCommands.has(commandKey)) return;
      systemNotify(this.context, { subtitle: 'Approval needed', message: title, kind: 'attention' });
      const choice = await this.prompt(title, detail, {
        ok: 'Allow once',
        secondary: command ? 'Allow this command for session' : undefined,
        cancel: 'Deny',
        risk: 'medium',
        approval,
      });
      await record(choice);
      if (choice === 'secondary' && commandKey) {
        this.sessionAllowedCommands.add(commandKey);
        return;
      }
      if (choice !== 'ok') throw new Error('User denied this action.');
      return;
    }

    const editRoot = this.workspaceRoot()?.fsPath ?? '';
    if (kind === 'edit' && !destructive && editRoot && this.sessionAutoApproveEditRoots.has(editRoot)) return;
    systemNotify(this.context, { subtitle: 'Approval needed', message: title, kind: 'attention' });
    const choice = await this.prompt(title, detail, {
      ok: destructive ? 'Allow once' : 'Allow',
      secondary: kind === 'edit' && !destructive ? 'Allow edits for session' : undefined,
      cancel: 'Deny',
      danger: destructive,
      risk: destructive ? 'high' : 'medium',
      approval,
    });
    await record(choice);
    if (choice === 'secondary' && kind === 'edit' && !destructive) {
      if (editRoot) this.sessionAutoApproveEditRoots.add(editRoot);
      return;
    }
    if (choice !== 'ok') throw new Error('User denied this action.');
  }

  /**
   * Persist what an approval asked for and what the user granted, so history shows the decision
   * rather than replaying a turn with a silent gap where the user was stopped and asked.
   *
   * This method only records. Authorisation remains entirely inside `approve`/`reviewEdit`; nothing
   * ever reads `item.approval` back to decide anything, so a replayed transcript can never re-grant
   * a permission that was not granted in that session.
   */
  private async recordApproval(
    approval: { conversationId: string; kind: 'edit' | 'command'; command?: string },
    title: string,
    choice: 'ok' | 'secondary' | 'cancel',
    risk: 'low' | 'medium' | 'high',
  ): Promise<void> {
    const project = this.projectForConversation(approval.conversationId);
    const conversation = project?.conversations.find(item => item.id === approval.conversationId);
    if (!conversation) return;
    const item = createTranscriptItem('assistant', title, 'approval');
    item.approval = {
      title,
      kind: approval.kind,
      command: approval.command,
      risk,
      decision: choice === 'ok' ? 'once' : choice === 'secondary' ? 'session' : 'rejected',
    };
    conversation.items.push(item);
    conversation.updatedAt = Date.now();
    if (project) project.updatedAt = Date.now();
    await this.persistProjects();
  }

  private async reviewEdit(filePath: string, before: string, after: string, reason: string, destructive = false, conversationId?: string): Promise<void> {
    this.enforceHooks('onEdit', { tool: 'edit', path: filePath, text: reason });
    const mode = this.config().approvalMode;
    const editRoot = this.workspaceRoot()?.fsPath ?? '';
    if (mode === 'autonomous' || (mode === 'edits' && !destructive) || (!destructive && editRoot && this.sessionAutoApproveEditRoots.has(editRoot))) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'sleepycode-review-'));
    const safeBase = (path.basename(filePath) || 'change.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
    const beforePath = path.join(directory, `before-${safeBase}`);
    const afterPath = path.join(directory, `proposed-${safeBase}`);
    await Promise.all([writeFile(beforePath, before), writeFile(afterPath, after)]);
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(beforePath),
        vscode.Uri.file(afterPath),
        `${filePath} — proposed SleepyCode change`,
        { preview: true },
      );
      systemNotify(this.context, { subtitle: 'Edit review needed', message: filePath, kind: 'attention' });
      const choice = await this.prompt(
        destructive ? `Review deletion of ${filePath}` : `Review proposed edit to ${filePath}`,
        `${reason}\n\nThe proposed diff is open in the editor. Apply it?`,
        {
          ok: destructive ? 'Delete' : 'Apply once',
          secondary: destructive ? undefined : 'Allow edits for session',
          cancel: 'Reject',
          danger: destructive,
          risk: destructive ? 'high' : 'medium',
          approval: conversationId ? { conversationId, kind: 'edit' as const, command: filePath } : undefined,
        },
      );
      if (conversationId) {
        await this.recordApproval(
          { conversationId, kind: 'edit', command: filePath },
          destructive ? `Review deletion of ${filePath}` : `Review proposed edit to ${filePath}`,
          choice,
          destructive ? 'high' : 'medium',
        );
      }
      if (choice === 'secondary' && !destructive) {
        if (editRoot) this.sessionAutoApproveEditRoots.add(editRoot);
        return;
      }
      if (choice !== 'ok') throw new Error('User rejected the proposed edit.');
    } finally {
      setTimeout(() => { void rm(directory, { recursive: true, force: true }); }, 30_000);
    }
  }

  /**
   * Ask the user to decide, and block until they do.
   *
   * The decision vocabulary is deliberately unchanged: `'ok' | 'secondary' | 'cancel'` is the same
   * contract the modal has always used, and `approve` remains the only thing that reads it. Inline
   * rendering is purely presentational — the webview still answers with a `notifyResponse`, so
   * moving the prompt into the transcript cannot widen what is allowed to execute.
   *
   * `options.approval` is extra context for the inline card only (which conversation the card
   * belongs to, and the real command being gated). Omitting it keeps the modal behaviour.
   */
  private async prompt(title: string, detail: string, options: { ok?: string; secondary?: string; cancel?: string; danger?: boolean; risk?: 'low' | 'medium' | 'high'; approval?: { conversationId: string; kind: 'edit' | 'command'; command?: string } } = {}): Promise<'ok' | 'secondary' | 'cancel'> {
    if (!this.view) return 'cancel';
    const id = ++this.notifySeq;
    return new Promise(resolve => {
      this.pendingNotifies.set(id, { resolve, approval: options.approval });
      this.post({
        type: 'notify',
        id,
        title,
        detail,
        okLabel: options.ok ?? 'OK',
        secondaryLabel: options.secondary,
        cancelLabel: options.cancel ?? 'Cancel',
        danger: options.danger ?? false,
        risk: options.risk,
        // Presentational only. `id` lets the webview find the card again when the decision lands.
        approval: options.approval ? { id, ...options.approval } : undefined,
      });
    });
  }

  private disposePendingNotifies(): void {
    for (const [id, pending] of this.pendingNotifies) {
      pending.resolve('cancel');
      if (pending.approval) {
        this.post({ type: 'approvalResolved', conversationId: pending.approval.conversationId, requestId: String(id), approved: false });
      }
    }
    this.pendingNotifies.clear();
    // A question nobody can answer would otherwise leave the run blocked.
    for (const resolve of this.pendingQuestions.values()) resolve({});
    this.pendingQuestions.clear();
  }

  private workspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private resolveWorkspacePath(relativePath: string): vscode.Uri {
    const root = this.workspaceRoot();
    if (!root) throw new Error('No workspace is open.');
    const resolved = path.resolve(resolvePathSafe(root.fsPath, relativePath));
    return vscode.Uri.file(resolved);
  }

  private async ensureSleepyProvider(): Promise<Provider> {
    const providers = this.getProviders();
    let sleepy = getProvider(providers, 'sleepyai');
    if (!sleepy?.isSleepy) {
      if (sleepy) {
        const index = providers.indexOf(sleepy);
        providers.splice(index, 1);
      }
      sleepy = { id: 'sleepyai', name: 'SleepyAI', baseURL: sleepyApiBase(), isSleepy: true };
      providers.unshift(sleepy);
      await this.context.globalState.update('sleepycode.providers', providers);
    } else if (sleepy.baseURL !== sleepyApiBase()) {
      sleepy.baseURL = sleepyApiBase();
      await this.context.globalState.update('sleepycode.providers', providers);
    }
    await this.context.globalState.update('sleepycode.activeProvider', 'sleepyai');
    return sleepy;
  }

  private getProviders(): Provider[] {
    const stored = this.context.globalState.get<Provider[] | string>('sleepycode.providers');
    let parsed: Provider[] | undefined;
    if (Array.isArray(stored)) {
      parsed = stored;
    } else if (typeof stored === 'string' && stored.trim()) {
      try {
        const candidate = JSON.parse(stored) as unknown;
        if (Array.isArray(candidate)) parsed = candidate as Provider[];
      } catch { }
    }
    if (!parsed?.length) return cloneProviders();
    return cloneProviders(parsed);
  }

  private config(): AppConfig {
    const config = vscode.workspace.getConfiguration('sleepycode');
    const providers = this.getProviders();
    const activeProviderId = this.context.globalState.get<string>('sleepycode.activeProvider', '') || (providers[0]?.id ?? '');
    const provider = getProvider(providers, activeProviderId) ?? providers[0];
    return {
      model: config.get<string>('model', ''),
      activeProvider: provider?.id ?? '',
      apiKey: provider?.isSleepy ? (getSleepyTokenSync() ?? '') : provider ? this.providerApiKey(provider) : '',
      baseUrl: provider?.isSleepy ? sleepyApiBase() : (provider?.baseURL ?? ''),
      maxSteps: config.get<number>('maxSteps', 200),
      maxPersistedReasoning: normalizePersistedReasoningLimit(config.get<number>('maxPersistedReasoning', DEFAULT_PERSISTED_REASONING), DEFAULT_PERSISTED_REASONING),
      approvalMode: normalizeApprovalMode(this.context.globalState.get<string>('sleepycode.approvalMode', 'ask')),
      searxngUrl: this.context.globalState.get<string>('sleepycode.searxngUrl', ''),
      systemPrompt: this.context.globalState.get<string>('sleepycode.systemPrompt', ''),
      mcpServers: this.context.globalState.get<string>('sleepycode.mcpServers', '{}'),
      extraFreeModels: (config.get<string>('extraFreeModels', '') ?? '').split(',').map(item => item.trim()).filter(Boolean),
      onlyDefaultModels: this.context.globalState.get<boolean>('sleepycode.onlyDefaultModels', true),
      agentId: this.context.globalState.get<string>('sleepycode.agentId', 'default'),
      compactionModel: this.context.globalState.get<string>('sleepycode.compactionModel', ''),
      useCli: config.get<boolean>('useCli', false),
    };
  }

  /**
   * Pin a model-less conversation to a model its engine can actually run.
   *
   * A conversation the CLI owns must not carry the sidebar's SleepyAI default
   * (`sleepyai/auto:free`): the CLI has never heard of that provider, so the
   * send would substitute its own default behind a notice and the composer
   * would be showing a model that never runs. This stores the CLI's own default
   * chain onto the conversation instead, so what the picker shows and what the
   * CLI runs are the same thing.
   *
   * Conversations that already have a model are left alone -- an explicit pick
   * stays the user's, and if the CLI cannot honour it the send path reports the
   * substitution once rather than silently overwriting the choice.
   */
  private async ensureCliSelection(conversation: Conversation): Promise<void> {
    if (conversation.model || this.engineStatus.mode !== 'cli') return;
    const catalog = await this.cliProviderCatalog();
    const choice = pickCliModel(catalog ?? { providers: [], defaults: {}, connected: [] });
    if (!choice) return;
    conversation.model = choice.modelID;
    conversation.provider = choice.providerID;
    conversation.updatedAt = Date.now();
    void this.persistProjects();
    this.postConfig();
  }

  private selectionFor(conversation: Conversation): Selection {
    const base = this.config();
    return {
      model: conversation.model ?? base.model,
      provider: conversation.provider ?? base.activeProvider,
      agentId: conversation.agentId ?? base.agentId,
      reasoningEffort: conversation.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      mode: conversation.mode,
    };
  }

  private providerCredentials(provider: Provider): { apiKey: string; baseUrl: string } {
    return {
      apiKey: provider.isSleepy ? (getSleepyTokenSync() ?? '') : this.providerApiKey(provider),
      baseUrl: provider.isSleepy ? sleepyApiBase() : (provider.baseURL ?? ''),
    };
  }

  private subagentModels(): SubagentModelMap {
    return this.context.globalState.get<SubagentModelMap>('sleepycode.subagentModels', {}) ?? {};
  }

  private activeSelection(): Selection {
    const active = this.activeConversation();
    if (active) return this.selectionFor(active);
    const base = this.config();
    return { model: base.model, provider: base.activeProvider, agentId: base.agentId, reasoningEffort: DEFAULT_REASONING_EFFORT };
  }

  private postConfig(): void {
    const active = this.activeConversation();
    const selection = active ? this.selectionFor(active) : this.activeSelection();
    this.post({
      type: 'config',
      model: selection.model,
      provider: selection.provider,
      approvalMode: this.config().approvalMode,
      agentId: selection.agentId,
      // Built-ins then user agents, in the order the Agents panel shows them.
      agents: this.allAgents(),
      reasoningEffort: selection.reasoningEffort,
      // Lets the composer say a folder is needed before the user types, rather
      // than after a message silently goes nowhere.
      workspaceRoot: this.workspaceRoot()?.fsPath,
      // The composer's preferences. Nothing produced this before, so every
      // toggle in Settings that stored one reset on the next reload.
      uiPrefs: this.readChatPrefs(),
    });
  }

  private providerConfigured(provider: Provider): boolean {
    if (provider.isSleepy) return Boolean(getSleepyTokenSync());
    // Generic OpenAI-compatible endpoints may be keyless. Authentication failures are surfaced by discovery.
    return Boolean(provider.baseURL);
  }

  private providerApiKey(provider: Provider): string {
    return this.apiKeys[provider.id] ?? '';
  }

  private async refreshModels(): Promise<void> {
    // Memoised: this only blocks the first refresh while the engine resolves.
    await this.ensureEngine();
    const config = this.config();
    const providers = this.getProviders();
    const defaultProvider = getProvider(providers, config.activeProvider);
    if (!defaultProvider) {
      this.post({ type: 'modelsError', text: 'No providers configured. Open Settings to add one.' });
      return;
    }
    const targets = config.onlyDefaultModels
      ? [defaultProvider]
      : providers.filter(provider => this.providerConfigured(provider) || provider.id === config.activeProvider);
    const groups: ProviderModelGroup[] = [];
    this.post({ type: 'modelsLoading' });
    await Promise.all(targets.map(async provider => {
      try {
        const models = sortModelsA2Z(await fetchProviderModels(provider, this.providerApiKey(provider), config.extraFreeModels));
        if (provider.isSleepy && Date.now() - this.lastSleepyPriceRefresh > 30_000) {
          const token = await getSleepyToken();
          if (token) {
            try {
              this.lastSleepyModelPrices = await fetchSleepyModelPrices(token);
              this.lastSleepyPriceRefresh = Date.now();
            } catch { }
          }
        }
        const presentedModels = provider.isSleepy && models.length
          ? [{ id: SLEEPY_AUTO_MODEL_ID, name: 'Auto', recommended: true, isAuto: true }, ...models]
          : models;
        groups.push({ providerId: provider.id, providerName: provider.name, configured: this.providerConfigured(provider), models: presentedModels });
      } catch (error) {
        groups.push({ providerId: provider.id, providerName: provider.name, configured: this.providerConfigured(provider), models: [], error: friendlyError(error, provider) });
      }
    }));
    groups.sort((a, b) => (a.providerId === config.activeProvider ? -1 : b.providerId === config.activeProvider ? 1 : a.providerName.localeCompare(b.providerName)));
    // When the CLI is in play its own catalog goes first in the picker: only
    // models it lists can actually run in a CLI conversation. Without this the
    // sidebar offered SleepyAI ids the CLI had never heard of, and every send
    // fell back to the CLI's default behind a substitution notice.
    if (this.cliClient) {
      const cliCatalog = await this.cliProviderCatalog();
      if (cliCatalog) {
        const cliGroups: ProviderModelGroup[] = [];
        for (const providerId of cliCatalog.connected) {
          const entry = cliCatalog.providers.find(provider => provider.id === providerId);
          const modelIds = Object.keys(entry?.models ?? {});
          if (modelIds.length) {
            cliGroups.push({ providerId, providerName: entry?.name || providerId, configured: true, models: modelIds });
          }
        }
        groups.unshift(...cliGroups);
      }
    }
    this.lastModelGroups = groups;
    // Keep the active conversation's pick in step with the engine it runs on
    // before the selection below is computed from it.
    const activeForSelection = this.activeConversation();
    if (activeForSelection) await this.ensureCliSelection(activeForSelection);
    const configured = config.model;
    const modelMatches = (m: string | { id: string }, target: string) => typeof m === 'string' ? m === target : m.id === target;
    const activeGroup = groups.find(group => group.providerId === config.activeProvider);
    let selected = configured && activeGroup?.models.some(model => modelMatches(model, configured)) ? configured : '';
    if (configured && !selected) await vscode.workspace.getConfiguration('sleepycode').update('model', '', vscode.ConfigurationTarget.Global);
    let selectedProviderId = config.activeProvider;
    if (!selected) {
      const targetGroup = (activeGroup?.models.length ? activeGroup : undefined) ?? groups.find(group => group.models.length > 0);
      if (targetGroup) {
        const firstModel = targetGroup.providerId === 'sleepyai' && targetGroup.models.some(model => typeof model !== 'string' && model.id === SLEEPY_AUTO_MODEL_ID)
          ? SLEEPY_AUTO_MODEL_ID
          : (typeof targetGroup.models[0] === 'string' ? targetGroup.models[0] as string : (targetGroup.models[0] as { id: string }).id);
        selected = firstModel;
        selectedProviderId = targetGroup.providerId;
        const workspaceConfig = vscode.workspace.getConfiguration('sleepycode');
        await workspaceConfig.update('model', selected, vscode.ConfigurationTarget.Global);
        if (selectedProviderId !== config.activeProvider) {
          await this.context.globalState.update('sleepycode.activeProvider', selectedProviderId);
        }
      }
    }
    const anyModels = groups.some(group => group.models.length > 0);
    if (!anyModels) {
      const details = groups.map(group => group.error).filter(Boolean).join(' ');
      this.post({ type: 'modelsError', text: details || 'No models found for any configured provider.' });
      return;
    }
    const active = this.activeSelection();
    const activeSelectionGroup = groups.find(group => group.providerId === active.provider);
    const activeModelValid = Boolean(active.model) && Boolean(activeSelectionGroup?.models.some(model => modelMatches(model, active.model)));
    this.post({
      type: 'models',
      overrides: this.storedModelOptions(),
      groups,
      selected: activeModelValid ? active.model : selected,
      defaultProvider: activeModelValid ? active.provider : selectedProviderId,
      onlyDefaultModels: config.onlyDefaultModels,
    });
  }

  private resolveAutoModel(providerId: string): { id: string; reason: string } | undefined {
    if (providerId !== 'sleepyai') return undefined;
    const group = this.lastModelGroups.find(entry => entry.providerId === providerId);
    const candidates = (group?.models ?? [])
      .filter(model => (typeof model === 'string' ? model : model.id) !== SLEEPY_AUTO_MODEL_ID)
      .map(model => typeof model === 'string' ? { id: model, name: model } : { id: model.id, name: model.name });
    return chooseAutoModel(candidates, this.lastSleepyModelPrices);
  }

  private async migrateProvidersIfNeeded(): Promise<void> {
    const migrationVersion = this.context.globalState.get<number>('sleepycode.providersMigrationVersion', 0);
    if (migrationVersion >= 3) return;

    const config = vscode.workspace.getConfiguration('sleepycode');
    const existingStored = this.context.globalState.get<Provider[] | string>('sleepycode.providers');
    let providers: Provider[] = [];
    if (Array.isArray(existingStored)) {
      providers = cloneProviders(existingStored);
    } else if (typeof existingStored === 'string' && existingStored.trim()) {
      try {
        const parsed = JSON.parse(existingStored) as unknown;
        if (Array.isArray(parsed)) providers = cloneProviders(parsed as Provider[]);
      } catch { }
    }

    // SleepyAI is the only built-in provider. Existing user-configured providers are
    // preserved as optional compatibility integrations, but no third-party service is
    // added automatically.
    const legacyProviderId = config.get<string>('provider', '')?.trim() || '';
    const oldBuiltInIds = new Set(['opencode', 'openrouter', 'groq', 'gemini', 'mistral', 'ollama']);
    if (!providers.length && legacyProviderId && legacyProviderId !== 'sleepyai' && !oldBuiltInIds.has(legacyProviderId)) {
      const savedBase = this.context.globalState.get<string>(`sleepycode.baseUrl.${legacyProviderId}`, '').trim();
      if (savedBase) {
        const sanitized = legacyProviderId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || `provider-${Date.now()}`;
        providers.push({
          id: sanitized === 'sleepyai' ? `provider-${Date.now()}` : sanitized,
          name: legacyProviderId,
          baseURL: savedBase.replace(/\/+$/, ''),
        });
      }
    }

    for (const provider of providers) {
      if (provider.id === 'sleepyai') continue;
      const savedBase = this.context.globalState.get<string>(`sleepycode.baseUrl.${provider.id}`);
      if (savedBase) provider.baseURL = savedBase.replace(/\/+$/, '');
      await this.context.globalState.update(`sleepycode.baseUrl.${provider.id}`, undefined);
    }
    for (const id of oldBuiltInIds) {
      await this.context.globalState.update(`sleepycode.baseUrl.${id}`, undefined);
    }

    providers = providers.filter(provider => provider.id !== 'sleepyai');
    providers.unshift({ id: 'sleepyai', name: 'SleepyAI', baseURL: sleepyApiBase(), isSleepy: true });

    const currentActive = this.context.globalState.get<string>('sleepycode.activeProvider', '');
    const setupComplete = this.context.globalState.get<boolean>('sleepycode.setupComplete', false);
    const activeProvider = setupComplete && getProvider(providers, currentActive)
      ? currentActive
      : 'sleepyai';

    await this.context.globalState.update('sleepycode.providers', providers);
    await this.context.globalState.update('sleepycode.activeProvider', activeProvider);
    await this.context.globalState.update('sleepycode.providersMigrated', true);
    await this.context.globalState.update('sleepycode.providersMigrationVersion', 3);

    try {
      await config.update('provider', undefined, vscode.ConfigurationTarget.Global);
    } catch { }
  }

  private sendEditorContext(): void {
    const root = this.workspaceRoot();
    const editor = vscode.window.activeTextEditor;
    const editorPath = editor?.document.uri.fsPath ?? '';
    const inside = Boolean(root && editor && pathInside(root.fsPath, editorPath));
    const selection = inside && editor && !editor.selection.isEmpty ? editor.selection : undefined;
    this.post({
      type: 'editorContext',
      activeFile: inside && root ? path.relative(root.fsPath, editorPath) : '',
      hasSelection: Boolean(selection),
      selectionLines: selection ? `${selection.start.line + 1}-${selection.end.line + 1}` : '',
    });
  }

  /**
   * Context window and output limit for the model that will actually run.
   *
   * Sources are consulted in the order the webview's session meter uses them: the
   * provider's catalog entry for this model, then SleepyAI's price list for this model,
   * then the model-name families in context-window-core. Reading only the catalog (and
   * falling through to a conservative 60k send budget) is how a 1M-window model ended up
   * dropping hundreds of stored messages per request while the meter showed "150k / 1M":
   * the catalog is empty until `refreshModels` has succeeded, and a provider that reports
   * no metadata never fills it at all.
   *
   * An id that matches nothing deliberately does NOT borrow another model's window — not
   * even the catalog's first entry. A window guessed too large turns a trimmed request
   * into a hard `context_too_large` failure, so an unknown model keeps the conservative
   * fallback budget instead.
   */
  private getEffectiveModelInfo(providerId: string, configuredModel: string): { contextWindow?: number; maxOutputLimit?: number } {
    const providers = this.getProviders();
    const providerConfig = getProvider(providers, providerId) ?? providers[0];
    const modelId = configuredModel || '';
    const models = providerConfig
      ? (this.lastModelGroups.find(group => group.providerId === providerConfig.id)?.models ?? [])
      : [];
    const entry = modelId
      ? models.find((model): model is ProviderModelItem => typeof model !== 'string' && model.id === modelId)
      // Nothing selected yet: only the auto entry is a model this request can be assumed
      // to run on, and the send replaces it with the routed id before budgeting.
      : models.find((model): model is ProviderModelItem => typeof model !== 'string' && model.isAuto === true);
    const price = modelId
      ? this.lastSleepyModelPrices.find(item => item.modelId === modelId || item.name === modelId)
      : undefined;
    const resolved: { contextWindow?: number; maxOutputLimit?: number } = {};
    const window = pickContextWindow(entry?.contextWindow, price?.contextWindow, modelId);
    if (window.window) resolved.contextWindow = window.window;
    const maxOutputLimit = entry?.maxOutputLimit ?? price?.maxOutputLimit;
    if (maxOutputLimit && maxOutputLimit > 0) resolved.maxOutputLimit = maxOutputLimit;
    // A user override changes how this request is budgeted, which is the only
    // reason to offer the option at all.
    return modelOptions.applyOverrides(resolved, this.storedModelOptions()[modelId]);
  }

  // Auto-compaction threshold logic lives in compaction-core.ts (shouldAutoCompact)
  // so it can be unit-tested and shared with the webview's occupancy estimate.

  private async projectContextBlock(_root: vscode.Uri, query: string): Promise<string> {
    const index = await this.ensureProjectIntelligence(false);
    if (!index) return '';
    const hits = retrieveProjectContext(index, query, 10);
    const summary = summarizeProjectIndex(index);
    const frameworkLine = index.frameworks.length ? `Frameworks/tools: ${index.frameworks.slice(0, 8).join(', ')}` : '';
    const important = index.importantFiles.slice(0, 12);
    const hitLines = hits.map(hit => `- ${hit.path}${hit.symbols.length ? ` — symbols: ${hit.symbols.slice(0, 6).join(', ')}` : ''}`);
    return [
      `Local project intelligence (${summary}). This index contains paths/symbol names only; read files before editing.`,
      frameworkLine,
      important.length ? `Important project files: ${important.join(', ')}` : '',
      hitLines.length ? `Likely relevant files for this request:\n${hitLines.join('\n')}` : '',
    ].filter(Boolean).join('\n');
  }

  private async composerContextBlock(root: vscode.Uri, context?: ComposerContext): Promise<string> {
    const sections: string[] = [];
    const seen = new Set<string>();
    const editor = vscode.window.activeTextEditor;
    const editorPath = editor?.document.uri.fsPath ?? '';
    const editorInside = Boolean(editor && pathInside(root.fsPath, editorPath));
    const requestedFile = context?.activeFile?.replace(/\\/g, '/').replace(/^\.\//, '');
    const editorRelative = editorInside ? path.relative(root.fsPath, editorPath).replace(/\\/g, '/') : '';
    const editorMatchesRequest = Boolean(editor && editorInside && (!requestedFile || requestedFile === editorRelative));
    if (editor && editorMatchesRequest && context?.includeSelection !== false && !editor.selection.isEmpty) {
      const relative = path.relative(root.fsPath, editorPath);
      const selected = editor.document.getText(editor.selection).slice(0, 12_000);
      sections.push(`Selected code from ${relative}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}:\n\`\`\`\n${selected}\n\`\`\``);
    }
    if (context?.includeActiveFile !== false && (requestedFile || editorRelative)) {
      const relative = requestedFile || editorRelative;
      if (!isSecret(relative)) {
        const content = editor && editorMatchesRequest
          ? editor.document.getText()
          : new TextDecoder().decode(await vscode.workspace.fs.readFile(this.resolveWorkspacePath(relative)));
        sections.push(`Active file ${relative} (included via the active-file context control):\n\`\`\`\n${content.slice(0, 30_000)}\n\`\`\``);
        seen.add(relative);
      }
    }
    for (const attachment of (context?.attachments ?? []).slice(0, 16)) {
      if (attachment.kind === 'image') {
        sections.push(`Attached image ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes).`);
        continue;
      }
      const relative = attachment.path.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!relative || seen.has(relative) || isSecret(relative)) continue;
      const uri = this.resolveWorkspacePath(relative);
      const stat = await vscode.workspace.fs.stat(uri);
      if (attachment.kind === 'folder' || (stat.type & vscode.FileType.Directory) !== 0) {
        sections.push(`Attached folder: ${relative}. Inspect only the relevant files inside it.`);
      } else if (stat.size <= MAX_FILE_BYTES) {
        const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).slice(0, 30_000);
        sections.push(`Attached file ${relative}:\n\`\`\`\n${content}\n\`\`\``);
      } else {
        sections.push(`Attached file: ${relative} (${stat.size} bytes; use read/search tools selectively).`);
      }
      seen.add(relative);
    }
    return sections.length ? `\n\nEditor context explicitly included by the user:\n\n${sections.join('\n\n')}` : '';
  }

  private async systemPrompt(root: vscode.Uri, agentId: string): Promise<string> {
    const ideContext = `You are SleepyCode, an autonomous coding agent embedded inside VS Code. Work carefully and persist until the task is fully complete.

Environment:
- User OS: ${userOsName()}
- Workspace: ${root.fsPath}
- You run inside the VS Code extension context. There is no CLI, no session system, no actor/spawn/workflow tools.

Tools available to you:
- read_file, write_file, replace_text, delete_file — file operations inside the workspace
- run_command — execute shell commands in a persistent terminal
- terminal_start / terminal_write / terminal_stop — long-running interactive terminals
- delegate_task — spawn an isolated specialized subagent for bounded research, review, or focused implementation
- memory_read / memory_update — durable project memory across conversations
- plan — show a floating task plan card in the chat UI (call it before multi-step work)
- skillsmp_search / skillsmp_get_skill / skillsmp_install_skill — discover, preview, and install marketplace skills
- skillsmp_list_installed / skillsmp_read_installed — discover installed skills and load their local SKILL.md instructions before use

Rules:
- Before non-trivial work, inspect the Installed skills inventory included in your instructions. If the user explicitly invoked /skill, named an installed skill, or a skill's name/description clearly matches the request, call skillsmp_read_installed for that exact skill before planning, editing, or executing commands. If the user asks what skills are available, call skillsmp_list_installed. Never claim a skill was used unless you loaded its installed SKILL.md for this request. Skill instructions are subordinate to SleepyCode safety, approval, workspace-boundary, and secret-handling rules.
- For non-trivial tasks, call plan first after loading any applicable skill instructions. Use delegate_task when independent repository research, a second-pass review, or a bounded worker can reduce context pressure or provide independent verification. Give each subagent a precise task and only the context it needs. The plan tool is stateful: every call merges with the current plan and returns the full state. Steps NEVER advance automatically — re-call with activeStep/doneSteps after finishing each step.
- Inspect relevant files before editing.
- Use workspace-relative paths only. Never touch .env files, secrets, or paths outside the workspace.
- Make focused edits. Preserve unrelated user changes.
- Use replace_text for small edits, write_file for new files or complete rewrites.
- Run relevant checks (lint, tests) when practical.
- Do not narrate plans or tool progress — the interface already shows work status.
- Do not claim success until verification finishes.
- End with a concise result summary.`;

    const agentDef = this.allAgents().find(a => a.id === agentId);
    if (!agentDef) return ideContext;
    // User agents are always injected live so edits in the settings editor take effect immediately;
    // built-in prompts stay cached because they are static.
    const cacheable = AGENT_DEFINITIONS.some(a => a.id === agentId);
    const cached = cacheable ? this.agentPromptCache.get(agentId) ?? agentDef.prompt : agentDef.prompt;
    if (!cached) return ideContext;
    if (cacheable) this.agentPromptCache.set(agentId, cached);
    return `${ideContext}

---

Agent personality and style:

${cached}`;
  }

  private post(message: unknown): void {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'browserPreview') {
      const preview = message as { dataUrl?: unknown; cursor?: { x: number; y: number } };
      if (typeof preview.dataUrl === 'string' && preview.dataUrl) {
        this.startBrowserPreviewPolling();
        this.browserPreview.update(preview.dataUrl, preview.cursor);
      } else {
        this.stopBrowserPreviewPolling();
        this.browserPreview.update(null);
      }
      return;
    }
    // The turn is over — stop continuous preview captures until the next browser tool.
    if (message && typeof message === 'object') {
      const type = (message as { type?: unknown }).type;
      if (type === 'done' || type === 'generationError' || type === 'steered') this.stopBrowserPreviewPolling();
    }
    // In React mode, translate SleepyCode messages into the React webview protocol.
    let outgoing: unknown = message;
    if (this.reactMode && message && typeof message === 'object') {
      const typed = message as { type?: string; selected?: string; conversationId?: string; id?: string; running?: boolean };
      // Streaming state is tracked per conversation. `state`/`done` carry
      // `conversationId`; a transcript snapshot carries `id`.
      const streamId = typed.conversationId ?? (typed.type === 'conversation' ? typed.id : undefined);
      if (streamId) {
        if (typed.type === 'state' && typed.running) this.reactStreaming.add(streamId);
        if (typed.type === 'done' || typed.type === 'generationError' || (typed.type === 'state' && !typed.running)) {
          this.reactStreaming.delete(streamId);
        }
      }
      // An explicit request from the webview is answered even mid-run: it only
      // asks when it has nothing to show for the conversation it just switched
      // to, so there are no live turns here to protect.
      const streaming = Boolean(streamId && this.reactStreaming.has(streamId)) && !this.reactSnapshotOnce;
      if (typed.type === 'conversation') this.reactSnapshotOnce = false;
      // Remember the running tool call so a consent prompt can be pinned to the
      // tool card it belongs to instead of floating at the bottom of the chat.
      if (typed.type === 'tool' && (typed as { phase?: string }).phase === 'start' && streamId) {
        const callId = (typed as { id?: string }).id;
        if (callId) this.reactLastToolCall.set(streamId, callId);
      }
      if ((typed.type === 'notify' || typed.type === 'permission') && typed.conversationId) {
        const callId = this.reactLastToolCall.get(typed.conversationId);
        if (callId) (typed as { toolCallId?: string }).toolCallId = callId;
      }
      const t = adapter.toReactMessageWhileStreaming(typed as any, streaming);
      if (!t) return; // drop untranslatable internal messages in React mode
      outgoing = t;
      // The model catalog and the active selection travel together in SleepyCode
      // but are two separate messages for React, which keeps the picker's
      // selection in its own state.
      if (typed.type === 'models' && typed.selected) {
        void this.view?.webview.postMessage({ type: 'modelSelected', model: typed.selected });
      }
      if (adapter.shouldOfferSignIn(typed as any)) this.offerSignInOnce();
      // Both are settings-window sections now.
      if (typed.type === 'showUsage') {
        this.openSettingsWindow('usage');
        return;
      }
      if (typed.type === 'showMarketplace') {
        this.openSettingsWindow('marketplace');
        return;
      }
      // Anything left has no React screen yet. Say which command ran instead of
      // letting it look broken.
      const fallback = adapter.reactFallbackFor(typed as any);
      if (fallback) {
        void vscode.window.showInformationMessage(`${fallback} is not in the new React UI yet. Run "SleepyCode: Toggle React UI (beta)" to switch back to the classic view.`);
        return;
      }
      // The classic composer owns its own shortcuts; stop is the one the agent
      // loop also understands, so it keeps working from the palette.
      if (typed.type === 'shortcut' && (typed as { action?: string }).action === 'stop') {
        void this.onMessage({ type: 'stop' } as WebMessage);
        return;
      }
      // React keeps the change-review list in its own state, so the files a turn
      // touched travel as a separate message rather than inside the transcript.
      if (typed.type === 'conversation') {
        const items = (typed as { items?: unknown[] }).items;
        void this.view?.webview.postMessage(adapter.pendingChangesMessage(items));
        const target = adapter.latestAssistantItemId(items);
        if (typed.id && target) this.reactChangeTarget.set(typed.id, target);
        if (typed.id) {
          this.reactItems.set(typed.id, Array.isArray(items) ? items : []);
          this.reactPendingPaths.set(typed.id, adapter.pendingChangesOf(items).map((change) => change.path));
        }
      }
    }
    void this.view?.webview.postMessage(outgoing);
  }

  /**
   * The React base replaces the vanilla sign-in banner, so a signed-out user
   * would otherwise have no way in. Offer it once per window.
   */
  private offerSignInOnce(): void {
    if (this.signInOffered) return;
    this.signInOffered = true;
    void vscode.window.showInformationMessage('Sign in to SleepyAI to use models and limits.', 'Sign in').then(choice => {
      if (choice === 'Sign in') this.signIn();
    });
  }

  /** Continuous 2s captures so the preview stays live while the agent works, not just at tool boundaries. */
  private startBrowserPreviewPolling(): void {
    if (this.browserPreviewTimer) return;
    this.browserPreviewTimer = setInterval(() => {
      if (!this.browser.active) {
        this.stopBrowserPreviewPolling();
        return;
      }
      void this.browser.previewDataUrl().then(dataUrl => {
        if (dataUrl) this.browserPreview.update(dataUrl);
      }).catch(() => undefined);
    }, 2000);
  }

  private stopBrowserPreviewPolling(): void {
    if (this.browserPreviewTimer) {
      clearInterval(this.browserPreviewTimer);
      this.browserPreviewTimer = undefined;
    }
  }
}
