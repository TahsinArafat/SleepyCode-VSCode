import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, generateText, isLoopFinished, isStepCount } from 'ai';
import { captureGitTree, commitGit, gitChangedPathsBetween, gitFileAtTree, gitHeadShort, gitHeadTreeOrEmpty, gitPorcelain, isGitTrackedWorkspace, restoreGitPath, restoreGitTree, stageGitPaths } from './git';
import { cloneProviders, fetchProviderModels, getProvider, SLEEPY_AUTO_MODEL_ID, type Provider } from './providers';
import { installSkillFromRepository, listInstalledSkills, listRepositorySkills, readSkillMarkdown, resolveInstallPath, sanitizeSkillName, searchSkills, skillsPromptBlock, uninstallSkill, SKILL_FILE_NAMES, SKILLS_SUBDIR } from './skills';
import { buildTools } from './tools';
import type { AppConfig, Attachment, ComposerContext, Conversation, FileChange, Project, ProviderModelGroup, ProviderModelItem, SubagentModelMap, TranscriptItem, WebMessage, WorkItem } from './types';
import type { ModelMessage } from 'ai';
import { MAX_FILE_BYTES, MAX_PERSISTED_REASONING } from './types';
import { classifyAgentError, conversationTitle, createTranscriptItem, errorMessage, friendlyError, humanToolName, isSecret, normalizeApprovalMode, normalizeTranscriptItem, pathInside, requiresApproval, resolvePathSafe, shouldAutoContinue, toolTask, truncate } from './util';
import { pausedByStepLimit } from './iteration-core';
import { getWebviewHtml } from './webview';
import { systemNotify } from './notifications';
import { aggregateUsage, loadUsage, recordUsage } from './usage';
import { connectMcpServers, parseMcpServers, type McpConnection } from './mcp';
import { clearGatewayConfig, fetchSleepyAccountData, fetchSleepyModelPrices, getSleepyAccount, getSleepyToken, getSleepyTokenSync, loginWithBrowser, loginWithDevice, sleepyApiBase, SLEEPY_ACCOUNT_URL, SLEEPY_WEBSITE_URL, type SleepyModelPrice } from './sleepyai';
import { chooseAutoModel, rankModelsByPrice, sortModelsA2Z } from './model-routing-core';
import { TerminalManager } from './terminal';
import { MEMORY_RELATIVE_PATH, openProjectMemory, readProjectMemory, writeProjectMemory } from './memory';
import { ProjectIndexService } from './project-index';
import { retrieveProjectContext, summarizeProjectIndex, type ProjectIntelligence } from './project-index-core';

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

