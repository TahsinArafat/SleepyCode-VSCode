/**
 * Bridge between SleepyCode's stored configuration and the settings
 * window.
 *
 * The settings window is a ported React UI, so it speaks that UI's
 * shapes (`McpServerConfig`, `McpStatus`, its own `Settings`). SleepyCode owns
 * the storage. Everything here is a pure mapping so it can be tested without an
 * extension host, and so no panel code has to know both vocabularies.
 *
 * Note the MCP config shape is deliberately the ported UI's rather than
 * SleepyCode's older `{ url, transport, auth }`: it supports stdio
 * (command/args/env), which SleepyCode's saved connections could not express at
 * all, and it is the shape the already-ported `src/mcp-client.ts` consumes.
 */

// ---------------------------------------------------------------- MCP

/** The MCP connection as the settings window stores it. */
export interface PanelMcpConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: { clientId?: string; scopes?: string[] };
  enabled: boolean;
}

/** A saved MCP connection as SleepyCode stores it. */
export interface StoredMcpConnection {
  name?: string;
  description?: string;
  transport?: 'stdio' | 'sse' | 'http';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: { clientId?: string; scopes?: string[] };
  auth?: { type?: string };
  enabled?: boolean;
  order?: number;
}

/** A per-server connection result, as SleepyCode reports it. */
export interface StoredMcpStatus {
  name: string;
  state: 'ok' | 'auth_required' | 'error' | 'disabled';
  error?: string;
  toolCount?: number;
  /** Tool names the server exposes, listed in the settings row. */
  tools?: string[];
}

export interface PanelMcpStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  tools?: string[];
  error?: string;
  authState?: 'none' | 'required' | 'authorizing' | 'authenticated';
}

/** Stored connection -> the settings window's config. */
export function toMcpPanelConfig(connection: StoredMcpConnection): PanelMcpConfig {
  const transport = connection.transport ?? (connection.command ? 'stdio' : 'http');
  const config: PanelMcpConfig = {
    name: connection.name ?? '',
    transport,
    enabled: connection.enabled !== false,
  };
  if (transport === 'stdio') {
    if (connection.command) config.command = connection.command;
    if (connection.args?.length) config.args = connection.args;
    if (connection.env && Object.keys(connection.env).length) config.env = connection.env;
  } else {
    if (connection.url) config.url = connection.url;
    if (connection.headers && Object.keys(connection.headers).length) config.headers = connection.headers;
  }
  if (connection.oauth) config.oauth = connection.oauth;
  return config;
}

/** The settings window's config -> a stored connection. */
export function fromMcpPanelConfig(config: PanelMcpConfig, order: number): StoredMcpConnection {
  const stored: StoredMcpConnection = {
    name: config.name,
    transport: config.transport,
    enabled: config.enabled !== false,
    order,
    // SleepyCode authenticates MCP through its own flows; the panel's OAuth
    // fields are carried through untouched so nothing is lost on save.
    auth: { type: 'none' },
  };
  if (config.transport === 'stdio') {
    if (config.command) stored.command = config.command;
    if (config.args?.length) stored.args = config.args;
    if (config.env) stored.env = config.env;
  } else {
    if (config.url) stored.url = config.url;
    if (config.headers) stored.headers = config.headers;
  }
  if (config.oauth) stored.oauth = config.oauth;
  return stored;
}

/**
 * A connection is usable only if it names a way to be reached. An entry with
 * neither URL nor command would connect to nothing, so it is dropped on load
 * rather than shown as a server that silently does not work.
 */
export function isUsableConnection(connection: StoredMcpConnection | undefined | null): boolean {
  if (!connection || typeof connection.name !== 'string' || !connection.name) return false;
  return Boolean((connection.url && connection.url.trim()) || (connection.command && connection.command.trim()));
}

/** Keep only the connections that can actually be connected to. */
export function usableConnections<T extends StoredMcpConnection>(connections: readonly T[] | undefined): T[] {
  if (!Array.isArray(connections)) return [];
  return connections.filter(isUsableConnection);
}

