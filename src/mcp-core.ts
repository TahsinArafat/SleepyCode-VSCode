import { createHash } from 'node:crypto';

/**
 * Pure MCP configuration and naming helpers.
 * No `vscode` import: the strip-types test runner loads this module directly,
 * so the tests exercise the real code instead of a copy.
 */

export type HttpServer = { url: string; transport?: 'http' | 'sse'; headers?: Record<string, string> };
export type StdioServer = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
export type McpServer = HttpServer | StdioServer;

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