export const AGENT_DEFINITIONS: { id: string; name: string; color: string; prompt?: string }[] = [
  { id: 'default', name: 'SleepyCode', color: '#6c7086' },
  { id: 'apex', name: 'Apex (Builder)', color: '#f43f5e', prompt: 'Act as an implementation-focused builder. Prefer complete, working vertical slices over speculative discussion. Trace dependencies before editing, keep changes cohesive, and verify the user-visible path end to end.' },
  { id: 'phantom', name: 'Phantom (Debugger)', color: '#9333ea', prompt: 'Act as a debugger. Reproduce failures, form falsifiable hypotheses, inspect state transitions and edge cases, then make the smallest fix that addresses the root cause. Add regression coverage for every confirmed bug.' },
  { id: 'pivot', name: 'Pivot (Prototyper)', color: '#eab308', prompt: 'Act as a pragmatic prototyper. Optimize for fast validated learning while keeping the code reversible and understandable. Build the smallest useful implementation, verify it, then harden only the parts proven necessary.' },
  { id: 'forge', name: 'Forge (Reviewer)', color: '#14b8a6', prompt: 'Act as a rigorous reviewer and implementer. Look for correctness, security, regressions, maintainability, and missing tests. Prioritize concrete findings by severity and fix high-confidence issues without unrelated refactors.' },
  { id: 'stack', name: 'Stack (Architect)', color: '#3b82f6', prompt: 'Act as a software architect who still ships code. Preserve clear boundaries, data ownership, and failure semantics. Prefer simple interfaces and migration-safe changes, then verify architecture decisions against real runtime paths.' },
];

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
  private agentPromptCache = new Map<string, string>(); // agentId -> prompt text
  private sessionAllowedCommands = new Set<string>();
  private sessionAutoApproveEditRoots = new Set<string>();
  private lastSleepyAccountRefresh = 0;
  private readonly projectIndex: ProjectIndexService;
  private projectIndexTimer?: NodeJS.Timeout;
  private lastModelGroups: ProviderModelGroup[] = [];
  private lastSleepyModelPrices: SleepyModelPrice[] = [];
  private lastSleepyPriceRefresh = 0;
  private reviewTempDirs = new Set<string>();
  private subagentSequence = 0;
  private compactionControllers = new Map<string, AbortController>();

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
    view.webview.onDidReceiveMessage((message: WebMessage) => this.onMessage(message));
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

  private persistProjects(): Promise<void> {
    const projects = this.projects.slice(0, 60);
    this.persistChain = this.persistChain.then(async () => {
      await this.context.globalState.update('sleepycode.projectIndex', projects.map(({ id, name, path, createdAt, updatedAt }) => ({ id, name, path, createdAt, updatedAt })));
      for (const project of projects) {
        await this.context.globalState.update(`sleepycode.project.${project.id}`, {
          conversations: project.conversations.slice(0, 100),
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
        this.post({ type: 'conversation', id: active.id, items: active.items, model: selection.model, provider: selection.provider, agentId: selection.agentId });
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
      this.runs.get(project?.activeConversationId ?? '')?.controller.abort();
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
    if (message.type === 'cancelCompact') return this.cancelCompaction(message.conversationId);
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
      if (gitTracked) {
        const assistantCheckpoint = conversation.items.slice(targetIndex).find(item => item.role === 'assistant' && item.gitTree);
        if (assistantCheckpoint?.gitTree) {
          try {
            await restoreGitTree(root.fsPath, assistantCheckpoint.gitTree);
          } catch { }
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
        const maxSteps = rawMaxSteps === 0 ? 0 : Math.max(1, Math.min(50, Math.round(rawMaxSteps) || 50));

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
    if (message.type === 'resetSettings') {
      const previousProviders = this.getProviders();
      const config = vscode.workspace.getConfiguration('sleepycode');
      const defaults = cloneProviders();
      await config.update('maxSteps', 50, vscode.ConfigurationTarget.Global);
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
      const editorContext = root ? await this.composerContextBlock(root, message.context) : '';
      const projectContext = root && message.context?.includeProjectIndex !== false ? await this.projectContextBlock(root, message.text.trim()) : '';
      const promptContext = [editorContext, projectContext].filter(Boolean).join('\n\n');
      if (this.runs.has(conversationId) || this.runs.size >= MAX_CONCURRENT_RUNS) {
        this.enqueue(message.text.trim(), conversationId, message.context, promptContext);
      } else {
        void this.run(message.text.trim(), conversationId, undefined, undefined, message.context, promptContext);
      }
      return;
    }
    if (message.type === 'retryMessage') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      const last = conversation.items[conversation.items.length - 1];
      const resume = last?.kind === 'error'
        ? { work: last.work, errorText: last.text, changes: last.changes }
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
      const resume = {
        work: last.work,
        changes: last.changes,
        errorText: `The previous iteration paused after reaching its ${last.pauseLimit ?? this.config().maxSteps}-step limit. Continue only the unfinished work.`,
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

  private async run(userText: string, conversationId: string, resume?: { work?: WorkItem[]; errorText?: string; changes?: FileChange[] }, carryTree?: string, composerContext?: ComposerContext, preparedPromptContext?: string): Promise<void> {
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
    let runGitTree = gitTracked ? carryTree : undefined;
    let carriedGitTree = carryTree;
    if (resume) {
      this.post({ type: 'resume', conversationId });
    } else {
      const userItem = createTranscriptItem('user', userText);
      userItem.attachments = composerContext?.attachments;
      conversation.items.push(userItem);
      if (conversation.items.length === 1) conversation.title = conversationTitle(userText);
      this.post({ type: 'user', conversationId, item: userItem });
    }
    conversation.updatedAt = Date.now();
    project.updatedAt = Date.now();
    await this.persistProjects();
    this.syncConversations(false);
    this.post({ type: 'state', conversationId, running: true, label: 'Thinking' });

    const work: WorkItem[] = resume ? [...(resume.work ?? [])] : [];
    const runChanges = new Map<string, FileChange>((resume?.changes ?? []).map(change => [change.path, change]));
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
          } else {
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
    const selection = this.selectionFor(conversation);
    const providerConfig = getProvider(this.getProviders(), selection.provider) ?? this.getProviders()[0];
    let reconnectAttempt = 0;
    try {
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
              this.post({ type: 'tool', conversationId, parentId: subagentId, subagentRole: role, phase: 'start', id: `${subagentId}:tool:${toolCall.toolCallId}`, name: toolTask(toolCall.toolName, toolCall.input) });
            },
            onToolExecutionEnd: ({ toolCall, toolOutput }) => {
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

      const agentTools = {
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
        }),
        ...mcpConnection.tools,
      };

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
        ].filter(Boolean).join('\n\n');
        streamPrompt = resumeContext
          ? `The previous attempt of this task was interrupted. Continue from exactly where it stopped, using the plan and last task below: do NOT redo completed work or replay the original request. Work through only the remaining steps, verify the result, then give only the concise final summary.\n\n${resumeContext}`
          : userText;
      } else {
        const recent = conversation.items.slice(-10, -1)
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
            const result = await agent.stream({
              prompt,
              abortSignal: run.controller.signal,
              onToolExecutionStart: ({ toolCall }) => {
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
                if (toolCall.toolName === 'plan') return;
                const taskEntry = activeTasks.get(toolCall.toolCallId);
                if (taskEntry) taskEntry.done = true;
                this.post({ type: 'tool', conversationId, phase: 'end', id: toolCall.toolCallId, name: toolTask(toolCall.toolName, toolCall.input) });
              },
            });

            for await (const part of result.stream) {
              if (part.type === 'text-delta') {
                answer += part.text;
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
                if (input || output) {
                  liveInput += input;
                  liveOutput += output;
                  const liveSpeed = Math.round((liveOutput / Math.max(1, Date.now() - liveStartTime)) * 1000);
                  this.post({ type: 'liveUsage', conversationId, model, provider: providerConfig.id, inputTokens: liveInput, outputTokens: liveOutput, speed: liveSpeed });
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
          if (providerConfig.id === 'sleepyai') {
            const session = this.sessionMetricsForConversation(conversation);
            session.inputTokens += runInput;
            session.outputTokens += runOutput;
            const effectiveModelInfo = this.getEffectiveModelInfo(providerConfig.id, configuredModel);
            if (this.shouldAutoCompact(session, effectiveModelInfo)) {
              void this.compactConversation(conversationId);
            }
          }
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
          const assistantItem = createTranscriptItem('assistant', answer, undefined, runGitTree, keptWork, workSeconds, runInput || liveInput, runOutput || liveOutput);
          if (paused) {
            assistantItem.paused = true;
            assistantItem.pauseReason = 'max_steps';
            assistantItem.pauseLimit = maxSteps;
          }
          if (runChanges.size) assistantItem.changes = [...runChanges.values()];
          conversation.items.push(assistantItem);
          conversation.items = conversation.items.slice(-60);
          conversation.updatedAt = Date.now();
          project.updatedAt = Date.now();
          await this.persistProjects();
          if (runAttempt) this.post({ type: 'retryEnd', conversationId, ok: true, attempt: runAttempt, max: maxRunRetries });
          this.post({ type: 'done', conversationId, item: assistantItem });
          systemNotify(this.context, {
            subtitle: paused ? 'Iteration paused' : 'Task complete',
            message: paused ? `Reached the ${maxSteps}-step limit. Continue when ready.` : (notificationSummary(answer) || conversation.title),
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
        if (runChanges.size) errorItem.changes = [...runChanges.values()];
        conversation.items.push(errorItem);
        conversation.items = conversation.items.slice(-60);
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.persistProjects();
        finalizePlan();
        this.post({ type: 'generationError', conversationId, item: errorItem });
        systemNotify(this.context, { subtitle: 'Task failed', message: notificationSummary(message) || conversation.title, kind: 'attention' });
      }
    } finally {
      await mcpConnection?.close();
      this.post({ type: 'liveUsage', conversationId, model: '', provider: '', inputTokens: 0, outputTokens: 0 });
      this.runs.delete(conversationId);
      this.post({ type: 'state', conversationId, running: false, label: '' });
      this.syncConversations(false);
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

  private cancelCompaction(conversationId?: string): void {
    const project = this.activeProject();
    const targetId = conversationId ?? project?.activeConversationId ?? '';
    const controller = this.compactionControllers.get(targetId);
    if (controller) {
      controller.abort();
      this.compactionControllers.delete(targetId);
    }
    this.post({ type: 'compactProgress', conversationId: targetId, phase: 'cancelled' });
  }

  private async compactConversation(conversationId?: string): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    const targetId = conversationId ?? project.activeConversationId;
    const conversation = project.conversations.find(entry => entry.id === targetId);
    if (!conversation || conversation.items.length < 4) {
      this.post({ type: 'compactStatus', conversationId: targetId ?? '', ok: false, summary: 'Nothing to compact yet.' });
      return;
    }
    if (this.runs.has(targetId ?? '')) {
      this.post({ type: 'compactStatus', conversationId: targetId ?? '', ok: false, summary: 'Wait until the current run finishes.' });
      return;
    }
    if (this.compactionControllers.has(targetId ?? '')) return; // already compacting
    const controller = new AbortController();
    this.compactionControllers.set(targetId ?? '', controller);
    this.post({ type: 'compactProgress', conversationId: targetId ?? '', phase: 'start' });
    const lastAssistant = [...conversation.items].reverse().find(item => item.role === 'assistant');
    const preTokens = this.sessionMetricsForConversation(conversation);
    let compacted: TranscriptItem[] | undefined;
    try {
      this.post({ type: 'compactProgress', conversationId: targetId ?? '', phase: 'summarizing' });
      compacted = await this.summarizeConversation(conversation.items, this.selectionFor(conversation), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        this.post({ type: 'compactProgress', conversationId: targetId ?? '', phase: 'cancelled' });
        return;
      }
      this.compactionControllers.delete(targetId ?? '');
      this.post({ type: 'compactStatus', conversationId: targetId ?? '', ok: false, summary: `Compaction failed: ${errorMessage(error)}` });
      return;
    }
    if (!compacted) {
      this.compactionControllers.delete(targetId ?? '');
      this.post({ type: 'compactStatus', conversationId: targetId ?? '', ok: false, summary: 'Compaction produced no output.' });
      return;
    }
    conversation.items = compacted;
    if (lastAssistant) {
      conversation.title = lastAssistant.text?.trim().slice(0, 80) ?? conversation.title;
    }
    project.updatedAt = Date.now();
    conversation.updatedAt = Date.now();
    await this.persistProjects();
    this.syncConversations();
    const inputTokens = conversation.items.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
    const outputTokens = conversation.items.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0);
    const newContextTokens = inputTokens + outputTokens;
    const selection = this.selectionFor(conversation);
    const modelInfo = this.getEffectiveModelInfo(selection.provider, selection.model);
    const contextWindow = modelInfo.contextWindow;
    this.compactionControllers.delete(targetId ?? '');
    this.post({ type: 'compactStatus', conversationId: targetId ?? '', ok: true, summary: `Compacted to ${conversation.items.length} messages.`, inputTokens, outputTokens });
    this.post({ type: 'compactProgress', conversationId: targetId ?? '', phase: 'done', summary: `Compacted to ${conversation.items.length} messages. Freed ${Math.max(0, preTokens.inputTokens + preTokens.outputTokens - newContextTokens).toLocaleString()} tokens.`, inputTokens, outputTokens, newContextTokens, contextWindow });
  }

  private async summarizeConversation(items: TranscriptItem[], selection: { model: string; provider: string; agentId: string }, signal?: AbortSignal): Promise<TranscriptItem[]> {
    const text = items
      .map(item => {
        const role = item.role === 'user' ? 'User' : 'Assistant';
        // Skip reasoning/thinking tokens: use only the main text content, not work[].kind === 'reasoning'
        const reasoningText = (item.work ?? []).filter(w => w.kind === 'reasoning').map(w => w.text).join('\n').trim();
        let content = item.text.trim().replace(/\s+/g, ' ').slice(0, 4000);
        // Exclude reasoning text from compaction input — think tokens should not be summarized
        if (reasoningText && content.includes(reasoningText.slice(0, 200))) {
          content = content.replace(reasoningText.slice(0, 200), '').trim();
        }
        return `[${role}] ${content}`;
      })
      .join('\n\n');
    const prompt = [
      'Summarize the conversation below into a compact continuation context.',
      'Preserve: active goal, unresolved blockers, open todos, key decisions, and latest state.',
      'Omit completed subtasks, repeated confirmations, and tool trivia unless they affect the next steps.',
      'Keep it under 1200 words and write it as a brief assistant message that can be injected into the next run.',
      '',
      text,
    ].join('\n');
    let summaryText = '';
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
        for (const modelId of candidates) {
          if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Aborted.');
          try {
            const result = await generateText({ model: provider(modelId), prompt, maxOutputTokens: 1024, ...(signal ? { abortSignal: signal } : {}) });
            const text = result.text.trim();
            if (text) { summaryText = text; break; }
          } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
            // Try the next cheapest available model.
          }
        }
      }
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Aborted.');
    if (!summaryText) summaryText = `Compacted context.\nOriginal message count: ${items.length}.`;
    const summary = createTranscriptItem('assistant', summaryText.trim() || 'Compacted context.');
    const inputTokens = items.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
    const outputTokens = items.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0);
    if (inputTokens) summary.inputTokens = inputTokens;
    if (outputTokens) summary.outputTokens = outputTokens;
    const lastUser = [...items].reverse().find(item => item.role === 'user');
    const lastAssistant = [...items].reverse().find(item => item.role === 'assistant');
    return [
      lastUser ?? createTranscriptItem('user', 'Continue the previous conversation.'),
      summary,
      createTranscriptItem('user', 'Continue from the compacted context above.'),
      ...(lastAssistant && lastAssistant !== lastUser ? [lastAssistant] : []),
    ];
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

  private async approve(kind: 'edit' | 'command', title: string, detail: string, destructive = false, approvalKey?: string): Promise<void> {
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
      maxSteps: config.get<number>('maxSteps', 50),
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

  private sessionMetricsForConversation(conversation: Conversation): { inputTokens: number; outputTokens: number } {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const item of conversation.items) {
      inputTokens += item.inputTokens ?? 0;
      outputTokens += item.outputTokens ?? 0;
    }
    return { inputTokens, outputTokens };
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

  private shouldAutoCompact(session: { inputTokens: number; outputTokens: number }, modelInfo: { contextWindow?: number; maxOutputLimit?: number }): boolean {
    const contextWindow = modelInfo.contextWindow ?? 128_000;
    const totalTokens = session.inputTokens + session.outputTokens;
    if (totalTokens <= 0 || contextWindow <= 0) return false;
    const usageRatio = totalTokens / contextWindow;
    if (usageRatio < 0.75) return false;
    return true;
  }

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

    const agentDef = AGENT_DEFINITIONS.find(a => a.id === agentId);
    if (!agentDef?.prompt) return ideContext;
    const cached = this.agentPromptCache.get(agentId) ?? agentDef.prompt;
    this.agentPromptCache.set(agentId, cached);
    return `${ideContext}

---

Agent personality and style:

${cached}`;
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}
