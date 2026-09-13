import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, streamText, isLoopFinished, isStepCount } from 'ai';
import { captureGitTree, commitGit, gitChangedPathsBetween, gitFileAtTree, gitHeadShort, gitHeadTreeOrEmpty, gitPorcelain, isGitTrackedWorkspace, restoreGitPath, restoreGitTree, stageGitPaths } from './git';
import { cloneProviders, fetchProviderModels, getProvider, SLEEPY_AUTO_MODEL_ID, type Provider } from './providers';
import { installSkillFromRepository, listInstalledSkills, listRepositorySkills, readSkillMarkdown, resolveInstallPath, sanitizeSkillName, searchSkills, skillsPromptBlock, uninstallSkill, SKILL_FILE_NAMES, SKILLS_SUBDIR } from './skills';
import { buildTools } from './tools';
import type { AppConfig, Attachment, ComposerContext, Conversation, CustomAgentConfig, ExtensionLogEntry, FileChange, FileSnapshot, McpConnectionData, Project, ProviderModelGroup, ProviderModelItem, SubagentModelMap, TranscriptItem, WebMessage, WorkItem } from './types';
import type { ModelMessage } from 'ai';
import { MAX_FILE_BYTES, MAX_PERSISTED_CONVERSATIONS, MAX_PERSISTED_PROJECTS, MAX_PERSISTED_REASONING, MAX_STORED_ITEMS } from './types';
import { classifyAgentError, conversationTitle, createTranscriptItem, errorMessage, friendlyError, humanToolName, isSecret, normalizeApprovalMode, normalizeTranscriptItem, pathInside, requiresApproval, resolvePathSafe, shouldAutoContinue, toolTask, truncate } from './util';
import { AUTO_COMPACT_RATIO, CHARS_PER_TOKEN, COMPACTION_HISTORY_ITEMS, compactionOutputBudget, compactionPromptInput, contextOccupancy, selectCarriedItems, shouldAutoCompact, DEFAULT_CONTEXT_WINDOW } from './compaction-core';
import { pausedByStepLimit } from './iteration-core';
import { getWebviewHtml } from './webview';
import { systemNotify } from './notifications';
import { aggregateUsage, loadUsage, recordUsage } from './usage';
import { beginMcpOAuth, connectMcpServers, connectToMcpConnections, deleteMcpConnection, finishMcpOAuth, loadMcpConnections, parseMcpServers, saveMcpConnection, type McpConnection } from './mcp';
import { clearGatewayConfig, fetchSleepyAccountData, fetchSleepyModelPrices, getSleepyAccount, getSleepyToken, getSleepyTokenSync, loginWithBrowser, loginWithDevice, sleepyApiBase, SLEEPY_ACCOUNT_URL, SLEEPY_WEBSITE_URL, type SleepyModelPrice } from './sleepyai';
import { chooseAutoModel, rankModelsByPrice, sortModelsA2Z } from './model-routing-core';
import { TerminalManager } from './terminal';
import { MEMORY_RELATIVE_PATH, openProjectMemory, readProjectMemory, writeProjectMemory } from './memory';
import { ProjectIndexService } from './project-index';
import { retrieveProjectContext, summarizeProjectIndex, type ProjectIntelligence } from './project-index-core';
import { RepoIndex, scanWorkspace, SourceCitedMemory, loadMemoryJson } from './repo-index';
import { dueTasks, evaluateHooks, nextRunAt, type HookContext, type HookRule, type ScheduledTask } from './hooks';
import { listWorktrees } from './worktrees';
import { BrowserController } from './browser';

type PlanState = {
  title: string;
  steps: string[];
  active: number;
  done: Set<number>;
  manual: boolean;
  interrupted: boolean;
};

const MAX_CONCURRENT_RUNS = 3;
const MAX_RUN_RETRIES = 5;