/** Stored status -> the settings window's status row. */
export function toMcpPanelStatus(status: StoredMcpStatus): PanelMcpStatus {
  if (status.state === 'auth_required') {
    const row: PanelMcpStatus = { name: status.name, connected: false, toolCount: 0, authState: 'required' };
    if (status.error) row.error = status.error;
    return row;
  }
  const row: PanelMcpStatus = {
    name: status.name,
    connected: status.state === 'ok',
    toolCount: status.toolCount ?? 0,
    authState: 'none',
  };
  if (status.tools?.length) row.tools = status.tools;
  if (status.state === 'error' && status.error) row.error = status.error;
  if (status.state === 'disabled') row.error = 'Disabled';
  return row;
}

/**
 * The `features` message the settings window reads its MCP page from. Only the
 * fields this panel uses are sent; the rest of `FeatureConfig` belongs to
 * Upstream features SleepyCode hides.
 */
export function toPanelFeatures(
  connections: readonly StoredMcpConnection[],
  statuses: readonly (StoredMcpStatus | PanelMcpStatus)[] = [],
  extras: PanelFeatureExtras = {},
): {
  type: 'features';
  /**
   * The window does `setFeaturesState({ ...EMPTY_FEATURES, ...msg.features })`,
   * so the config MUST be nested here. Sending `mcpServers` at the top level
   * leaves `msg.features` undefined, the state falls back to `EMPTY_FEATURES`,
   * and no server ever renders even though the host sent one.
   */
  features: { mcpServers: PanelMcpConfig[] };
  /** Read from `msg.mcpStatus` directly, so this one stays at the top level. */
  mcpStatus: PanelMcpStatus[];
  /** Also top level: the window reads `msg.rules` and `msg.skills`. */
  rules: PanelRuleInfo[];
  skills: PanelSkillInfo[];
} {
  return {
    type: 'features',
    features: { mcpServers: (connections ?? []).map(toMcpPanelConfig) },
    // Accepts either shape: stored statuses are translated, already-panel
    // statuses (from `completeMcpStatuses`) pass straight through.
    mcpStatus: (statuses ?? []).map((status) => ('connected' in status ? status : toMcpPanelStatus(status))),
    rules: toPanelRules(extras.memory),
    skills: toPanelSkills(extras.skills),
  };
}

// ---------------------------------------------------------------- skills and rules

/** A skill row as the settings window renders it. */
export interface PanelSkillInfo {
  name: string;
  description: string;
  path: string;
  pluginId?: string;
}

/** A rule row as the settings window renders it. */
export interface PanelRuleInfo {
  file: string;
  path?: string;
  alwaysApply: boolean;
  globs: string;
  description: string;
}

export interface PanelFeatureExtras {
  skills?: readonly { name: string; description?: string; folder?: string; skillMdPath?: string }[];
  memory?: { memoryPath: string; memoryExists: boolean };
}

/** Installed skills -> the panel's rows. */
export function toPanelSkills(skills: readonly { name: string; description?: string; skillMdPath?: string }[] | undefined): PanelSkillInfo[] {
  return (skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description ?? '',
    path: skill.skillMdPath ?? '',
  }));
}

/**
 * SleepyCode's durable instructions are one project memory file. It applies to
 * every request, which is exactly what the panel's "always apply" rule means.
 */
export function toPanelRules(memory: { memoryPath: string; memoryExists: boolean } | undefined): PanelRuleInfo[] {
  if (!memory?.memoryExists) return [];
  const file = memory.memoryPath.split('/').pop() || memory.memoryPath;
  return [{
    file,
    path: memory.memoryPath,
    alwaysApply: true,
    globs: '',
    description: 'Durable project decisions the agent reads on every request.',
  }];
}

// ---------------------------------------------------------------- settings

