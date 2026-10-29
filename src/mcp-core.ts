import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { jsonSchema } from 'ai';
import { McpConnection as McpServerConnection, type McpHost } from './mcp-client.ts';

export type { McpHost } from './mcp-client.ts';

/**
 * Pure MCP configuration and naming helpers.
 * No `vscode` import: the strip-types test runner loads this module directly,
 * so the tests exercise the real code instead of a copy.
 */

export type HttpServer = { url: string; transport?: 'http' | 'sse'; headers?: Record<string, string> };
export type StdioServer = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
export type McpServer = HttpServer | StdioServer;

export type McpConnection = {
  tools: Record<string, any>;
  instructions: string[];
  errors: string[];
  /** Tool count per server name, so a "test connection" can report it. */
  toolCounts: Record<string, number>;
  /** Exposed tool names per server, listed in the settings row. */
  toolNames: Record<string, string[]>;
  /**
   * Per-server outcome, including servers that failed. `auth_required` means the
   * server wants a token and the settings window should offer Sign in; a plain
   * transport error must not be mistaken for it.
   */
  authStates: Record<string, McpServerState>;
  /** Resources exposed by a connected server (empty when it has none). */
  listResources(serverName: string): Promise<{ uri: string; name?: string; description?: string; mimeType?: string }[]>;
  /** Read one resource's text contents. */
  readResource(serverName: string, uri: string): Promise<string>;
  close(): Promise<void>;
};

/** Auth/transport state reported per server, used by the settings surface. */
export type McpServerState = 'ok' | 'auth_required' | 'error';


/** Most OpenAI-compatible providers reject tool names longer than this. */
export const MAX_TOOL_NAME_LENGTH = 64;

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

export function expandEnvironment(values?: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    value.replace(/\$\{env:([^}\r\n]+)\}/g, (_match, rawName: string) => env[rawName.trim()] ?? ''),
  ]));
}

const MINIMAL_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL',
  'ComSpec', 'SystemRoot', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
]);

export function restrictedEnv(server: HttpServer | StdioServer, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  const command = 'command' in server ? server.command : '';
  const args = 'args' in server ? (server.args ?? []) : [];
  const url = 'url' in server ? (server.url ?? '') : '';
  const headers = 'headers' in server ? (server.headers ?? {}) : {};
  const cwd = 'cwd' in server ? (server.cwd ?? '') : '';
  const serverEnv = 'env' in server ? (server.env ?? {}) : {};
  const allText = [
    command,
    ...args,
    ...(url ? [url] : []),
    ...Object.values(headers),
    cwd,
    ...Object.values(serverEnv),
  ].join('');
  const referencedVars = new Set<string>();
  for (const match of allText.matchAll(/\$\{env:([^}]+)\}/g)) {
    if (match && match[1]) referencedVars.add(match[1].trim());
  }
  for (const key of [...referencedVars, ...MINIMAL_ENV_KEYS]) {
    if (env[key] !== undefined) result[key] = env[key]!;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function safeName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'server';
}

/**
 * Providers cap tool names at 64 characters. Server and tool names routinely
 * overflow that, and an over-long name fails the whole request rather than
 * dropping one tool, so long names are truncated with a stable hash suffix.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const base = `mcp_${safeName(serverName)}_${safeName(toolName)}`;
  if (base.length <= MAX_TOOL_NAME_LENGTH) return base;
  const digest = createHash('sha1').update(base).digest('hex').slice(0, 8);
  return `${base.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${digest}`;
}

/** Keeps two servers exposing the same tool name from shadowing each other. */
export function uniqueToolName(desired: string, used: Set<string>): string {
  if (!used.has(desired)) return desired;
  for (let suffix = 2; suffix < 100; suffix++) {
    const tail = `_${suffix}`;
    const candidate = desired.slice(0, MAX_TOOL_NAME_LENGTH - tail.length) + tail;
    if (!used.has(candidate)) return candidate;
  }
  return desired;
}

export function isMcpAuthRequired(message: string): boolean {
  return /401|403|unauthori[sz]ed|authenticat|authorization required|oauth/i.test(message);
}

