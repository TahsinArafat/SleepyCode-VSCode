/**
 * Bridge between SleepyCode's stored configuration and the OpenCursor settings
 * window.
 *
 * The settings window is OpenCursor's React UI, so it speaks OpenCursor's
 * shapes (`McpServerConfig`, `McpStatus`, its own `Settings`). SleepyCode owns
 * the storage. Everything here is a pure mapping so it can be tested without an
 * extension host, and so no panel code has to know both vocabularies.
 *
 * Note the MCP config shape is deliberately OpenCursor's rather than
 * SleepyCode's older `{ url, transport, auth }`: OpenCursor's supports stdio
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
 * OpenCursor features SleepyCode hides.
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

/** One model's row in the panel, matching OpenCursor's `ModelUsage`. */
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
 * (local runtimes, docs indexing, semantic index) belongs to OpenCursor
 * features this build hides, and answering them with invented data would be
 * worse than ignoring them.
 */
const SUPPORTED_PANEL_MESSAGES = new Set<string>([
  'getSettings',
  'saveSettings',
  'getFeatures',
  'saveFeatures',
  'getUsage',
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
  'fetchAllModels',
  'openVsCodeSettings',
  'openEditorSettings',
  'openKeyboardShortcuts',
  'openExternal',
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