export interface StoredSettings {
  model?: string;
  maxSteps?: number;
  systemPrompt?: string;
  repoIndex?: boolean;
  /**
   * The window's "System notifications" toggle. Part of this shape, and written
   * by the same handler, because a field with no key here is a toggle that saves
   * nowhere — the defect this shape exists to prevent.
   */
  systemNotifications?: boolean;
}

export interface PanelSettings {
  model: string;
  maxResponseLength: number;
  enableWorkspaceContext: boolean;
  enableFileReading: boolean;
  enableTerminalSuggestions: boolean;
  systemPrompt: string;
}

/**
 * Map SleepyCode configuration onto the panel's fields. Each field maps to the
 * nearest real SleepyCode setting rather than being left blank, because a blank
 * field reads as "unset" and invites the user to set something that does not
 * exist.
 */
export function toPanelSettings(settings: StoredSettings): PanelSettings {
  return {
    model: settings.model ?? '',
    // The panel calls it a response length; SleepyCode's cap on a run is steps.
    maxResponseLength: settings.maxSteps ?? 0,
    enableWorkspaceContext: settings.repoIndex !== false,
    enableFileReading: true,
    enableTerminalSuggestions: true,
    systemPrompt: settings.systemPrompt ?? '',
  };
}

/** Panel edits -> the SleepyCode configuration keys they correspond to. */
export function fromPanelSettings(settings: Partial<PanelSettings>): StoredSettings {
  const patch: StoredSettings = {};
  if (typeof settings.model === 'string') patch.model = settings.model;
  if (typeof settings.systemPrompt === 'string') patch.systemPrompt = settings.systemPrompt;
  if (typeof settings.enableWorkspaceContext === 'boolean') patch.repoIndex = settings.enableWorkspaceContext;
  if (typeof settings.maxResponseLength === 'number') patch.maxSteps = settings.maxResponseLength;
  return patch;
}

// ---------------------------------------------------------------- usage