// Other tools wrap their config in `mcpServers` (Claude Desktop, Cursor, VS Code).
// Accepting both shapes means a pasted config works instead of failing on a
// top-level key named after the wrapper.
function unwrapServerMap(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['mcpServers', 'servers']) {
    const inner = record[key];
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
    const siblings = Object.entries(record).filter(([name]) => name !== key);
    const siblingIsServer = siblings.some(([, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const entry = value as Record<string, unknown>;
      return typeof entry.url === 'string' || typeof entry.command === 'string';
    });
    if (!siblingIsServer) return inner as Record<string, unknown>;
  }
  return record;
}

export function parseMcpServers(raw: string): Record<string, McpServer> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MCP server configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP server configuration must be a JSON object keyed by server name.');
  const result: Record<string, McpServer> = {};
  for (const [name, value] of Object.entries(unwrapServerMap(parsed as Record<string, unknown>))) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MCP server '${name}' must be an object.`);
    const item = value as Record<string, unknown>;
    const declaredType = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    if (typeof item.url === 'string' && item.url.trim()) {
      result[name] = {
        url: item.url.trim(),
        transport: (item.transport === 'sse' || declaredType === 'sse') ? 'sse' : 'http',
        headers: stringRecord(item.headers),
      };
    } else if (typeof item.command === 'string' && item.command.trim()) {
      result[name] = {
        command: item.command.trim(),
        args: Array.isArray(item.args) ? item.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
        env: stringRecord(item.env),
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
      };
    } else {
      throw new Error(`MCP server '${name}' needs either a "url" or a "command".`);
    }
  }
  return result;
}

/**
 * Connect to every configured MCP server and expose its tools to the agent.
 * Lives here (not `mcp.ts`) so the strip-types test runner can exercise a real
 * connection without a `vscode` shim.
 */
/**
 * Split a command line into argv, honouring quotes and backslash escapes.
 *
 * The settings window has separate Command and Arguments fields, but the
 * documented invocation for most servers is a single line
 * (`npx -y mcp-archiveorg`), so that is what users paste into Command. Passing
 * it to `spawn` unchanged looks for a binary literally named
 * "npx -y mcp-archiveorg" and fails with "command not found".
 *
 * Intentionally small: this is not a shell. No globbing, no variables, no
 * operators — just whitespace splitting with quotes, which is all a command
 * line in a settings field needs.
 *
 * Backslash is NOT an escape here. On POSIX it sometimes is, but on Windows it
 * is the path separator, and treating it as one silently rewrote
 * `C:\hostedtool\cache\windows\node.exe` into `C:hostedtoolcachewindowsnode.exe`
 * (that exact mangling showed up in CI). A literal backslash needs no help — it
 * survives this splitter untouched — and a space inside one argument is what
 * quotes are for.
 */
export function splitCommandLine(value: string | undefined): string[] {
  const input = (value ?? '').trim();
  if (!input) return [];
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) {
        parts.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) parts.push(current);
  return parts;
}

/** Turn one configured server definition into an `McpServerConfig` for the client. */
function toClientConfig(name: string, server: McpServer & { headers?: Record<string, string>; oauth?: { clientId?: string; scopes?: string[] } }): {
  config: { name: string; transport: 'stdio' | 'sse' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId?: string; scopes?: string[] }; enabled: boolean };
  cwd?: string;
} {
  if ('url' in server && server.url) {
    return {
      config: {
        name,
        transport: server.transport === 'sse' ? 'sse' : 'http',
        url: server.url,
        headers: server.headers,
        oauth: server.oauth,
        enabled: true,
      },
    };
  }
  const stdio = server as StdioServer;
  // A command field holding a whole invocation is split, but only when no
  // arguments were supplied separately — otherwise the user's explicit args are
  // authoritative and the command is expected to be a bare executable.
  const supplied = stdio.args ?? [];
  const split = supplied.length ? [stdio.command ?? '', ...supplied] : splitCommandLine(stdio.command);
  return {
    config: {
      name,
      transport: 'stdio',
      command: split[0] ?? stdio.command ?? '',
      args: split.slice(1),
      env: stdio.env,
      enabled: true,
    },
    cwd: stdio.cwd,
  };
}

/**
 * Connect a prepared set of server definitions and expose their tools.
 *
 * One routine serves both the legacy `mcpServers` JSON and the saved-connections
 * UI: credentials are resolved by the caller, transport and tool discovery
 * happen here. Callers that own credential lookup (OAuth, API keys) resolve
 * their headers first and hand the finished definitions over.
 */
export async function connectServerDefinitions(
  definitions: Record<string, McpServer & { headers?: Record<string, string>; oauth?: { clientId?: string; scopes?: string[] } }>,
  workspaceRoot: string,
  approve: (title: string, detail: string) => Promise<void>,
  host?: McpHost,
): Promise<McpConnection> {
  const connections = new Map<string, McpServerConnection>();
  const tools: Record<string, any> = {};
  const usedNames = new Set<string>();
  const instructions: string[] = [];
  const errors: string[] = [];
  const toolCounts: Record<string, number> = {};
  const toolNames: Record<string, string[]> = {};
  const authStates: Record<string, McpServerState> = {};

  for (const [serverName, server] of Object.entries(definitions)) {
    const { config, cwd } = toClientConfig(serverName, server);
    const root = cwd ? path.resolve(workspaceRoot, cwd) : workspaceRoot;
    // Host environment (the user's login-shell PATH) is merged into the server's
    // own env here, so the client only ever deals with one resolved map.
    if (host?.env) {
      const hostEnv = await Promise.resolve(host.env);
      config.env = { ...hostEnv, ...(config.env ?? {}) };
    }
    const connection = new McpServerConnection(config, root, host);
    try {
      await connection.connect();
      connections.set(serverName, connection);
      if (connection.tools.length === 0 && connection.lastError) throw new Error(connection.lastError);
      toolCounts[serverName] = connection.tools.length;
      toolNames[serverName] = connection.tools.map((tool) => tool.name);
      authStates[serverName] = 'ok';
      // Server-provided guidance goes into the system prompt, so it is scoped by
      // server name in the same way the tools are.
      if (connection.instructions?.trim()) instructions.push(`${serverName}: ${connection.instructions.trim()}`);
      for (const tool of connection.tools) {
        const exposedName = uniqueToolName(mcpToolName(serverName, tool.name), usedNames);
        const schema = tool.inputSchema ?? { type: 'object', properties: {} };
        tools[exposedName] = {
          description: `[MCP: ${serverName}] ${tool.description ?? tool.name}`,
          inputSchema: jsonSchema(schema as Record<string, unknown>),
          execute: async (input: unknown, options: { abortSignal?: AbortSignal } = {}) => {
            await approve(`Use ${serverName}: ${tool.name}?`, JSON.stringify(input ?? {}, null, 2));
            return connection.callTool(tool.name, input ?? {}, options.abortSignal);
          },
        };
      }
    } catch (error) {
      connection.dispose();
      const message = error instanceof Error ? error.message : String(error);
      // A server that needs interactive sign-in is not a failure to report as
      // "broken"; the settings surface turns this into a Sign in action. The
      // classification comes from the client's own auth state, because the
      // server's wording ("missing authorization header") does not match the
      // usual 401 phrasings.
      authStates[serverName] = connection.authState === 'required' ? 'auth_required' : 'error';
      errors.push(`${serverName}: ${message}`);
    }
  }

  return {
    tools,
    instructions,
    errors,
    toolCounts,
    toolNames,
    authStates,
    listResources: async (serverName: string) => {
      const connection = connections.get(serverName);
      if (!connection) return [];
      return connection.listResources();
    },
    readResource: async (serverName: string, uri: string) => {
      const connection = connections.get(serverName);
      if (!connection) return '';
      return connection.readResource(uri);
    },
    close: async () => {
      await Promise.allSettled([...connections.values()].map((connection) => {
        connection.dispose();
        return Promise.resolve();
      }));
    },
  };
}

/**
 * Connect to every configured MCP server and expose its tools to the agent.
 * Lives here (not `mcp.ts`) so the strip-types test runner can exercise a real
 * connection without a `vscode` shim.
 */
export async function connectMcpServers(
  raw: string,
  workspaceRoot: string,
  approve: (title: string, detail: string) => Promise<void>,
  host?: McpHost,
): Promise<McpConnection> {
  const definitions = parseMcpServers(raw);
  const resolved: Record<string, McpServer & { headers?: Record<string, string> }> = {};
  for (const [name, server] of Object.entries(definitions)) {
    resolved[name] = 'url' in server
      ? { ...server, headers: expandEnvironment(server.headers) }
      : { ...server, env: expandEnvironment(server.env) };
  }
  return connectServerDefinitions(resolved, workspaceRoot, approve, host);
}

/**
 * Run the interactive OAuth sign-in for one remote server.
 *
 * The ported provider owns the whole flow (PKCE, dynamic client registration,
 * loopback callback), and stores the resulting tokens in secret storage, so the
 * next connect picks them up and attaches the bearer token itself.
 */
export async function mcpOAuthLogin(
  server: { name: string; url?: string; transport?: 'stdio' | 'sse' | 'http'; oauth?: { clientId?: string; scopes?: string[] } },
  workspaceRoot: string,
  host: McpHost,
): Promise<void> {
  if (!server.url) throw new Error('OAuth applies to remote MCP servers.');
  const connection = new McpServerConnection(
    {
      name: server.name,
      transport: server.transport === 'sse' ? 'sse' : 'http',
      url: server.url,
      oauth: server.oauth,
      enabled: true,
    },
    workspaceRoot,
    host,
  );
  try {
    await connection.login();
  } finally {
    connection.dispose();
  }
}

/**
 * An MCP connection with nothing in it, for the timeout and failure paths.
 * Keeping one constructor means the placeholders cannot drift from the real
 * shape as capabilities are added.
 */
export function emptyMcpConnection(errors: string[] = []): McpConnection {
  return {
    tools: {},
    instructions: [],
    errors,
    toolCounts: {},
    toolNames: {},
    authStates: {},
    listResources: async () => [],
    readResource: async () => '',
    close: async () => {},
  };
}

// ---------------------------------------------------------------- persistence

/**
 * Storage the MCP connection list needs. `vscode.ExtensionContext.globalState`
 * satisfies this, and an in-memory object satisfies it in tests, so the
 * save/load round trip — the thing that decides whether a server the user just
 * added is still there on the next render — is directly testable.
 */
export interface McpKeyValueStore {
  get<T>(key: string, fallback: T): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const MCP_CONNECTIONS_KEY = 'sleepycode.mcpConnections';

export interface StoredMcpConnectionRecord {
  name: string;
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

/**
 * Read the saved connections, normalised.
 *
 * Each field is normalised rather than assumed: `globalState` can hold anything
 * a previous version wrote, and an entry with neither `url` nor `command` would
 * connect to nothing — so it is dropped instead of shown as a server that
 * silently does not work.
 */
export async function loadMcpConnectionsFrom(store: McpKeyValueStore): Promise<StoredMcpConnectionRecord[]> {
  const stored = store.get<unknown>(MCP_CONNECTIONS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((item): item is StoredMcpConnectionRecord => {
      if (!item || typeof item !== 'object') return false;
      const entry = item as StoredMcpConnectionRecord;
      if (typeof entry.name !== 'string' || !entry.name) return false;
      return Boolean((entry.url && entry.url.trim()) || (entry.command && entry.command.trim()));
    })
    .map((entry) => ({
      name: entry.name,
      description: entry.description ?? '',
      transport: entry.transport ?? (entry.command ? 'stdio' : 'http'),
      auth: entry.auth?.type ? entry.auth : { type: 'none' },
      enabled: entry.enabled !== false,
      order: entry.order ?? 0,
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.env ? { env: entry.env } : {}),
      ...(entry.headers ? { headers: entry.headers } : {}),
      ...(entry.oauth ? { oauth: entry.oauth } : {}),
    }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Insert or replace one connection by name, preserving order. */
export async function saveMcpConnectionTo(store: McpKeyValueStore, connection: StoredMcpConnectionRecord): Promise<void> {
  const existing = await loadMcpConnectionsFrom(store);
  const index = existing.findIndex((entry) => entry.name === connection.name);
  if (index >= 0) existing[index] = connection;
  else existing.push(connection);
  existing.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  await store.update(MCP_CONNECTIONS_KEY, existing);
}

/** Remove one connection by name. */
export async function deleteMcpConnectionFrom(store: McpKeyValueStore, name: string): Promise<void> {
  const existing = await loadMcpConnectionsFrom(store);
  await store.update(MCP_CONNECTIONS_KEY, existing.filter((entry) => entry.name !== name));
}
