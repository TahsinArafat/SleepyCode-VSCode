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
  if (status.state === 'error' && status.error) row.error = status.error;
  if (status.state === 'disabled') row.error = 'Disabled';
  return row;
}

/**
 * The `features` message the settings window reads its MCP page from. Only the
 * fields this panel uses are sent; the rest of `FeatureConfig` belongs to
 * OpenCursor features SleepyCode hides.
 */
export function toPanelFeatures(connections: readonly StoredMcpConnection[], statuses: readonly StoredMcpStatus[]): {
  mcpServers: PanelMcpConfig[];
  mcpStatus: PanelMcpStatus[];
} {
  return {
    mcpServers: (connections ?? []).map(toMcpPanelConfig),
    mcpStatus: (statuses ?? []).map(toMcpPanelStatus),
  };
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