/** One model's row in the panel, matching the panel's `ModelUsage`. */
export interface PanelModelUsage {
  promptTokens: number;
  completionTokens: number;
  requests: number;
  lastUsed: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

/**
 * SleepyCode aggregates usage per model over several periods; the panel renders
 * a flat `Record<model, ModelUsage>` keyed by model name. Only the current
 * period is used, because the panel's own totals are computed by summing rows.
 */
export function toPanelUsage(aggregate: any): Record<string, PanelModelUsage> {
  const rows: Record<string, PanelModelUsage> = {};
  for (const entry of aggregate?.models ?? []) {
    const model = typeof entry?.model === 'string' ? entry.model : undefined;
    if (!model) continue;
    const today = entry?.periods?.today ?? {};
    const requests = entry?.requestCount ?? 0;
    // A model with no recorded use in this period contributes nothing, and
    // including it would add an all-zero row to the panel.
    if (!requests && !today.input && !today.output) continue;
    rows[model] = {
      promptTokens: today.input ?? 0,
      completionTokens: today.output ?? 0,
      requests,
      lastUsed: entry?.lastUsed ?? Date.now(),
      cachedReadTokens: today.cacheRead ?? 0,
      cachedWriteTokens: today.cacheWrite ?? 0,
    };
  }
  return rows;
}

// ---------------------------------------------------------------- routing

/**
 * Messages the settings window sends that SleepyCode can answer. Anything else
 * (local runtimes, docs indexing, semantic index) belongs to the base UI
 * features this build hides, and answering them with invented data would be
 * worse than ignoring them.
 */
const SUPPORTED_PANEL_MESSAGES = new Set<string>([
  'getSettings',
  'saveSettings',
  'getFeatures',
  'saveFeatures',
  'getUsage',
  // The Usage panel's two buttons and its quota read. Without these the window
  // posted and waited for replies that could never come.
  'resetUsage',
  'oauthGet',
  'syncMcp',
  'mcpLogin',
  'mcpLogout',
  // The Marketplace section is SleepyCode's own, and reuses SleepyCode's
  // existing marketplace messages rather than inventing a parallel API.
  'marketplaceTop',
  'marketplaceSearch',
  'marketplaceInstall',
  'marketplaceUninstall',
  'requestMarketplaceInstalled',
  // Rules & Skills. `createRule`/`deleteRule`/`managePlugins`/`browserSettings`
  // are deliberately absent: SleepyCode has no rule model beyond its single
  // project memory file, and no plugin or browser surface, so those buttons were
  // removed from the page rather than wired to something else.
  'openWorkspaceFile',
  'createSkill',
  'deleteSkill',
  'fetchAllModels',
  'openVsCodeSettings',
  'openEditorSettings',
  'openKeyboardShortcuts',
  'openExternal',
  // Providers: the surface that was missing entirely, so no compatibility
  // endpoint could be added or given a key.
  'getProviders',
  'saveProvider',
  'deleteProvider',
  'setProviderKey',
  // The three settings surfaces the window gained alongside the classic ones.
  'getLogs',
  'clearLogs',
  'resetAllSettings',
  'completeSetup',
  // The window's only sign-in control, and the first-run CTA. The host had a case
  // for it but it was never listed, so every click was dropped.
  'signIn',
  // The account section. `signOut` had no counterpart anywhere: the host never
  // cleared the stored token, so there was no way to leave an account.
  'getAccount',
  'signOut',
  // Hooks. The ported page edited shell commands that nothing ran; this build
  // edits the rules the host actually evaluates.
  'getHooks',
  'saveHooks',
]);

/** True when the settings window asked for something this build can serve. */
export function isPanelMessage(message: { type?: string } | null | undefined): boolean {
  if (!message || typeof message.type !== 'string') return false;
  return SUPPORTED_PANEL_MESSAGES.has(message.type);
}
// ---------------------------------------------------------------- status completeness

/**
 * Guarantee one status row per stored connection.
 *
 * The settings window shows "idle" for any server with no matching status, which
 * is indistinguishable from "nothing was checked". A sync that omits a server —
 * because it was filtered out, because the sync threw and reported a single
 * unnamed failure, or because a connection errored before a status was written —
 * therefore looked like a server that simply does nothing.
 *
 * Unnamed sync-level failures are folded into the real rows rather than kept as
 * their own row, so an error can never hide behind a name no server has.
 */
export function completeMcpStatuses(
  connections: readonly { name: string; enabled?: boolean }[] | undefined,
  statuses: readonly StoredMcpStatus[] | undefined,
): PanelMcpStatus[] {
  const known = new Map<string, StoredMcpStatus>();
  for (const status of statuses ?? []) {
    if (status?.name) known.set(status.name, status);
  }
  const names = new Set((connections ?? []).map((connection) => connection.name));
  // A sync-level failure carries the reason for every server it covered.
  const syncLevel = (statuses ?? []).filter((status) => status?.name && !names.has(status.name));

  return (connections ?? []).map((connection) => {
    const match = known.get(connection.name);
    if (match) return toMcpPanelStatus(match);
    const disabled = connection.enabled === false;
    const reason = syncLevel.map((status) => status.error).filter(Boolean).join(' · ');
    return {
      name: connection.name,
      connected: false,
      toolCount: 0,
      authState: 'none',
      error: disabled ? 'Disabled' : reason || 'The server did not report a connection result.',
    };
  });
}

// ---------------------------------------------------------------- marketplace

/** A marketplace search result as the panel renders it. */
export interface PanelMarketplaceRow {
  name: string;
  description: string;
  author: string;
  stars: number;
  /** Repository URL used as the install source, absent when uninstallable. */
  source?: string;
  installed: boolean;
}

/** A skill folder name, normalized the way installs are sanitized. */
function skillKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Marketplace search results -> installable rows.
 *
 * The install source is the skill's repository URL: `resolveInstallPath` on the
 * host parses that form, and a row without one is shown but not installable
 * rather than offering a button that cannot work.
 */
export function toMarketplaceSkillRows(
  skills: readonly any[] | undefined,
  installedNames: readonly string[] = [],
): PanelMarketplaceRow[] {
  const installed = new Set((installedNames ?? []).map(skillKey));
  const rows: PanelMarketplaceRow[] = [];
  for (const skill of skills ?? []) {
    if (!skill || typeof skill.name !== 'string' || !skill.name) continue;
    const row: PanelMarketplaceRow = {
      name: skill.name,
      description: typeof skill.description === 'string' ? skill.description : '',
      author: typeof skill.author === 'string' ? skill.author : '',
      stars: typeof skill.stars === 'number' ? skill.stars : 0,
      // Matching is on the sanitized name, because the installed folder is
      // derived from it rather than kept verbatim.
      installed: installed.has(skillKey(skill.name)),
    };
    if (typeof skill.githubUrl === 'string' && skill.githubUrl) row.source = skill.githubUrl;
    rows.push(row);
  }
  return rows;
}

/** Installed skills -> rows that carry the folder needed to uninstall. */
export function toInstalledSkillRows(
  skills: readonly { name: string; description?: string; folder?: string; skillMdPath?: string }[] | undefined,
): { name: string; description: string; folder: string; path: string }[] {
  return (skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description ?? '',
    folder: skill.folder ?? '',
    path: skill.skillMdPath ?? '',
  }));
}