/** Capture a file's pre-edit content so undo can restore it outside Git. `before` avoids a disk read when the tool already supplied it. */
function captureFileSnapshot(rootPath: string, relative: string, before?: unknown): FileSnapshot {
  if (typeof before === 'string') return { path: relative, existed: true, content: before };
  try {
    const absolute = path.join(rootPath, relative);
    return { path: relative, existed: true, content: readFileSync(absolute, 'utf8') };
  } catch {
    return { path: relative, existed: false, content: '' };
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
const AGENT_ALWAYS_ALLOWED_TOOLS = new Set(['plan']);

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

function userOsName(): string {  switch (process.platform) {
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

type ProjectMetaEntry = { id?: unknown; name?: unknown; path?: unknown; createdAt?: unknown; updatedAt?: unknown };

function isProjectMeta(entry: unknown): entry is ProjectMetaEntry & { id: string; name: string; path: string } {
  const meta = entry as ProjectMetaEntry | undefined;
  return Boolean(meta && typeof meta.id === 'string' && typeof meta.name === 'string' && typeof meta.path === 'string');
}

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private static readonly LOG_KEY = 'sleepycode.extensionLogs';
  private static readonly LOG_LIMIT = 400;
  private view?: vscode.WebviewView;
  private projects: Project[] = [];
  private activeProjectId = '';
  private loaded = false;
  private runs = new Map<string, ActiveRun>();
  private queue: { text: string; conversationId: string; context?: ComposerContext; promptContext?: string }[] = [];
  private apiKeys: Record<string, string> = {};
  private persistChain: Promise<void> = Promise.resolve();
  private notifySeq = 0;
  private pendingNotifies = new Map<number, (choice: 'ok' | 'secondary' | 'cancel') => void>();
  private readonly terminals = new TerminalManager();
  private lastCheckpointPrune = 0;
  private undoStacks = new Map<string, TranscriptItem[][]>(); // conversationId -> stack of popped turn pairs
  private compactionUndoStacks = new Map<string, { before: TranscriptItem[]; after: TranscriptItem[] }[]>(); // conversationId -> undoable compactions
  private compactionRedoStacks = new Map<string, { before: TranscriptItem[]; after: TranscriptItem[] }[]>(); // conversationId -> redone compactions
  private agentPromptCache = new Map<string, string>(); // agentId -> prompt text
  private sessionAllowedCommands = new Set<string>();
  private sessionAutoApproveEditRoots = new Set<string>();
  private lastSleepyAccountRefresh = 0;
  private readonly projectIndex: ProjectIndexService;
  private repoIndexCache?: { root: string; index: RepoIndex; symboled: boolean };
  private readonly browser = new BrowserController();
  private projectIndexTimer?: NodeJS.Timeout;
  private schedulerTimer?: NodeJS.Timeout;
  private lastModelGroups: ProviderModelGroup[] = [];
  private lastSleepyModelPrices: SleepyModelPrice[] = [];
  private lastSleepyPriceRefresh = 0;
  private reviewTempDirs = new Set<string>();
  private subagentSequence = 0;
  private compactionControllers = new Map<string, AbortController>();
  private lastAutoCompactAt = new Map<string, number>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.projectIndex = new ProjectIndexService(context, message => this.post(message));
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(uri => this.scheduleProjectReindex(uri)),
      watcher.onDidChange(uri => this.scheduleProjectReindex(uri)),
      watcher.onDidDelete(uri => this.scheduleProjectReindex(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.onWorkspaceFoldersChanged()),
      vscode.window.onDidChangeActiveTextEditor(() => this.sendEditorContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.sendEditorContext()),
    );
    this.schedulerTimer = setInterval(() => { void this.runDueScheduledTasks(); }, 30_000);
    context.subscriptions.push({ dispose: () => { if (this.schedulerTimer) clearInterval(this.schedulerTimer); } });
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
    view.webview.options = { enableScripts: true };
    view.webview.html = getWebviewHtml(view.webview, this.context.extensionUri, this.workspaceRoot()?.fsPath);
    view.webview.onDidReceiveMessage((message: WebMessage) => {
      void this.onMessage(message).catch(error => {
        const detail = errorMessage(error);
        this.log('error', 'webview.message.failed', detail);
        this.post({ type: 'error', text: detail });
        this.post({ type: 'state', conversationId: this.activeProject()?.activeConversationId ?? '', running: false, label: '' });
      });
    });
    view.onDidDispose(() => this.disposePendingNotifies());
    this.loaded = true;
    this.loadProjects();
    this.syncConversations();
    void this.migrateProvidersIfNeeded().then(() => this.loadApiKeys()).then(() => {
      if (this.view !== view) return;
      this.postConfig();
      void this.maybeShowFirstLaunchSettings();
    });
  }

  private apiKeysLoaded?: Promise<void>;

  private log(level: ExtensionLogEntry['level'], event: string, detail?: string): void {
    const entries = this.context.globalState.get<ExtensionLogEntry[]>(AgentViewProvider.LOG_KEY, []);
    entries.push({ timestamp: Date.now(), level, event, detail });
    void this.context.globalState.update(AgentViewProvider.LOG_KEY, entries.slice(-AgentViewProvider.LOG_LIMIT));
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
    const rows: { title: string; detail?: string }[] = [];
    let hint = '';
    try {
      if (panel === 'worktrees') {
        if (!isGitTrackedWorkspace(root.fsPath)) hint = 'This workspace is not a Git repository. Worktrees require Git.';
        else for (const tree of await listWorktrees(root.fsPath)) rows.push({ title: tree.name, detail: `${tree.branch} · ${tree.commit.slice(0, 8)}${tree.isMain ? ' · main' : ''}` });
      } else if (panel === 'index') {
        const index = await this.loadRepoIndex(root);
        const symbols = index.indexSymbols();
        rows.push({ title: `${index.files.length} files indexed`, detail: `${symbols.length} symbols` });
        for (const edge of index.architectureMap().edges.slice(0, 60)) rows.push({ title: edge.from, detail: `imports ${edge.to}` });
        hint = 'Ask the agent to use repo_search or repo_symbol for symbol and semantic search.';
      } else if (panel === 'tasks') {
        const hooks = this.hookRules();
        if (!hooks.length) hint = 'No hook rules configured. Hook rules live in extension state and can allow, block, or require approval for tool calls.';
        for (const rule of hooks) rows.push({ title: `${rule.name} (${rule.event})`, detail: `action: ${rule.action}${rule.matcher?.tool ? ` · tool ${rule.matcher.tool}` : ''}${rule.matcher?.pathGlob ? ` · ${rule.matcher.pathGlob}` : ''}` });
      } else if (panel === 'agents') {
        const builtIns = new Set(AGENT_DEFINITIONS.map(agent => agent.id));
        for (const agent of this.allAgents()) {
          const detail = [agent.id, agent.model || 'default model', builtIns.has(agent.id) ? 'built-in' : 'custom'].join(' · ');
          rows.push({ title: agent.name, detail });
        }
        hint = 'Select an agent from the composer pill, or type @agent-id at the start of a message to route it.';
      } else if (panel === 'checkpoints') {
        const project = this.activeProject();
        const conversation = project?.conversations.find(item => item.id === project.activeConversationId);
        const withSnapshots = (conversation?.items ?? []).filter(item => item.fileSnapshot?.length || item.gitTree);
        if (!withSnapshots.length) hint = 'No restorable snapshots yet. Each assistant turn records one so undo works outside Git.';
        for (const item of withSnapshots.slice(-40)) rows.push({ title: item.text.slice(0, 80) || '(no text)', detail: `${item.fileSnapshot?.length ?? 0} files snapshot${item.gitTree ? ' · git checkpoint' : ''}` });
      }
    } catch (error) {
      hint = errorMessage(error);
    }
    this.post({ type: 'panel', panel, rows, hint });
  }

  private async restoreFileSnapshots(rootPath: string, snapshots: FileSnapshot[]): Promise<void> {
    for (const snap of snapshots) {
      const uri = vscode.Uri.file(path.join(rootPath, snap.path));
      try {
        if (snap.existed) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(snap.content));
        else await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      } catch { }
    }
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

  private async loadRepoIndex(root: vscode.Uri): Promise<RepoIndex> {
    if (this.repoIndexCache?.root === root.fsPath) {
      if (!this.repoIndexCache.symboled) {
        this.repoIndexCache.index.indexSymbols();
        this.repoIndexCache.symboled = true;
      }
      return this.repoIndexCache.index;
    }
    const index = new RepoIndex(scanWorkspace(root.fsPath));
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
    this.globalSkillsReady ??= this.ensureGlobalSkillsOnce();
    return this.globalSkillsReady;
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

  private async showSettings(initialSetup = false): Promise<void> {
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

  dispose(): void {
    this.terminals.dispose();
    this.disposePendingNotifies();
    if (this.projectIndexTimer) clearTimeout(this.projectIndexTimer);
    for (const folder of this.reviewTempDirs) void rm(folder, { recursive: true, force: true });
    this.reviewTempDirs.clear();
  }

  private loadProjects(): void {
    const stored = this.context.globalState.get<unknown[]>('sleepycode.projectIndex', []);
    this.projects = (Array.isArray(stored) ? stored : []).filter(isProjectMeta).map(entry => {
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
          return { ...conversation, items: conversation.items.map((item, index) => normalizeTranscriptItem(item, baseTimestamp + index)) };
        }),
      };
    });
    const seenIds = new Set<string>();
    this.projects = this.projects.filter(project => seenIds.has(project.id) ? false : (seenIds.add(project.id), true));
    // Rehydrate durable compaction snapshots so undo survives an extension reload.
    for (const project of this.projects) {
      for (const conversation of project.conversations) {
        const snapshots = this.context.globalState.get<{ before: TranscriptItem[]; after: TranscriptItem[] }[]>(`sleepycode.compactionSnapshots.${conversation.id}`, []);
        if (Array.isArray(snapshots) && snapshots.length) this.compactionUndoStacks.set(conversation.id, snapshots.slice(-3));
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
    const conversations = legacy.length
      ? legacy.map(conversation => {
        const baseTimestamp = Number.isFinite(conversation.createdAt) ? conversation.createdAt : Date.now();
        return { ...conversation, items: conversation.items.map((item, index) => normalizeTranscriptItem(item, baseTimestamp + index)) };
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

  private createConversation(items: TranscriptItem[] = []): Conversation {
    const now = Date.now();
    const first = items.find(item => item.role === 'user')?.text.trim();
    return { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, title: first ? conversationTitle(first) : 'New conversation', items, archived: false, createdAt: now, updatedAt: now };
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
    const empty = project.conversations.find(item => !item.archived && item.items.length === 0);
    const conversation = empty ?? this.createConversation();
    if (!empty) project.conversations.unshift(conversation);
    project.activeConversationId = conversation.id;
    project.updatedAt = Date.now();
    void this.persistProjects();
    this.syncConversations();
  }

  /**
   * Hard safety bound only. History is NOT routinely trimmed; this guard exists
   * solely to keep an unbounded conversation from exhausting memory. When it does
   * trim, the user is told, so loss is never silent.
   */
  private boundConversationItems(conversation: Conversation): void {
    if (conversation.items.length <= MAX_STORED_ITEMS) return;
    const dropped = conversation.items.length - MAX_STORED_ITEMS;
    conversation.items = conversation.items.slice(-MAX_STORED_ITEMS);
    this.post({ type: 'contextNotice', conversationId: conversation.id, kind: 'trimmed', text: `Older history was trimmed (${dropped} item${dropped === 1 ? '' : 's'}) to keep this conversation within memory limits.` });
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
      const itemCost = Math.ceil((item.text?.length ?? 0) / CHARS_PER_TOKEN);
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
    const snapshot = this.compactionUndoStacks.get(conversationId);
    if (snapshot?.length) await this.context.globalState.update(`sleepycode.compactionSnapshots.${conversationId}`, snapshot.slice(-3));
    else await this.context.globalState.update(`sleepycode.compactionSnapshots.${conversationId}`, undefined);
  }

  private persistProjects(): Promise<void> {
    const projects = this.projects.slice(0, MAX_PERSISTED_PROJECTS);
    this.persistChain = this.persistChain.then(async () => {
      await this.context.globalState.update('sleepycode.projectIndex', projects.map(({ id, name, path, createdAt, updatedAt }) => ({ id, name, path, createdAt, updatedAt })));
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
    });
    return this.persistChain;
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
    this.post({
      type: 'conversations', conversations: project.conversations.map(({ id, title, archived, pinned, updatedAt, items }) => {
        const lastAssistant = [...items].reverse().find(item => item.role === 'assistant');
        return {
          id, title, archived, pinned: Boolean(pinned), updatedAt,
          hasMessages: items.length > 0,
          messageCount: items.length,
          changeCount: lastAssistant?.changes?.length ?? 0,
          status: this.runs.has(id) ? 'running' : lastAssistant?.paused ? 'paused' : lastAssistant?.kind === 'error' ? 'failed' : lastAssistant ? 'done' : 'empty',
          running: this.runs.has(id),
          queued: this.queue.find(entry => entry.conversationId === id)?.text ?? null,
        };
      }), activeId: project.activeConversationId
    });
    if (includeActive) {
      const active = this.activeConversation();
      if (active) {
        const selection = this.selectionFor(active);
        const compactionUndoable = active.items[active.items.length - 1]?.kind === 'divider' && (this.compactionUndoStacks.get(active.id)?.length ?? 0) > 0;
        const compactionRedoable = (this.compactionRedoStacks.get(active.id)?.length ?? 0) > 0;
        this.post({ type: 'conversation', id: active.id, items: active.items, model: selection.model, provider: selection.provider, agentId: selection.agentId, compactionUndoable, compactionRedoable });
      }
    }
  }

  private confirmDeleteConversations(): boolean {
    return this.context.globalState.get<boolean>('sleepycode.confirmDelete', true) !== false;
  }

  private async onMessage(message: WebMessage): Promise<void> {
    if (message.type === 'notifyResponse') {
      const resolve = this.pendingNotifies.get(message.id);
      if (resolve) {
        this.pendingNotifies.delete(message.id);
        resolve(message.choice);
      }
      return;
    }
    if (message.type === 'ready') {
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
      return;
    }
    if (message.type === 'stop') {
      const project = this.activeProject();
      const activeId = project?.activeConversationId ?? '';
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
    if (message.type === 'requestExtensionLogs') {
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
      this.queue = this.queue.filter(entry => entry.conversationId !== message.conversationId);
      this.postQueued(message.conversationId);
      return;
    }
    if (message.type === 'steerQueued') {
      const run = this.runs.get(message.conversationId);
      if (!run) return;
      run.steering = true;
      run.controller.abort();
      return;
    }
    if (message.type === 'requestSettings') return void this.showSettings();
    if (message.type === 'compact') return this.compactConversation(message.conversationId);
    if (message.type === 'cancelCompact') {
      const compactProject = this.activeProject();
      const compactTargetId = message.conversationId ?? compactProject?.activeConversationId ?? '';
      this.compactionControllers.get(compactTargetId)?.abort();
      return;
    }
    if (message.type === 'newConversation') return this.newConversation();
    if (message.type === 'openConversation') {
      const project = this.activeProject();
      if (project && project.conversations.some(item => item.id === message.id)) {
        project.activeConversationId = message.id;
        project.updatedAt = Date.now();
        void this.persistProjects();
        this.syncConversations();
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
      const slicedItems = conversation.items.slice(0, targetIndex + 1).map((item, idx) => ({
        ...item,
        id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      }));
      const branchedTitle = `Branch: ${conversation.title}`;
      const branched = this.createConversation(slicedItems);
      branched.title = branchedTitle;
      project.conversations.unshift(branched);
      project.activeConversationId = branched.id;
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      return;
    }
    if (message.type === 'editUserMessage') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      const targetIndex = conversation.items.findIndex(item => item.id === message.itemId && item.role === 'user');
      if (targetIndex < 0) return;
      const root = this.workspaceRoot();
      const gitTracked = root && project.path === root.fsPath && isGitTrackedWorkspace(root.fsPath);
      // Ask before reverting workspace files: editing a past message can either
      // rewind the code to the checkpoint or keep the current workspace as-is.
      const hasRestorableState = Boolean(root) && (gitTracked || conversation.items.slice(targetIndex).some(item => item.fileSnapshot?.length));
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
          const assistantCheckpoint = conversation.items.slice(targetIndex).find(item => item.role === 'assistant' && item.gitTree);
          if (assistantCheckpoint?.gitTree) {
            try {
              await restoreGitTree(root!.fsPath, assistantCheckpoint.gitTree);
            } catch { }
          }
        } else if (restoreState && root) {
          const snapshotItem = conversation.items.slice(targetIndex).find(item => item.role === 'assistant' && item.fileSnapshot?.length);
          if (snapshotItem?.fileSnapshot?.length) await this.restoreFileSnapshots(root.fsPath, snapshotItem.fileSnapshot);
        }
      }
      conversation.items = conversation.items.slice(0, targetIndex);
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      const editorContext = root ? await this.composerContextBlock(root, message.context) : '';
      const projectContext = root && message.context?.includeProjectIndex !== false ? await this.projectContextBlock(root, message.text.trim()) : '';
      const promptContext = [editorContext, projectContext].filter(Boolean).join('\n\n');
      void this.run(message.text.trim(), conversation.id, undefined, undefined, message.context, promptContext);
      return;
    }
    if (message.type === 'undoLastTurn') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      if (!conversation.items.length) return;
      // A compaction boundary (divider marker) undoes the whole compaction.
      if (conversation.items[conversation.items.length - 1]?.kind === 'divider') {
        if (!this.undoCompaction(conversation)) return;
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.persistProjects();
        this.syncConversations();
        return;
      }
      const root = this.workspaceRoot();
      const gitTracked = root && project.path === root.fsPath && isGitTrackedWorkspace(root.fsPath);
      // Remove last assistant message (and restore git if checkpoint exists)
      const popped: TranscriptItem[] = [];
      const lastItem = conversation.items[conversation.items.length - 1];
      if (lastItem?.role === 'assistant') {
        if (gitTracked && lastItem.gitTree) {
          try {
            await restoreGitTree(root.fsPath, lastItem.gitTree);
          } catch { }
        } else if (root && lastItem.fileSnapshot?.length) {
          await this.restoreFileSnapshots(root.fsPath, lastItem.fileSnapshot);
        }
        popped.unshift(conversation.items.pop()!);
      }
      // Remove last user message
      const prevItem = conversation.items[conversation.items.length - 1];
      if (prevItem?.role === 'user') {
        popped.unshift(conversation.items.pop()!);
      }
      if (popped.length) {
        const stack = this.undoStacks.get(message.conversationId) ?? [];
        stack.push(popped);
        this.undoStacks.set(message.conversationId, stack);
      }
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      return;
    }
    if (message.type === 'redoLastTurn') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      // Redo a compaction first when one is pending at this boundary.
      if (this.redoCompaction(conversation)) {
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.persistProjects();
        this.syncConversations();
        return;
      }
      const stack = this.undoStacks.get(message.conversationId);
      if (!stack || !stack.length) return;
      const items = stack.pop()!;
      if (!stack.length) this.undoStacks.delete(message.conversationId);
      conversation.items.push(...items);
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
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
        const { skills, total } = await searchSkills('skill', { limit: 20, sortBy: message.sortBy ?? 'stars' });
        this.post({ type: 'marketplaceResults', query: '', total, skills });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplaceSearch') {
      try {
        const { skills, total } = await searchSkills(message.query, { limit: Math.max(1, Math.min(50, message.limit || 10)), sortBy: message.sortBy });
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
        this.post({ type: 'marketplacePreview', title: reference.owner + '/' + reference.repo + ' / ' + folderPath, markdown: truncate(content), source: message.source, path: folderPath });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplaceInstall') {
      const key = message.key ?? '';
      await this.ensureGlobalSkills();
      try {
        const reference = resolveInstallPath(message.source, message.skill ?? '', message.branch ?? 'main');
        const requested = message.skill ?? '';
        let folderPath = reference.folderPath;
        if (!folderPath) {
          const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch);
          const match = requested
            ? skills.find(candidate => candidate.name === sanitizeSkillName(requested) || candidate.name.toLowerCase() === requested.trim().toLowerCase())
            : undefined;
          if (!match) {
            this.post({ type: 'marketplaceResult', ok: false, text: skills.length ? reference.owner + '/' + reference.repo + ' has ' + skills.length + ' skills. Pick one: ' + skills.slice(0, 20).map(skill => skill.name).join(', ') : 'No SKILL.md skills found in ' + reference.owner + '/' + reference.repo + '.', key });
            return;
          }
          folderPath = match.path;
        }
        const installName = sanitizeSkillName(reference.hintedName ?? folderPath.split('/').pop() ?? message.skill ?? 'skill');
        await this.approve('edit', 'Install skill "' + installName + '"?', 'Source: ' + reference.owner + '/' + reference.repo + (folderPath ? ' (' + folderPath + ')' : '') + '\n\nThe skill will be installed into your global skills folder as \'' + installName + '\' and is available in every workspace. Its SKILL.md will be added to the agent\'s instructions on every future request and can direct file edits and commands. Only install skills from trusted authors.');
        await installSkillFromRepository(this.skillsRoot(), { owner: reference.owner, repo: reference.repo, branch: reference.branch, folderPath, installName }, undefined, (done, total) => {
          this.post({ type: 'marketplaceInstallProgress', key, done, total });
        });
        const sources = this.context.globalState.get<Record<string, string>>('sleepycode.skillSources', {}) ?? {};
        sources[installName] = reference.owner + '/' + reference.repo;
        await this.context.globalState.update('sleepycode.skillSources', sources);
        this.post({ type: 'marketplaceResult', ok: true, text: `Installed '${installName}'. Open Installed and click Use, or ask SleepyCode to use the '${installName}' skill by name.`, key });
        await this.sendMarketplaceInstalled();
      } catch (error) {
        this.post({ type: 'marketplaceResult', ok: false, text: errorMessage(error), key });
      }
      return;
    }
    if (message.type === 'marketplaceUninstall') {
      await this.ensureGlobalSkills();
      try {
        const safeName = sanitizeSkillName(message.folder);
        const installed = await listInstalledSkills(this.skillsRoot());
        const skill = installed.find(item => item.folder === safeName || sanitizeSkillName(item.name) === safeName);
        if (!skill) {
          this.post({ type: 'marketplaceResult', ok: false, text: 'Skill \'' + (message.folder || '') + '\' not found.' });
          return;
        }
        const choice = await this.prompt('Uninstall skill \'' + skill.name + '\'?', 'This removes \'' + skill.name + '\' from your global skills folder. It will no longer be offered to the agent in any workspace.', { ok: 'Uninstall', cancel: 'Cancel', danger: true });
        if (choice !== 'ok') return;
        await uninstallSkill(this.skillsRoot(), skill.folder);
        const sources = this.context.globalState.get<Record<string, string>>('sleepycode.skillSources', {}) ?? {};
        delete sources[skill.folder];
        await this.context.globalState.update('sleepycode.skillSources', sources);
        this.post({ type: 'marketplaceResult', ok: true, text: '' });
        await this.sendMarketplaceInstalled();
      } catch (error) {
        this.post({ type: 'marketplaceResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'saveSettings') {
      try {
        const searxngUrl = message.searxngUrl.trim().replace(/\/$/, '');
        if (searxngUrl && !/^https?:\/\//i.test(searxngUrl)) throw new Error('SearXNG URL must start with http:// or https://.');
        parseMcpServers(message.mcpServers ?? '{}');
        const rawMaxSteps = Number(message.maxSteps);
        const maxSteps = rawMaxSteps === 0 ? 0 : Math.max(1, Math.min(200, Math.round(rawMaxSteps) || 200));

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
        await config.update('extraFreeModels', message.extraFreeModels ?? '', vscode.ConfigurationTarget.Global);
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
        const result = await connectToMcpConnections([testable], this.context, (title, detail) => this.approve('command', title, detail));
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
      await config.update('extraFreeModels', '', vscode.ConfigurationTarget.Global);
      await config.update('model', '', vscode.ConfigurationTarget.Global);
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
        await vscode.window.showTextDocument(uri);
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
        this.post({ type: 'error', text: 'Open a folder or workspace first.' });
        return;
      }
      if (previousActive !== project.id) this.syncConversations();
      let conversationId = message.conversationId || project.activeConversationId;
      if (!project.conversations.some(conversation => conversation.id === conversationId)) {
        const active = this.activeConversation();
        if (!active) return;
        conversationId = active.id;
      }
      const root = this.workspaceRoot();
      const mention = this.parseAgentMention(message.text);
      const sendText = mention.text.trim() || message.text.trim();
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
      const editorContext = root ? await this.composerContextBlock(root, message.context) : '';
      const projectContext = root && message.context?.includeProjectIndex !== false ? await this.projectContextBlock(root, sendText) : '';
      const promptContext = [editorContext, projectContext].filter(Boolean).join('\n\n');
      if (this.runs.has(conversationId) || this.runs.size >= MAX_CONCURRENT_RUNS) {
        this.log('info', 'message.send.queued', `conversation=${conversationId}; activeRuns=${this.runs.size}`);
        this.enqueue(sendText, conversationId, message.context, promptContext);
      } else {
        this.log('info', 'message.send.starting', `conversation=${conversationId}; contextChars=${promptContext.length}`);
        void this.run(sendText, conversationId, undefined, undefined, message.context, promptContext).catch(error => {
          const detail = errorMessage(error);
          this.log('error', 'run.unhandled', detail);
          this.post({ type: 'error', conversationId, text: detail });
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
      const last = conversation.items[conversation.items.length - 1];
      const resume = last?.kind === 'error'
        ? { work: last.work, errorText: last.text, changes: last.changes, partialText: last.partialText }
        : undefined;
      const carryTree = last?.kind === 'error' ? last.gitTree : undefined;
      if (last?.kind === 'error') conversation.items.pop();
      project.activeConversationId = conversation.id;
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      await this.run('Continue', conversation.id, resume, carryTree);
      return;
    }
    if (message.type === 'continueIteration') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      const last = conversation.items[conversation.items.length - 1];
      if (!last?.paused || last.id !== message.itemId) return;
      const carryTree = last.gitTree;
      const pausePlaceholder = `Iteration paused after reaching the ${last.pauseLimit ?? this.config().maxSteps}-step limit.`;
      const resume = {
        work: last.work,
        changes: last.changes,
        fileSnapshot: last.fileSnapshot,
        errorText: `The previous iteration paused after reaching its ${last.pauseLimit ?? this.config().maxSteps}-step limit. Continue only the unfinished work.`,
        partialText: last.text.trim() && last.text !== pausePlaceholder ? last.text : undefined,
      };
      conversation.items.pop();
      project.activeConversationId = conversation.id;
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      await this.run('Continue', conversation.id, resume, carryTree);
      return;
    }
  }

  private enqueue(text: string, conversationId: string, context?: ComposerContext, promptContext?: string): void {
    this.queue = this.queue.filter(entry => entry.conversationId !== conversationId);
    this.queue.push({ text, conversationId, context, promptContext });
    this.postQueued(conversationId);
  }

  private postQueued(conversationId: string): void {
    const entry = this.queue.find(item => item.conversationId === conversationId);
    this.post({ type: 'queuedPrompt', conversationId, prompt: entry?.text ?? null });
  }

  private async run(userText: string, conversationId: string, resume?: { work?: WorkItem[]; errorText?: string; changes?: FileChange[]; fileSnapshot?: FileSnapshot[]; partialText?: string }, carryTree?: string, composerContext?: ComposerContext, preparedPromptContext?: string): Promise<void> {
    this.log('info', 'run.enter', `conversation=${conversationId}; chars=${userText.length}`);
    const root = this.workspaceRoot();
    if (!root) {
      this.post({ type: 'error', text: 'Open a folder or workspace first.' });
      return;
    }
    const project = this.ensureProjectForRoot();
    if (!project) {
      this.post({ type: 'error', text: 'Open a folder or workspace first.' });
      return;
    }
    const promptContext = resume ? '' : preparedPromptContext ?? await this.composerContextBlock(root, composerContext);

    let conversation = project.conversations.find(item => item.id === conversationId);
    if (!conversation) {
      conversation = this.createConversation();
      project.conversations.unshift(conversation);
      conversationId = conversation.id;
    }
    const gitTracked = isGitTrackedWorkspace(root.fsPath);
    const run: ActiveRun = { conversationId, controller: new AbortController(), steering: false };
    this.runs.set(conversationId, run);
    this.log('info', 'run.registered', conversationId);
    let runGitTree = gitTracked ? carryTree : undefined;
    let carriedGitTree = carryTree;
    if (resume) {
      this.post({ type: 'resume', conversationId, partialText: resume.partialText ?? '' });
    } else {
      const userItem = createTranscriptItem('user', userText);
      userItem.attachments = composerContext?.attachments;
      conversation.items.push(userItem);
      if (conversation.items.length === 1) conversation.title = conversationTitle(userText);
      this.post({ type: 'user', conversationId, item: userItem });
      this.notifyHooks('onMessage', { text: userText });
    }
    conversation.updatedAt = Date.now();
    project.updatedAt = Date.now();
    await this.persistProjects();
    this.syncConversations(false);
    this.post({ type: 'state', conversationId, running: true, label: 'Thinking' });

    const work: WorkItem[] = resume ? [...(resume.work ?? [])] : [];
    const runChanges = new Map<string, FileChange>((resume?.changes ?? []).map(change => [change.path, change]));
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
          } else {
            if (!snapshotByPath.has(relative)) {
              snapshotByPath.set(relative, captureFileSnapshot(root.fsPath, relative, record.before));
            }
            const mergedAction: FileChange['action'] = previous?.action === 'Created' ? 'Created' : action;
            runChanges.set(relative, { path: relative, action: mergedAction });
          }
          next = { ...next, path: relative, action };
        } catch {
          return;
        }
      }
      this.post(next);
    };
    const activeTasks = new Map<string, WorkItem>();
    let reasoningBuffer = '';
    let reasoningTruncated = false;
    // Longest streamed text before an interruption; preserved on error items so
    // a manual retry can continue from the halfway point instead of restarting.
    let partialAnswer = '';
    let workStartedAt = 0;
    let planItem: WorkItem | undefined;
    let planState: PlanState | undefined;
    let mcpConnection: McpConnection | undefined;
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
      await this.persistProjects();
    }
    const conversationAgent = this.agentConfig(conversation.agentId ?? this.config().agentId);
    const selection = this.selectionFor(conversation);
    if (!conversation.model && conversationAgent?.model && !resume) {
      selection.model = conversationAgent.model;
      this.post({ type: 'modelRoute', conversationId, requested: conversationAgent.model, model: conversationAgent.model, reason: `${conversationAgent.name} agent model` });
    }
    const providerConfig = getProvider(this.getProviders(), selection.provider) ?? this.getProviders()[0];
    let reconnectAttempt = 0;
    try {
      this.log('info', 'run.preflight.start', `conversation=${conversationId}; provider=${providerConfig?.id ?? '(none)'}`);
      if (!providerConfig) throw new Error('No active provider configured. Open Settings and select SleepyAI or an explicitly configured compatibility provider.');
      if (gitTracked) runGitTree ??= await captureGitTree(root.fsPath, { context: this.context, lastPrune: this.lastCheckpointPrune });
      let { maxSteps } = this.config();
      let configuredModel = selection.model;
      if (!configuredModel) {
        await this.refreshModels();
        configuredModel = this.selectionFor(conversation).model;
        if (!configuredModel) throw new Error('No model is selected. Choose a model from the composer and retry.');
      }
      let model = configuredModel;
      const { apiKey, baseUrl } = this.providerCredentials(providerConfig);
      if (configuredModel === SLEEPY_AUTO_MODEL_ID) {
        if (!this.resolveAutoModel(providerConfig.id)) await this.refreshModels();
        const route = this.resolveAutoModel(providerConfig.id);
        if (!route) throw new Error('SleepyAI Auto could not find an eligible model. Refresh models or choose a model manually.');
        model = route.id;
        this.post({ type: 'modelRoute', conversationId, requested: SLEEPY_AUTO_MODEL_ID, model, reason: route.reason });
      }
      let sleepyToken: string | undefined;
      if (providerConfig.isSleepy) {
        sleepyToken = (await getSleepyToken()) ?? undefined;
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
          const maxRetries = 5;
          const requestTemplate = typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
          for (let attempt = 0; ; attempt++) {
            try {
              const requestInput = typeof Request !== 'undefined' && requestTemplate instanceof Request ? requestTemplate.clone() : requestTemplate;
              const response = await fetch(requestInput, init);
              const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
              if (!retryable || attempt >= maxRetries) {
                if (response.ok && reconnectAttempt) {
                  this.post({ type: 'retryEnd', conversationId, ok: true, attempt: reconnectAttempt, max: maxRetries });
                  reconnectAttempt = 0;
                }
                return response;
              }
              reconnectAttempt = attempt + 1;
              const backoffMs = Math.min(30_000, 1000 * Math.pow(2, attempt));
              const errorMsg = `HTTP ${response.status}: ${response.statusText || 'Server error'}`;
              this.post({ type: 'retry', conversationId, attempt: reconnectAttempt, max: maxRetries, error: errorMsg, backoffMs });
              await waitForRetry(backoffMs, run.controller.signal);
            } catch (error) {
              if (run.controller.signal.aborted || attempt >= maxRetries) throw error;
              reconnectAttempt = attempt + 1;
              const backoffMs = Math.min(30_000, 1000 * Math.pow(2, attempt));
              const errorMsg = error instanceof Error ? error.message : String(error);
              this.post({ type: 'retry', conversationId, attempt: reconnectAttempt, max: maxRetries, error: errorMsg, backoffMs });
              await waitForRetry(backoffMs, run.controller.signal);
            }
          }
        },
      });

      await this.ensureGlobalSkills();
      const skillBlock = await skillsPromptBlock(this.skillsRoot());
      const projectMemory = await readProjectMemory(root);
      mcpConnection = await connectMcpServers(
        this.config().mcpServers,
        root.fsPath,
        (title, detail) => this.approve('command', title, detail),
      );
      const savedConnections = await loadMcpConnections(this.context);
      this.log('info', 'run.mcp.connections', `legacy=${this.config().mcpServers !== '{}'}; saved=${savedConnections.length}; enabled=${savedConnections.filter(connection => connection.enabled).length}`);
      if (savedConnections.some((c) => c.enabled)) {
        const baseConnection = mcpConnection;
        const extra = await connectToMcpConnections(savedConnections, this.context, (title, detail) => this.approve('command', title, detail));
        mcpConnection = {
          tools: { ...baseConnection.tools, ...extra.connection.tools },
          instructions: [...baseConnection.instructions, ...extra.connection.instructions],
          errors: [...baseConnection.errors, ...extra.connection.errors],
          close: async () => {
            await Promise.allSettled([baseConnection.close(), extra.connection.close()]);
          },
        };
      }
      const instructions = [
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
      const repoIndex = await this.loadRepoIndex(root);
      const repoMemory = this.loadRepoMemory(root);
      this.log('info', 'run.preflight.ready', `conversation=${conversationId}; indexedFiles=${repoIndex.files.length}`);

      const delegate = async (role: 'explorer' | 'reviewer' | 'worker', task: string, context?: string): Promise<string> => {
        const cleanTask = task.trim();
        if (!cleanTask) throw new Error('Subagent task cannot be empty.');
        const subagentId = `subagent-${Date.now().toString(36)}-${(++this.subagentSequence).toString(36)}`;
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
          approve: (kind, title, detail, destructive, approvalKey) => this.approve(kind, title, detail, destructive, approvalKey),
          reviewEdit: (filePath, before, after, reason, destructive) => this.reviewEdit(filePath, before, after, reason, destructive),
          post: subagentPost,
          resolvePath: filePath => this.resolveWorkspacePath(filePath),
          describePlan: () => 'Subagents do not publish a parent plan. Work directly on the assigned task.',
          abortSignal: run.controller.signal,
          terminals: this.terminals,
          memory: memoryAccess,
        });
        if (role !== 'worker') {
          for (const name of ['write_file', 'replace_text', 'delete_file', 'run_command', 'terminal_start', 'terminal_write', 'terminal_stop', 'memory_update', 'skillsmp_install_skill']) delete subagentTools[name];
        }
        delete subagentTools.delegate_task;
        filterAgentTools(subagentTools, conversationAgent?.tools);
        const roleInstruction = role === 'explorer'
          ? 'Research the repository read-only. Return findings with precise workspace-relative file paths and line references.'
          : role === 'reviewer'
            ? 'Review independently and read-only. Look for correctness, regressions, security issues, and missing verification. Return only actionable findings or state that none were found.'
            : 'Complete the bounded implementation or verification task. Inspect before editing, preserve unrelated changes, and verify the result.';
        const label = `Subagent (${role}): ${cleanTask.slice(0, 96)}${cleanTask.length > 96 ? '…' : ''}`;
        this.post({ type: 'subagent', conversationId, id: subagentId, role, task: cleanTask, name: label, phase: 'start' });
        const subagentInstructions = [
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
              if (targetProviderConfig.isSleepy) token = (await getSleepyToken()) ?? undefined;
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
        const subagent = new ToolLoopAgent({
          model: subagentProvider(subagentModelId),
          maxRetries: 3,
          instructions: subagentInstructions,
          tools: { ...subagentTools, ...(role === 'worker' ? (mcpConnection?.tools ?? {}) : {}) },
          stopWhen: isStepCount(maxSteps === 0 ? 12 : Math.max(2, Math.min(12, maxSteps))),
        });
        try {
          const streamResult = await subagent.stream({
            prompt: `${cleanTask}${context?.trim() ? `\n\nContext from the parent agent:\n${context.trim()}` : ''}`,
            abortSignal: run.controller.signal,
            onToolExecutionStart: ({ toolCall }) => {
              this.notifyHooks('beforeTool', { tool: toolCall.toolName });
              this.post({ type: 'tool', conversationId, parentId: subagentId, subagentRole: role, phase: 'start', id: `${subagentId}:tool:${toolCall.toolCallId}`, name: toolTask(toolCall.toolName, toolCall.input) });
            },
            onToolExecutionEnd: ({ toolCall, toolOutput }) => {
              this.notifyHooks('afterTool', { tool: toolCall.toolName });
              const failed = toolOutput?.type === 'tool-error';
              this.post({ type: 'tool', conversationId, parentId: subagentId, subagentRole: role, phase: 'end', failed, id: `${subagentId}:tool:${toolCall.toolCallId}`, name: toolTask(toolCall.toolName, toolCall.input) });
            },
          });
          let subagentText = '';
          for await (const part of streamResult.stream) {
            if (part.type === 'text-delta') subagentText += part.text;
            else if (part.type === 'error') throw part.error;
          }
          const usage = await streamResult.usage;
          if (usage?.inputTokens || usage?.outputTokens) {
            recordUsage(this.context, { model: subagentModelId, provider: subagentProviderId, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
          }
          const text = subagentText.trim() || '(Subagent completed without a text response.)';
          this.post({ type: 'subagent', conversationId, id: subagentId, role, task: cleanTask, name: label, phase: 'end', ok: true, result: text.slice(0, 500) });
          return text;
        } catch (error) {
          const message = errorMessage(error);
          this.post({ type: 'subagent', conversationId, id: subagentId, role, task: cleanTask, name: label, phase: 'end', ok: false, error: message });
          throw new Error(`Subagent (${role}) failed: ${message}`);
        }
      };

      const agentTools = filterAgentTools({
        ...buildTools({
          root,
          skillsDir: this.skillsRoot(),
          config: () => this.config(),
          approve: (kind, title, detail, destructive, approvalKey) => this.approve(kind, title, detail, destructive, approvalKey),
          reviewEdit: (filePath, before, after, reason, destructive) => this.reviewEdit(filePath, before, after, reason, destructive),
          post: postToolEvent,
          resolvePath: filePath => this.resolveWorkspacePath(filePath),
          describePlan,
          abortSignal: run.controller.signal,
          terminals: this.terminals,
          delegate,
          memory: memoryAccess,
          repoIndex,
          repoMemory,
          browser: this.browser,
        }),
        ...mcpConnection.tools,
      }, conversationAgent?.tools);

      const agent = new ToolLoopAgent({
        model: provider(model),
        maxRetries: 4,
        instructions,
        tools: agentTools,
        stopWhen: maxSteps === 0 ? isLoopFinished() : isStepCount(maxSteps),
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
        resumeContext = [
          planLines ? `Task plan:\n${planLines}` : '',
          inProgressLines ? `Current task (continue from here):\n${inProgressLines}` : '',
          doneLines ? `Work already completed (do not redo):\n${doneLines}` : '',
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
        const budgetTokens = Math.max(2_000, Math.floor((DEFAULT_CONTEXT_WINDOW * AUTO_COMPACT_RATIO) / 2));
        const recent = this.recentContextItems(conversation, budgetTokens)
          .map(item => `${item.role.toUpperCase()}: ${item.text}`)
          .join('\n\n');
        streamPrompt = recent
          ? `Previous conversation:\n${recent}\n\nCurrent request:\n${userText}${promptContext}`
          : `${userText}${promptContext}`;
      }
      const maxRunRetries = MAX_RUN_RETRIES;
      let runAttempt = 0;
      const baseStreamPrompt = streamPrompt;
      const baseWork = work.slice();
      while (true) {
        let answer = '';
        let finishReason = '';
        let stepCount = 0;
        let lastIterationStepCount = 0;
        let continuationCount = 0;
        let liveInput = 0;
        let liveOutput = 0;
        let runInput = 0;
        let runOutput = 0;
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
            this.notifyHooks('onAgentStart', { text: streamPrompt });
            this.log('info', 'run.stream.start', `conversation=${conversationId}; model=${model}`);
            const result = await agent.stream({
              prompt,
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
                const taskEntry: WorkItem = { kind: 'task', text: toolTask(toolCall.toolName, toolCall.input), done: false };
                activeTasks.set(toolCall.toolCallId, taskEntry);
                work.push(taskEntry);
                workStartedAt ||= Date.now();
                this.post({ type: 'tool', conversationId, phase: 'start', id: toolCall.toolCallId, name: taskEntry.text });
                this.post({ type: 'state', conversationId, running: true, label: humanToolName(toolCall.toolName) });
              },
              onToolExecutionEnd: ({ toolCall }) => {
                this.notifyHooks('afterTool', { tool: toolCall.toolName });
                if (toolCall.toolName === 'plan') return;
                const taskEntry = activeTasks.get(toolCall.toolCallId);
                if (taskEntry) taskEntry.done = true;
                this.post({ type: 'tool', conversationId, phase: 'end', id: toolCall.toolCallId, name: toolTask(toolCall.toolName, toolCall.input) });
              },
            });

            for await (const part of result.stream) {
              if (part.type === 'text-delta') {
                answer += part.text;
                if (answer.length > partialAnswer.length) partialAnswer = answer;
                this.post({ type: 'delta', conversationId, text: part.text });
              } else if (part.type === 'reasoning-delta') {
                workStartedAt ||= Date.now();
                const remaining = MAX_PERSISTED_REASONING - reasoningBuffer.length;
                if (remaining > 0) reasoningBuffer += part.text.slice(0, remaining);
                if (reasoningBuffer.length >= MAX_PERSISTED_REASONING) reasoningTruncated = true;
                this.post({ type: 'reasoningDelta', conversationId, text: part.text });
              } else if (part.type === 'reasoning-end') {
                if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer + (reasoningTruncated ? '\n…(truncated)' : '') });
                reasoningBuffer = '';
                reasoningTruncated = false;
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
                // The most recent step's prompt_tokens is the true context size the
                // provider counted for the last call — the closest measured proxy for
                // current context-window occupancy.
                lastStepInput = input;
                if (input || output) {
                  liveInput += input;
                  liveOutput += output;
                  const liveSpeed = Math.round((liveOutput / Math.max(1, Date.now() - liveStartTime)) * 1000);
                  // contextTokens is the LATEST step's prompt_tokens — the true
                  // context size the provider counted for the current call. It is
                  // pushed live so the context-window pill updates during the run,
                  // not only after the assistant item is committed.
                  this.post({ type: 'liveUsage', conversationId, model, provider: providerConfig.id, inputTokens: liveInput, outputTokens: liveOutput, speed: liveSpeed, contextTokens: input });
                }
              } else if (part.type === 'error') {
                throw part.error;
              } else if (part.type === 'finish') {
                finishReason = part.finishReason;
              }
            }
            lastIterationStepCount = iterationStepCount;
            const usage = await result.usage;
            if (usage?.inputTokens || usage?.outputTokens) {
              const uin = usage.inputTokens ?? 0;
              const uout = usage.outputTokens ?? 0;
              runInput += uin;
              runOutput += uout;
              const durationMs = Date.now() - streamStartTime;
              const tokensPerSecond = durationMs > 0 ? Math.round((uout / durationMs) * 1000) : 0;
              recordUsage(this.context, { model, provider: providerConfig.id, inputTokens: uin, outputTokens: uout, durationMs, tokensPerSecond });
            }
            if (finishReason === 'error') throw new Error('The model stopped because the provider reported a generation error.');
            if (finishReason === 'content-filter') throw new Error('The model stopped because the provider blocked the response.');
            if (!shouldAutoContinue(answer, finishReason, continuationCount)) break;
            continuationCount++;
            streamPrompt = `Continue the original coding request from exactly where you stopped. Do not mention this instruction, do not repeat prior text, and do not stop after describing the next action. Use tools to complete all remaining work, verify it, and only then give the concise final summary.\n\nOriginal request:\n${userText}\n\nWork shown so far:\n${answer.slice(-8_000)}`;
          } while (continuationCount < 2 && !run.controller.signal.aborted);
          this.sendUsage();
          const paused = pausedByStepLimit(maxSteps, lastIterationStepCount, finishReason);
          if (!answer.trim()) answer = paused ? `Iteration paused after reaching the ${maxSteps}-step limit.` : '(No response)';
          if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer + (reasoningTruncated ? '\n…(truncated)' : '') });
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
          const assistantItem = createTranscriptItem('assistant', finalAnswer, undefined, runGitTree, keptWork, workSeconds, runInput || liveInput, runOutput || liveOutput);
          if (lastStepInput) assistantItem.contextTokens = lastStepInput;
          if (paused) {
            assistantItem.paused = true;
            assistantItem.pauseReason = 'max_steps';
            assistantItem.pauseLimit = maxSteps;
          }
          if (runChanges.size) assistantItem.changes = [...runChanges.values()];
          if (snapshotByPath.size) assistantItem.fileSnapshot = [...snapshotByPath.values()];
          conversation.items.push(assistantItem);
          this.boundConversationItems(conversation);
          conversation.updatedAt = Date.now();
          project.updatedAt = Date.now();
          await this.persistProjects();
          if (runAttempt) this.post({ type: 'retryEnd', conversationId, ok: true, attempt: runAttempt, max: maxRunRetries });
          this.post({ type: 'done', conversationId, item: assistantItem });
          systemNotify(this.context, {
            subtitle: paused ? 'Iteration paused' : 'Task complete',
            message: paused ? `Reached the ${maxSteps}-step limit. Continue when ready.` : (notificationSummary(finalAnswer) || conversation.title),
            kind: paused ? 'attention' : 'info',
          });
          break;
        } catch (attemptError) {
          if (run.controller.signal.aborted) throw attemptError;
          const attemptInfo = classifyAgentError(attemptError, providerConfig);
          if (!attemptInfo.retryable || attemptInfo.code === 'action_denied' || runAttempt >= maxRunRetries) {
            if (runAttempt) this.post({ type: 'retryEnd', conversationId, ok: false, attempt: runAttempt, max: maxRunRetries });
            throw attemptError;
          }
          runAttempt++;
          const backoffMs = Math.min(30_000, 1000 * Math.pow(2, runAttempt - 1));
          this.post({ type: 'retry', conversationId, attempt: runAttempt, max: maxRunRetries, error: attemptInfo.message, backoffMs });
          await waitForRetry(backoffMs, run.controller.signal);
          streamPrompt = baseStreamPrompt;
          work.length = 0;
          work.push(...baseWork);
          planState = undefined;
          planItem = undefined;
          activeTasks.clear();
          reasoningBuffer = '';
          reasoningTruncated = false;
          workStartedAt = 0;
        }
      }
    } catch (error) {
      if (run.controller.signal.aborted) {
        if (planState) { planState.interrupted = true; postPlan(); }
        if (run.steering) {
          carriedGitTree = runGitTree;
          this.post({ type: 'steered', conversationId });
        } else this.post({ type: 'error', conversationId, text: 'Stopped.' });
      } else {
        if (reconnectAttempt) this.post({ type: 'retryEnd', conversationId, ok: false, attempt: reconnectAttempt, max: 5 });
        const errorInfo = classifyAgentError(error, providerConfig);
        const message = errorInfo.message;
        if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer + (reasoningTruncated ? '\n…(truncated)' : '') });
        const errorItem = createTranscriptItem('assistant', message, 'error', runGitTree, work.slice(-80), workStartedAt ? Math.max(1, Math.round((Date.now() - workStartedAt) / 1000)) : 0);
        errorItem.errorInfo = errorInfo;
        if (partialAnswer.trim()) errorItem.partialText = partialAnswer;
        if (runChanges.size) errorItem.changes = [...runChanges.values()];
        conversation.items.push(errorItem);
        this.boundConversationItems(conversation);
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.persistProjects();
        finalizePlan();
        this.post({ type: 'generationError', conversationId, item: errorItem });
        systemNotify(this.context, { subtitle: 'Task failed', message: notificationSummary(message) || conversation.title, kind: 'attention' });
      }
    } finally {
      this.log('info', 'run.finally.start', conversationId);
      await mcpConnection?.close();
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
        this.postQueued(next.conversationId);
        void this.run(next.text, next.conversationId, undefined, carriedGitTree, next.context, next.promptContext);
      } else if (own) {
        this.postQueued(conversationId);
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
    if (this.compactionControllers.has(targetId ?? '')) return; // already compacting
    const controller = new AbortController();
    this.compactionControllers.set(targetId ?? '', controller);
    const beforeTokens = contextOccupancy(conversation.items).tokens;
    progress('start', { auto: options?.auto === true });
    try {
      progress('summarizing', { auto: options?.auto === true });
      const selection = this.selectionFor(conversation);
      const before = conversation.items;
      const summarized = await this.summarizeConversation(before, selection, controller.signal);
      conversation.items = summarized.items;
      // Snapshot the boundary so the divider can be undone/redone. A fresh
      // compaction supersedes any pending redo at this boundary.
      const undo = this.compactionUndoStacks.get(targetId ?? '') ?? [];
      undo.push({ before: before.slice(), after: summarized.items.slice() });
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
    if (!shouldAutoCompact(contextTokens, modelInfo.contextWindow)) return;
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
    conversation.items = snapshot.before;
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
    const lastBefore = snapshot.before[snapshot.before.length - 1];
    if (conversation.items.length !== snapshot.before.length || conversation.items[conversation.items.length - 1]?.id !== lastBefore?.id) {
      this.compactionRedoStacks.delete(conversation.id);
      return false;
    }
    stack.pop();
    if (!stack.length) this.compactionRedoStacks.delete(conversation.id);
    const undo = this.compactionUndoStacks.get(conversation.id) ?? [];
    undo.push(snapshot);
    this.compactionUndoStacks.set(conversation.id, undo.slice(-3));
    conversation.items = snapshot.after;
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
  ): Promise<{ items: TranscriptItem[]; usage?: { inputTokens?: number; outputTokens?: number }; modelId: string; providerId: string }> {
    const text = compactionPromptInput(items);
    const prompt = [
      'Summarize the conversation below into a compact continuation context.',
      'Preserve: active goal, unresolved blockers, open todos, key decisions, and latest state.',
      'Omit completed subtasks, repeated confirmations, and tool trivia unless they affect the next steps.',
      'Keep it under 1200 words and write it as a brief assistant message that can be injected into the next run.',
      '',
      text,
    ].join('\n');
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
        if (providerConfig.isSleepy) sleepyToken = (await getSleepyToken()) ?? undefined;
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
              recordUsage(this.context, {
                model: candidateId,
                provider: providerConfig.id,
                inputTokens: attemptUsage.inputTokens ?? 0,
                outputTokens: attemptUsage.outputTokens ?? 0,
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
        const copy = createTranscriptItem(item.role, item.text, undefined, item.gitTree);
        copy.timestamp = item.timestamp;
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

  private async approve(kind: 'edit' | 'command', title: string, detail: string, destructive = false, approvalKey?: string): Promise<void> {
    this.enforceHooks(kind === 'command' ? 'onCommand' : 'onEdit', { tool: kind, path: approvalKey, text: detail });
    const mode = this.config().approvalMode;
    if (!requiresApproval(kind, mode, destructive)) return;

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
      });
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
    });
    if (choice === 'secondary' && kind === 'edit' && !destructive) {
      if (editRoot) this.sessionAutoApproveEditRoots.add(editRoot);
      return;
    }
    if (choice !== 'ok') throw new Error('User denied this action.');
  }

  private async reviewEdit(filePath: string, before: string, after: string, reason: string, destructive = false): Promise<void> {
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
        },
      );
      if (choice === 'secondary' && !destructive) {
        if (editRoot) this.sessionAutoApproveEditRoots.add(editRoot);
        return;
      }
      if (choice !== 'ok') throw new Error('User rejected the proposed edit.');
    } finally {
      setTimeout(() => { void rm(directory, { recursive: true, force: true }); }, 30_000);
    }
  }

  private async prompt(title: string, detail: string, options: { ok?: string; secondary?: string; cancel?: string; danger?: boolean; risk?: 'low' | 'medium' | 'high' } = {}): Promise<'ok' | 'secondary' | 'cancel'> {
    if (!this.view) return 'cancel';
    const id = ++this.notifySeq;
    return new Promise(resolve => {
      this.pendingNotifies.set(id, resolve);
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
      });
    });
  }

  private disposePendingNotifies(): void {
    for (const resolve of this.pendingNotifies.values()) resolve('cancel');
    this.pendingNotifies.clear();
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
      approvalMode: normalizeApprovalMode(this.context.globalState.get<string>('sleepycode.approvalMode', 'ask')),
      searxngUrl: this.context.globalState.get<string>('sleepycode.searxngUrl', ''),
      systemPrompt: this.context.globalState.get<string>('sleepycode.systemPrompt', ''),
      mcpServers: this.context.globalState.get<string>('sleepycode.mcpServers', '{}'),
      extraFreeModels: (config.get<string>('extraFreeModels', '') ?? '').split(',').map(item => item.trim()).filter(Boolean),
      onlyDefaultModels: this.context.globalState.get<boolean>('sleepycode.onlyDefaultModels', true),
      agentId: this.context.globalState.get<string>('sleepycode.agentId', 'default'),
      compactionModel: this.context.globalState.get<string>('sleepycode.compactionModel', ''),
    };
  }

  private selectionFor(conversation: Conversation): { model: string; provider: string; agentId: string } {
    const base = this.config();
    return {
      model: conversation.model ?? base.model,
      provider: conversation.provider ?? base.activeProvider,
      agentId: conversation.agentId ?? base.agentId,
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

  private activeSelection(): { model: string; provider: string; agentId: string } {
    const active = this.activeConversation();
    if (active) return this.selectionFor(active);
    const base = this.config();
    return { model: base.model, provider: base.activeProvider, agentId: base.agentId };
  }

  private postConfig(): void {
    const selection = this.activeSelection();
    this.post({ type: 'config', model: selection.model, provider: selection.provider, approvalMode: this.config().approvalMode, agentId: selection.agentId });
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
    this.lastModelGroups = groups;
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

  private getEffectiveModelInfo(providerId: string, configuredModel: string): { contextWindow?: number; maxOutputLimit?: number } {
    const providers = this.getProviders();
    const providerConfig = getProvider(providers, providerId) ?? providers[0];
    const modelId = configuredModel || providerConfig?.id || '';
    const group = this.lastModelGroups.find(group => group.providerId === (providerConfig?.id ?? ''));
    const modelEntry = group?.models.find(model => typeof model !== 'string' && model.id === modelId);
    if (typeof modelEntry !== 'string' && modelEntry) {
      return { contextWindow: modelEntry.contextWindow, maxOutputLimit: modelEntry.maxOutputLimit };
    }
    const models = providerConfig ? (this.lastModelGroups.find(group => group.providerId === providerConfig.id)?.models ?? []) : [];
    const autoEntry = models.find((model): model is ProviderModelItem => typeof model !== 'string' && model.isAuto === true);
    if (autoEntry) return { contextWindow: autoEntry.contextWindow, maxOutputLimit: autoEntry.maxOutputLimit };
    const first = models.find(model => typeof model !== 'string');
    if (first) return { contextWindow: first.contextWindow, maxOutputLimit: first.maxOutputLimit };
    return {};
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
    void this.view?.webview.postMessage(message);
  }
}
