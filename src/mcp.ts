import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { McpConnectionData, McpConnectionStatus, McpOAuthConfig, McpOAuthTokens } from './types';

import {
  connectServerDefinitions,
  deleteMcpConnectionFrom,
  expandEnvironment,
  loadMcpConnectionsFrom,
  saveMcpConnectionTo,
  isMcpAuthRequired,
  type McpConnection,
  type McpHost,
  type McpServer,
} from './mcp-core';

export { connectMcpServers, emptyMcpConnection, expandEnvironment, mcpOAuthLogin, parseMcpServers, restrictedEnv } from './mcp-core';
export type { HttpServer, McpConnection, McpServer, StdioServer } from './mcp-core';

const MCP_AUTH_SECRET_PREFIX = 'sleepycode.mcpAuth.';

/**
 * Adapt VS Code's secret storage and browser opener to the MCP client's host
 * interface. This is what makes OAuth possible at all: the ported provider keeps
 * tokens in secret storage and needs a way to open the authorization page.
 */
export function mcpHost(context: vscode.ExtensionContext): McpHost {
  return {
    secrets: {
      get: (key: string) => Promise.resolve(context.secrets.get(key)),
      store: (key: string, value: string) => Promise.resolve(context.secrets.store(key, value)),
      delete: (key: string) => Promise.resolve(context.secrets.delete(key)),
    },
    openExternal: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
    // Resolved lazily: spawning a shell costs ~100ms and only stdio servers
    // need it.
    get env() {
      return loginShellEnv();
    },
  };
}

let loginShellPath: Promise<Record<string, string>> | undefined;

/**
 * The PATH the user's shell actually has.
 *
 * A VS Code launched from the Dock (macOS) or a desktop launcher (Linux) does
 * not read the shell profile, so its PATH is the bare system one and `npx`,
 * `uvx`, `bunx` and nvm-installed binaries are invisible. Every stdio MCP server
 * then fails with "command not found" while working fine in a terminal.
 *
 * Resolved once per session from the user's own shell, and falls back to the
 * inherited PATH when that fails.
 */
export function loginShellEnv(): Promise<Record<string, string>> {
  if (loginShellPath) return loginShellPath;
  loginShellPath = (async () => {
    const fallback = { PATH: process.env.PATH ?? '' };
    const shell = process.env.SHELL || (process.platform === 'win32' ? '' : '/bin/zsh');
    if (!shell || process.platform === 'win32') return fallback;
    try {
      const { execFile } = await import('node:child_process');
      const output = await new Promise<string>((resolve, reject) => {
        execFile(shell, ['-ilc', 'printf %s "$PATH"'], { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      const path = output.trim();
      // A login shell may print profile noise; only trust a plausible PATH.
      return path.includes('/') ? { PATH: path } : fallback;
    } catch {
      return fallback;
    }
  })();
  return loginShellPath;
}

/** The subset of `ExtensionContext.globalState` the connection store needs. */
function connectionStore(context: vscode.ExtensionContext) {
  return {
    get: <T>(key: string, fallback: T) => context.globalState.get<T>(key, fallback),
    update: (key: string, value: unknown) => context.globalState.update(key, value),
  };
}

export async function loadMcpConnections(context: vscode.ExtensionContext): Promise<McpConnectionData[]> {
  // The round trip lives in mcp-core so it is directly testable; this is the
  // vscode-shaped adapter for it.
  return (await loadMcpConnectionsFrom(connectionStore(context))) as McpConnectionData[];
}

export async function saveMcpConnection(context: vscode.ExtensionContext, connection: McpConnectionData): Promise<void> {
  await saveMcpConnectionTo(connectionStore(context), connection as never);
}

export async function deleteMcpConnection(context: vscode.ExtensionContext, name: string): Promise<void> {
  await deleteMcpConnectionFrom(connectionStore(context), name);
  await context.secrets.delete(`${MCP_AUTH_SECRET_PREFIX}${name}`);
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
  workspaceRoot?: string,
): Promise<{ connection: McpConnection; statuses: McpConnectionStatus[] }> {
  const enabled = connections.filter((c) => c.enabled);
  // Resolve credentials here (they live in SecretStorage) and hand finished
  // definitions to the shared connection routine, so saved connections and the
  // legacy `mcpServers` JSON use exactly one transport path.
  const definitions: Record<string, McpServer> = {};
  const statuses: McpConnectionStatus[] = [];
  for (const connection of enabled) {
    try {
      const authHeaders = connection.auth?.type === 'oauth2'
        ? { Authorization: `Bearer ${await oauthAccessToken(connection, context)}` }
        : mcpAuthHeaders(connection);
      // stdio servers are launched, not fetched, so they take the command path
      // and never carry OAuth headers.
      definitions[connection.name] = connection.transport === 'stdio' || connection.command
        ? { command: connection.command ?? '', args: connection.args, env: connection.env }
        : {
          url: connection.url ?? '',
          transport: connection.transport === 'sse' ? 'sse' : 'http',
          headers: { ...connection.headers, ...expandEnvironment(connection.auth?.customHeaders), ...authHeaders },
          // Without this the client never builds an OAuth provider, so it can
          // never attach a bearer token and a protected server stays unusable.
          ...(connection.oauth ? { oauth: connection.oauth } : {}),
        };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statuses.push({ name: connection.name, state: isMcpAuthRequired(message) ? 'auth_required' : 'error', error: message });
    }
  }

  // stdio servers resolve `cwd` against this, so it cannot be empty.
  const connection = await connectServerDefinitions(definitions, workspaceRoot ?? '', approve, mcpHost(context));

  for (const [name, error] of connection.errors.map((entry) => {
    const index = entry.indexOf(': ');
    return [index < 0 ? entry : entry.slice(0, index), index < 0 ? '' : entry.slice(index + 2)] as const;
  })) {
    statuses.push({ name, state: isMcpAuthRequired(error) ? 'auth_required' : 'error', error });
  }
  const failures = new Set(statuses.map((status) => status.name));
  for (const name of Object.keys(definitions)) {
    if (failures.has(name)) continue;
    statuses.push({
      name,
      state: connection.authStates[name] === 'auth_required' ? 'auth_required' : 'ok',
      toolCount: connection.toolCounts[name] ?? 0,
      // Names, not just the count: the settings row lists them, and without
      // them a connected server renders "No tools exposed" beside "6 tools".
      tools: connection.toolNames[name] ?? [],
    });
  }
  for (const connectionData of connections.filter((c) => !c.enabled)) statuses.push({ name: connectionData.name, state: 'disabled' });
  return { connection, statuses };
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