// ---------------------------------------------------------------- url validation

/**
 * One rule for whether a remote MCP URL is usable, shared by the settings editor
 * and the connection client.
 *
 * Previously the editor accepted any `http(s)` URL while the ported client
 * required HTTPS (or plain HTTP on loopback only), so a server could be saved
 * successfully and then never connect — with no explanation at save time.
 *
 * Everything that is not HTTPS is refused unless it is loopback, because a
 * remote server receives configured headers, which are routinely secrets.
 * Returns `null` when the URL is fine, or a message to show the user.
 */
export function validatePanelMcpUrl(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return 'Enter the server URL.';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a valid URL, for example https://example.com/mcp.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Use an HTTP(S) server URL.';
  }
  if (url.username || url.password) {
    return 'Use an HTTP(S) server URL without embedded credentials.';
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    return 'Remote MCP requires HTTPS, or HTTP on localhost.';
  }
  return null;
}

// ---------------------------------------------------------------- modes

export { approvalAppliesInMode } from './webview-adapter.ts';

// ---------------------------------------------------------------- sections

/**
 * Settings sections that belong to base-UI-only features.
 *
 * This is the canonical list. The webview's rail re-exports it rather than
 * keeping its own copy, because two lists that must match are a bug waiting to
 * happen: the rail would offer a section the host refuses to route to, or the
 * host would refuse one the rail shows.
 *
 * Nothing is deleted — re-enabling a section is one line here.
 */
export const HIDDEN_SETTINGS_SECTIONS = [
  'llamacpp',
  'ollama',
  'personas',
  'subagents',
  'indexing',
  // Backed by the base UI's own stores, which SleepyCode does not have: showing
  // them would present controls that write nowhere.
  'models',
  'agents',
] as const;

const hiddenSections = new Set<string>(HIDDEN_SETTINGS_SECTIONS);

/**
 * The sections this build actually serves. Listed so an unknown id can be told
 * apart from a known one: the window renders nothing for either, and a blank
 * settings page reads as broken rather than as absent.
 */
export const VISIBLE_SETTINGS_SECTIONS = [
  'general',
  // The SleepyAI account: who is signed in, what the plan allows, and sign out.
  'account',
  // Served now: adding a compatibility endpoint and setting its key.
  'providers',
  'usage',
  'behavior',
  'rules',
  // Backed now: the page edits the rules the host evaluates.
  'hooks',
  'marketplace',
  'mcp',
  'advanced',
  'about',
] as const;

const visibleSections = new Set<string>(VISIBLE_SETTINGS_SECTIONS);

/** True when a settings section is base-UI-only and must not be displayed. */
export function isSectionHidden(id: string | undefined): boolean {
  return typeof id === 'string' && hiddenSections.has(id);
}

