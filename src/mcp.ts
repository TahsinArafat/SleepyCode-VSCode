import * as path from 'node:path';
import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { McpConnectionData, McpConnectionStatus, McpOAuthConfig, McpOAuthTokens } from './types';

type HttpServer = { url: string; transport?: 'http' | 'sse'; headers?: Record<string, string> };
type StdioServer = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
type McpServer = HttpServer | StdioServer;

export type McpConnection = {
  tools: Record<string, any>;
  instructions: string[];
  errors: string[];
  close(): Promise<void>;
};

function safeName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'server';
}

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

export function parseMcpServers(raw: string): Record<string, McpServer> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`MCP server configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP server configuration must be a JSON object keyed by server name.');
  const result: Record<string, McpServer> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MCP server '${name}' must be an object.`);
    const item = value as Record<string, unknown>;
    if (typeof item.url === 'string' && item.url.trim()) {
      result[name] = {
        url: item.url.trim(),
        transport: item.transport === 'sse' ? 'sse' : 'http',
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
      throw new Error(`MCP server '${name}' needs either a url or command.`);
    }
  }
  return result;
}

export async function connectMcpServers(
  raw: string,
  workspaceRoot: string,
  approve: (title: string, detail: string) => Promise<void>,
): Promise<McpConnection> {
  const definitions = parseMcpServers(raw);
  const clients: MCPClient[] = [];
  const tools: Record<string, any> = {};
  const instructions: string[] = [];
  const errors: string[] = [];
  for (const [serverName, server] of Object.entries(definitions)) {
    try {
      const client = 'url' in server
        ? await createMCPClient({ transport: { type: server.transport ?? 'http', url: server.url, headers: expandEnvironment(server.headers) } })
        : await createMCPClient({
          transport: new Experimental_StdioMCPTransport({
            command: server.command,
            args: server.args,
            env: server.env ? { ...restrictedEnv(server), ...expandEnvironment(server.env) } : restrictedEnv(server),
            cwd: server.cwd ? path.resolve(workspaceRoot, server.cwd) : workspaceRoot,
          }),
        });
      clients.push(client);
      if (client.instructions?.trim()) instructions.push(`${serverName}: ${client.instructions.trim()}`);
      const serverTools = await client.tools();
      for (const [toolName, definition] of Object.entries(serverTools)) {
        const exposedName = `mcp_${safeName(serverName)}_${safeName(toolName)}`;
        const original = definition as any;
        tools[exposedName] = {
          ...original,
          description: `[MCP: ${serverName}] ${original.description ?? toolName}`,
          execute: async (input: unknown, options: unknown) => {
            await approve(`Use ${serverName}: ${toolName}?`, JSON.stringify(input ?? {}, null, 2));
            if (typeof original.execute !== 'function') throw new Error(`MCP tool '${toolName}' is not executable.`);
            return original.execute(input, options);
          },
        };
      }
    } catch (error) {
      errors.push(`${serverName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    tools,
    instructions,
    errors,
    close: async () => { await Promise.allSettled(clients.map(client => client.close())); },
  };
}

const MCP_CONNECTIONS_KEY = 'sleepycode.mcpConnections';

export async function loadMcpConnections(context: vscode.ExtensionContext): Promise<McpConnectionData[]> {
  const stored = context.globalState.get<unknown[]>(MCP_CONNECTIONS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((item): item is McpConnectionData => Boolean(item) && typeof item === 'object' && typeof (item as McpConnectionData).name === 'string' && typeof (item as McpConnectionData).url === 'string')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function saveMcpConnection(context: vscode.ExtensionContext, connection: McpConnectionData): Promise<void> {
  const existing = await loadMcpConnections(context);
  const index = existing.findIndex((c) => c.name === connection.name);
  if (index >= 0) existing[index] = connection;
  else existing.push(connection);
  existing.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  await context.globalState.update(MCP_CONNECTIONS_KEY, existing);
}

export async function deleteMcpConnection(context: vscode.ExtensionContext, name: string): Promise<void> {
  const existing = await loadMcpConnections(context);
  await context.globalState.update(MCP_CONNECTIONS_KEY, existing.filter((c) => c.name !== name));
  await context.secrets.delete(`sleepycode.mcpAuth.${name}`);
  await context.secrets.delete(oauthTokenKey(name));
}

/** Build request headers for a connection's configured auth method. */
export function mcpAuthHeaders(connection: McpConnectionData): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = connection.auth ?? { type: 'none' as const };
  if (auth.type === 'bearer' && auth.token) headers.Authorization = `Bearer ${auth.token}`;
  else if (auth.type === 'basic') headers.Authorization = `Basic ${Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64')}`;
  else if (auth.type === 'api-key' && auth.apiKey) headers['X-API-Key'] = auth.apiKey;
  else if (auth.type === 'custom' && auth.customHeaders) Object.assign(headers, auth.customHeaders);
  return headers;
}

/** Connect to enabled saved connections, surfacing per-connection status. */
export async function connectToMcpConnections(
  connections: McpConnectionData[],
  context: vscode.ExtensionContext,
  approve: (title: string, detail: string) => Promise<void>,
): Promise<{ connection: McpConnection; statuses: McpConnectionStatus[] }> {
  const enabled = connections.filter((c) => c.enabled);
  const clients: MCPClient[] = [];
  const tools: Record<string, any> = {};
  const instructions: string[] = [];
  const errors: string[] = [];
  const statuses: McpConnectionStatus[] = [];
  for (const connection of enabled) {
    try {
      const authHeaders = connection.auth?.type === 'oauth2'
        ? { Authorization: `Bearer ${await oauthAccessToken(connection, context)}` }
        : mcpAuthHeaders(connection);
      const headers = { ...expandEnvironment(connection.auth?.customHeaders), ...authHeaders };
      const client = await createMCPClient({ transport: { type: connection.transport ?? 'http', url: connection.url, headers } });
      clients.push(client);
      if (client.instructions?.trim()) instructions.push(`${connection.name}: ${client.instructions.trim()}`);
      const serverTools = await client.tools();
      let toolCount = 0;
      for (const [toolName, definition] of Object.entries(serverTools)) {
        const exposedName = `mcp_${safeName(connection.name)}_${safeName(toolName)}`;
        const original = definition as any;
        tools[exposedName] = {
          ...original,
          description: `[MCP: ${connection.name}] ${original.description ?? toolName}`,
          execute: async (input: unknown, options: unknown) => {
            await approve(`Use ${connection.name}: ${toolName}?`, JSON.stringify(input ?? {}, null, 2));
            if (typeof original.execute !== 'function') throw new Error(`MCP tool '${toolName}' is not executable.`);
            return original.execute(input, options);
          },
        };
        toolCount++;
      }
      statuses.push({ name: connection.name, state: 'ok', toolCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${connection.name}: ${message}`);
      const authRequired = /401|403|unauthor|authenticat/i.test(message);
      statuses.push({ name: connection.name, state: authRequired ? 'auth_required' : 'error', error: message });
    }
  }
  for (const connection of connections.filter((c) => !c.enabled)) statuses.push({ name: connection.name, state: 'disabled' });
  return {
    connection: {
      tools,
      instructions,
      errors,
      close: async () => { await Promise.allSettled(clients.map(client => client.close())); },
    },
    statuses,
  };
}

const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';
const OAUTH_PROTOCOL_VERSION = '2024-11-05';

export function oauthTokenKey(name: string): string {
  return `sleepycode.mcpOAuth.tokens.${name}`;
}

export function oauthPendingKey(state: string): string {
  return `sleepycode.mcpOAuth.pending.${state}`;
}

type PendingOAuth = {
  name: string;
  oauth: McpOAuthConfig;
  verifier: string;
  redirectUrl: string;
  resource: string;
};

type AuthServerMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
};

function b64url(value: Buffer): string {
  return value.toString('base64url');
}

/** Applies client credentials the way the authorization server expects them (RFC 6749 §2.3). */
function oauthTokenRequest(
  oauth: McpOAuthConfig,
  body: URLSearchParams,
): { headers: Record<string, string>; body: URLSearchParams } {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (oauth.clientSecret && oauth.tokenAuthMethod !== 'client_secret_post') {
    headers.Authorization = `Basic ${Buffer.from(`${oauth.clientId ?? ''}:${oauth.clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', oauth.clientId ?? '');
    if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret);
  }
  return { headers, body };
}

/** Probe an MCP endpoint so a 401/403 can hand us the `www-authenticate` challenge describing its auth server. */
export async function probeForAuthChallenge(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: OAUTH_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'sleepycode', version: '0.0.0' },
        },
      }),
    });
    if (response.status === 401 || response.status === 403) return response.headers.get('www-authenticate') ?? '';
  } catch {}
  return undefined;
}

function resourceMetadataUrlFromChallenge(wwwAuthenticate: string | undefined, serverUrl: string): string {
  const match = wwwAuthenticate ? /resource_metadata\s*=\s*"?([^",]+)"?/i.exec(wwwAuthenticate) : null;
  if (match && match[1]) return match[1];
  return `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return undefined;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function discoverAuthorizationServers(serverUrl: string, wwwAuthenticate?: string): Promise<string[]> {
  const metadata = await fetchJson(resourceMetadataUrlFromChallenge(wwwAuthenticate, serverUrl));
  const servers = metadata && Array.isArray(metadata.authorization_servers)
    ? metadata.authorization_servers.filter((server): server is string => typeof server === 'string')
    : [];
  return servers.length ? servers : [new URL(serverUrl).origin];
}

export async function discoverAuthServerMetadata(issuer: string): Promise<AuthServerMetadata | undefined> {
  const base = issuer.replace(/\/+$/, '');
  for (const url of [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ]) {
    const metadata = await fetchJson(url);
    if (metadata && typeof metadata.authorization_endpoint === 'string' && typeof metadata.token_endpoint === 'string') {
      return {
        authorization_endpoint: metadata.authorization_endpoint,
        token_endpoint: metadata.token_endpoint,
        registration_endpoint: typeof metadata.registration_endpoint === 'string' ? metadata.registration_endpoint : undefined,
        scopes_supported: Array.isArray(metadata.scopes_supported)
          ? metadata.scopes_supported.filter((scope): scope is string => typeof scope === 'string')
          : undefined,
      };
    }
  }
  return undefined;
}

export async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<{ clientId: string; clientSecret?: string } | undefined> {
  try {
    const response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!payload || typeof payload.client_id !== 'string') return undefined;
    return {
      clientId: payload.client_id,
      clientSecret: typeof payload.client_secret === 'string' ? payload.client_secret : undefined,
    };
  } catch {
    return undefined;
  }
}

/** VS Code routes the OAuth callback back through its own URI handler, so the redirect must be a VS Code URI. */
export async function resolveRedirectUri(context: vscode.ExtensionContext): Promise<string> {
  const local = vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}${OAUTH_CALLBACK_PATH}`);
  return (await vscode.env.asExternalUri(local)).toString(true);
}

export async function discoverMcpOAuth(
  serverUrl: string,
  redirectUri: string,
  wwwAuthenticate?: string,
): Promise<McpOAuthConfig | undefined> {
  const challenge = wwwAuthenticate ?? (await probeForAuthChallenge(serverUrl));
  const issuers = await discoverAuthorizationServers(serverUrl, challenge);
  for (const issuer of issuers) {
    const metadata = await discoverAuthServerMetadata(issuer);
    if (!metadata) continue;
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    if (metadata.registration_endpoint) {
      const registered = await registerDynamicClient(metadata.registration_endpoint, redirectUri, 'SleepyCode (VS Code)');
      if (registered) {
        clientId = registered.clientId;
        clientSecret = registered.clientSecret;
      }
    }
    if (!clientId) continue;
    return {
      authUrl: metadata.authorization_endpoint,
      tokenUrl: metadata.token_endpoint,
      clientId,
      clientSecret,
      tokenAuthMethod: clientSecret ? 'client_secret_basic' : 'client_secret_post',
      scope: metadata.scopes_supported?.join(' '),
      resource: serverUrl,
    };
  }
  return undefined;
}

export function pkceChallenge(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function beginMcpOAuth(
  connection: Pick<McpConnectionData, 'name' | 'auth'>,
  context: vscode.ExtensionContext,
  redirectUri?: string,
): Promise<string> {
  const oauth = connection.auth?.oauth2Config;
  if (!oauth?.authUrl || !oauth.tokenUrl || !oauth.clientId) {
    throw new Error('OAuth requires an authorization URL, token URL, and client ID.');
  }
  const callback = redirectUri?.trim() ? redirectUri.trim() : await resolveRedirectUri(context);
  const state = b64url(randomBytes(24));
  const { verifier, challenge } = pkceChallenge();
  const authorizationUrl = new URL(oauth.authUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', oauth.clientId);
  authorizationUrl.searchParams.set('redirect_uri', callback);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('state', state);
  if (oauth.scope) authorizationUrl.searchParams.set('scope', oauth.scope);
  if (oauth.resource) authorizationUrl.searchParams.set('resource', oauth.resource);
  oauth.redirectUri = callback;
  await context.globalState.update(oauthPendingKey(state), {
    name: connection.name,
    oauth,
    verifier,
    redirectUrl: callback,
    resource: oauth.resource ?? '',
  } satisfies PendingOAuth);
  const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl.toString()));
  if (!opened) throw new Error('VS Code could not open your browser for OAuth authorization.');
  return state;
}

/** Completes the flow from the `onUri` callback; returns the connection name the tokens belong to. */
export async function finishMcpOAuth(uri: vscode.Uri, context: vscode.ExtensionContext): Promise<string> {
  const callbackPath = uri.path.replace(/\/+$/, '');
  if (!callbackPath.endsWith(OAUTH_CALLBACK_PATH)) {
    throw new Error(`OAuth callback path must end with ${OAUTH_CALLBACK_PATH}.`);
  }
  const params = new URLSearchParams(uri.query);
  const state = params.get('state');
  const code = params.get('code');
  if (!state) throw new Error('OAuth callback is missing state.');
  const pending = context.globalState.get<PendingOAuth>(oauthPendingKey(state));
  await context.globalState.update(oauthPendingKey(state), undefined);
  if (!pending) {
    throw new Error('This OAuth request has expired or was started by another VS Code window.');
  }
  if (params.get('error')) {
    throw new Error(params.get('error_description') || `Authorization failed: ${params.get('error')}`);
  }
  if (!code) throw new Error('OAuth callback is missing an authorization code.');
  if (!pending.oauth.clientId) throw new Error('OAuth request is missing its client ID. Start the connection again.');
  const tokenParams: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUrl,
    code_verifier: pending.verifier,
  };
  if (pending.resource) tokenParams.resource = pending.resource;
  const request = oauthTokenRequest(pending.oauth, new URLSearchParams(tokenParams));
  const response = await fetch(pending.oauth.tokenUrl, { method: 'POST', headers: request.headers, body: request.body });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== 'string') {
    throw new Error(typeof payload.error_description === 'string' ? payload.error_description : `Token exchange failed (HTTP ${response.status}).`);
  }
  const tokens: McpOAuthTokens = {
    access_token: payload.access_token,
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
    expires_at: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined,
  };
  await context.secrets.store(oauthTokenKey(pending.name), JSON.stringify(tokens));
  return pending.name;
}

/** Returns a usable access token, transparently refreshing it shortly before expiry. */
export async function oauthAccessToken(connection: McpConnectionData, context: vscode.ExtensionContext): Promise<string> {
  const raw = await context.secrets.get(oauthTokenKey(connection.name));
  if (!raw) throw new Error('OAuth authorization required. Open Settings, edit this MCP server, and choose Connect OAuth.');
  const tokens = JSON.parse(raw) as McpOAuthTokens;
  if (!tokens.access_token) throw new Error('Saved OAuth token is invalid. Reconnect this MCP server in Settings.');
  if (!tokens.expires_at || tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  const oauth = connection.auth?.oauth2Config;
  if (!tokens.refresh_token || !oauth?.tokenUrl || !oauth.clientId) {
    throw new Error('OAuth token expired. Reconnect this MCP server in Settings.');
  }
  const refreshParams: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  };
  if (oauth.resource) refreshParams.resource = oauth.resource;
  const request = oauthTokenRequest(oauth, new URLSearchParams(refreshParams));
  const response = await fetch(oauth.tokenUrl, { method: 'POST', headers: request.headers, body: request.body });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== 'string') {
    throw new Error('OAuth token refresh failed. Reconnect this MCP server in Settings.');
  }
  const refreshed: McpOAuthTokens = {
    ...tokens,
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : tokens.refresh_token,
    expires_at: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined,
  };
  await context.secrets.store(oauthTokenKey(connection.name), JSON.stringify(refreshed));
  return refreshed.access_token;
}