/**
 * The section the window should actually show.
 *
 * A jump or a host `navigate` can name a hidden section, or one that does not
 * exist at all; the window renders nothing for either, so both resolve to the
 * fallback instead of going blank. A visible section is never redirected.
 */
export function visibleSection(id: string | undefined, fallback = 'general'): string {
  if (typeof id !== 'string' || !id) return fallback;
  return visibleSections.has(id) ? id : fallback;
}

// ---------------------------------------------------------------- usage actions

export type UsageAction = 'refresh' | 'reset';
export type UsageActionStatus = 'success' | 'cancelled' | 'error';

/**
 * The reply the Usage panel matches on.
 *
 * Both buttons post a request and then wait for `usageActionResult`; nothing used
 * to send one, so each action hung for 30 seconds and reported "No response
 * received" — a fake timeout on a read that works. The request id and the action
 * are echoed verbatim, because the panel ignores a result that does not name the
 * thing it is waiting on.
 *
 * Returns `null` for a status or action the panel cannot match, rather than
 * posting something it will silently ignore (and then time out on anyway).
 */
export function usageActionResultMessage(input: {
  requestId?: unknown;
  action?: unknown;
  status?: unknown;
  error?: string;
}): { type: 'usageActionResult'; requestId: string; action: UsageAction; status: UsageActionStatus; error?: string } | null {
  const requestId = typeof input.requestId === 'string' ? input.requestId : '';
  const action = input.action === 'refresh' || input.action === 'reset' ? input.action : undefined;
  const status = input.status === 'success' || input.status === 'cancelled' || input.status === 'error'
    ? input.status
    : undefined;
  if (!requestId || !action || !status) return null;
  return {
    type: 'usageActionResult',
    requestId,
    action,
    status,
    // Only on failure: a success with an `error` key would let a stale reason
    // linger in the panel.
    ...(status === 'error' && input.error ? { error: input.error } : {}),
  };
}

/**
 * Whether a request should be recorded at all.
 *
 * The Track Usage toggle was persisted but never consulted, so turning it off
 * changed nothing. Absent means on: a user who never touched the setting still
 * expects their usage to be counted.
 */
export function shouldRecordUsage(features: { trackUsage?: unknown } | undefined | null): boolean {
  return (features as { trackUsage?: unknown } | undefined | null)?.trackUsage !== false;
}

/**
 * Whether the Account Quota section has anything to say.
 *
 * SleepyCode has one first-party account plus optional key-based endpoints, and
 * no OAuth provider accounts at all (`OAUTH_PROVIDER_DEFINITIONS` is empty), so
 * this section can only ever be empty. A permanently empty block reads as broken
 * rather than as absent, so it is hidden until a build actually has accounts.
 */
export function shouldShowAccountQuota(status: { accounts?: unknown[] } | undefined | null): boolean {
  return Array.isArray(status?.accounts) && status.accounts.length > 0;
}

/** The truthful OAuth status for this build: no accounts, no errors. */
export function emptyOAuthStatus(): { accounts: unknown[]; errors: Record<string, string> } {
  return { accounts: [], errors: {} };
}

// ---------------------------------------------------------------- rules & skills

/** Normalise a path for comparison: separators unified, `.`/`..` collapsed. */
function normalizePath(value: string): string {
  const unified = value.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const segment of unified.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      // Walk back only within the path: a leading `..` is kept so a traversal
      // attempt cannot normalise its way inside a root it never was in.
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push('..');
      continue;
    }
    parts.push(segment);
  }
  return (unified.startsWith('/') ? '/' : '') + parts.join('/');
}

/** True when `candidate` is the same file as, or inside, `root`. */
function isInside(root: string, candidate: string): boolean {
  const base = normalizePath(root);
  const target = normalizePath(candidate);
  return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/**
 * The skill folder a SKILL.md path belongs to, or null.
 *
 * The path arrives in a webview message, so it is resolved against the skills
 * root rather than trusted: uninstalling by a path from the page would otherwise
 * be able to name any directory on disk.
 */
export function skillFolderFromPath(skillsRoot: string, skillFilePath: unknown): string | null {
  if (typeof skillFilePath !== 'string' || !skillFilePath || !skillsRoot) return null;
  const file = normalizePath(skillFilePath);
  const root = normalizePath(skillsRoot);
  if (!isInside(root, file)) return null;
  const rest = file.slice(root.length + 1).split('/');
  // Exactly `<folder>/<SKILL.md>`: a file directly in the root is not a skill.
  if (rest.length !== 2 || !rest[0]) return null;
  // `skills.ts` owns the canonical list, but it imports `vscode` and this module
  // is part of the browser bundle — so the comparison is case-insensitive here
  // and `test/settings-adapter.direct.mjs` asserts it still matches the real list.
  if (rest[1]!.toLowerCase() !== 'skill.md') return null;
  return rest[0]!;
}

/**
 * A starting SKILL.md.
 *
 * The frontmatter is what `parseSkillFrontmatter` reads, so a scaffold without it
 * would install a skill the list shows as unnamed. The name is slugged for the
 * same reason a skill name is slugged anywhere else: it becomes a folder.
 */
export function skillScaffold(name: unknown): string {
  const raw = typeof name === 'string' ? name.trim() : '';
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new-skill';
  return [
    '---',
    `name: ${slug}`,
    'description: Describe when the agent should use this skill.',
    '---',
    '',
    `# ${raw || 'New skill'}`,
    '',
    'Describe the task this skill covers, then the steps the agent should take.',
    'Keep it short enough to read in one pass: the agent loads this when a task matches.',
    '',
  ].join('\n');
}

/**
 * Resolve a file the panel asked to open.
 *
 * Only paths inside a root this extension controls are opened: the path comes
 * from a webview message, and "open whatever path the page names" is how a
 * settings page turns into an arbitrary-file reader.
 */
export function openableFile(rawPath: unknown, roots: readonly string[]): string | null {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  if (!rawPath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(rawPath)) return null;
  const allowed = roots.filter(root => typeof root === 'string' && root);
  if (!allowed.some(root => isInside(root, rawPath))) return null;
  return rawPath;
}

/**
 * Whether a delete request names the project memory file — and nothing else.
 *
 * SleepyCode's only "rule" is the project memory file. Deleting it is a real
 * action, but the message must not be able to name any other path.
 */
export function isProjectMemoryPath(candidate: unknown, memoryPath: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (typeof memoryPath !== 'string' || !memoryPath) return false;
  return normalizePath(candidate) === normalizePath(memoryPath);
}

/**
 * Turn a panel-supplied path into an absolute one inside the workspace.
 *
 * The Rules row carries `.sleepycode/memory.md` — relative, because that is how
 * the host stores it — so it must be joined onto the workspace root before any
 * containment check can mean anything. A relative path that climbs out of the
 * workspace resolves to null rather than to somewhere unexpected. An absolute
 * path is returned unchanged for `openableFile` to authorise.
 */
export function resolvePanelPath(rawPath: unknown, workspaceRoot: string | undefined): string | null {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  if (rawPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rawPath)) return rawPath;
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) return null;
  const joined = `${normalizePath(workspaceRoot)}/${rawPath.replace(/\\/g, '/')}`;
  const resolved = normalizePath(joined);
  return isInside(workspaceRoot, resolved) ? resolved : null;
}

/**
 * The OAuth status message, in the shape the window reads.
 *
 * The window does `setOauthStatus(msg.status)`, so posting the status flat left it
 * undefined — harmless while there are no accounts, and a crash the moment there
 * are. One builder so the sender cannot disagree with the reader.
 */
export function panelOAuthStatusMessage(): { type: 'oauthStatus'; status: { accounts: unknown[]; errors: Record<string, string> } } {
  return { type: 'oauthStatus', status: emptyOAuthStatus() };
}
