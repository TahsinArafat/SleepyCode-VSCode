/*
 * MCP connection transport.
 *
 * Ported from OpenCursor (`src/integrations/mcpClient.ts`, MIT, © Pawan Osman).
 * Chosen over SleepyCode's previous `@ai-sdk/mcp`-based client because it is
 * materially more robust:
 *
 *   - remote servers go through the official `@modelcontextprotocol/sdk`
 *     (Streamable HTTP + legacy SSE, OAuth, reconnect);
 *   - stdio runs a real JSON-RPC bridge with per-request timeouts, abort
 *     support and a captured stderr tail, so a server that dies reports *why*
 *     instead of "server closed";
 *   - `tools/list` pagination is followed with loop detection;
 *   - `notifications/tools/list_changed` refreshes the catalog;
 *   - resources (`resources/list`, `resources/templates/list`, `resources/read`)
 *     are supported, which SleepyCode had no way to reach;
 *   - Windows `.cmd` launchers (npx/npm/pnpm) are run through a shell, which is
 *     the usual cause of ENOENT on that platform.
 *
 * Adapted for SleepyCode: no `vscode` import (the workspace root and host
 * callbacks are injected), so this module stays directly testable.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  CallToolResultSchema,
  ReadResourceResultSchema,
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ElicitRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
  type ElicitRequest,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { McpOAuthProvider, McpAuthRequiredError, validateMcpRemoteUrl, type McpSecretStorage } from './mcp-oauth.ts';

export type McpToolResult = CallToolResult;
export type McpAuthState = 'none' | 'required' | 'authorizing' | 'authenticated';

/** Host services the connection needs. Injected so this module stays vscode-free. */
export interface McpHost {
  secrets: McpSecretStorage;
  openExternal(url: string): PromiseLike<unknown>;
  /**
   * Extra environment for spawned stdio servers, merged under the server's own
   * `env`. Needed on macOS: a VS Code launched from the Dock inherits a minimal
   * PATH, so `npx`/`uvx` in /opt/homebrew/bin or an nvm dir are invisible and
   * every stdio server fails to start.
   */
  env?: Record<string, string> | Promise<Record<string, string>>;
  elicit?(server: string, request: ElicitRequest['params'], signal: AbortSignal): Promise<ElicitResult>;
  notification?(server: string, method: string, params: unknown): void;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Text compatibility keeps binary payloads out of token-sized JSON strings. */
export function formatMcpToolResult(result: McpToolResult): string {
  const blocks = result.content.map((content) => {
    if (content.type === 'text') return content.text;
    if (content.type === 'image' || content.type === 'audio') {
      return `[${content.type} ${content.mimeType}; ${Math.floor((content.data.length * 3) / 4)} bytes]`;
    }
    if (content.type === 'resource') {
      return 'text' in content.resource
        ? content.resource.text
        : `[binary resource ${content.resource.uri}; ${content.resource.mimeType ?? 'unknown MIME type'}]`;
    }
    return JSON.stringify(content);
  });
  if (result.structuredContent !== undefined) blocks.push(JSON.stringify(result.structuredContent));
  return `${result.isError ? 'error: ' : ''}${blocks.join('\n')}`;
}

export interface McpServerConfig {
  name: string;
  /** "stdio" launches a command; "sse"/"http" connects to a URL. */
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: { clientId?: string; scopes?: string[] };
  enabled: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: object;
  outputSchema?: object;
  annotations?: Record<string, unknown>;
}

/**
 * Explain a failed spawn in terms the user can act on. `ENOENT` almost always
 * means the command is not on the PATH this process inherited, which is the
 * usual situation for a GUI-launched editor.
 */
export function describeSpawnFailure(command: string, error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return `${command}: command not found. Install it, or make sure it is on the PATH your editor inherits (a VS Code launched from the Dock does not read your shell profile).`;
  }
  if (code === 'EACCES') return `${command}: not executable. Check its file permissions.`;
  return `${command}: ${error.message}`;
}

/**
 * Windows shells resolve commands themselves, so a missing binary never
 * surfaces as `ENOENT`: cmd.exe starts, reports "not recognized" on stderr and
 * exits 1, which the exit handler would report as `exited (code 1)` — naming
 * the cause only in the shell's own language. Folding the standard wordings
 * into the not-found explanation gives the row the same actionable message on
 * every platform.
 */
const WINDOWS_NOT_FOUND = /(is not recognized as an internal or external command|operable program or batch file|is not recognized as the name of a cmdlet|command not found)/i;

/** The user-facing reason a stdio server never came up, from its exit. */
export function describeServerExit(command: string, code: number, stderrTail: string): string {
  const tail = stderrTail.trim().split('\n').pop() ?? '';
  if (WINDOWS_NOT_FOUND.test(tail)) {
    return `${command}: command not found. The shell reported: ${tail}`;
  }
  return `${command} exited (code ${code})${tail ? `: ${tail}` : ''}`;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
  method?: string;
  params?: any;
}

/** MCP stdio bridge and SDK-backed Streamable HTTP / legacy SSE connections. */
export class McpConnection {
  private client?: Client;
  private remote?: StreamableHTTPClientTransport | SSEClientTransport;
  private oauth?: McpOAuthProvider;
  private disposed = false;
  private refresh?: Promise<void>;
  /** In-flight reconnect, so a burst of failed calls reconnects once. */
  private reconnect?: Promise<boolean>;
  /** Set by close()/logout(): this connection is finished, not merely broken. */
  private closeRequested = false;
  private serverRequests = new Map<number | string, AbortController>();
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buf = '';
  public tools: McpToolDef[] = [];
  /** Guidance the server returned during `initialize`, used in the system prompt. */
  public instructions?: string;
  public connected = false;
  public lastError?: string;
  public authState: McpAuthState = 'none';

  // Fields are declared and assigned explicitly: Node's strip-only TypeScript
  // loader cannot parse parameter properties, and this module is loaded
  // directly by the strip-types test runner.
  public readonly config: McpServerConfig;
  private readonly workspaceRoot: string;
  private readonly host?: McpHost;

  constructor(config: McpServerConfig, workspaceRoot: string, host?: McpHost) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
    this.host = host;
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    this.disposed = false;
    this.closeRequested = false;
    if (this.config.transport !== 'stdio') {
      await this.connectRemote(timeoutMs);
      return;
    }
    if (!this.config.command) throw new Error('stdio MCP server requires a command');

    // On Windows, npm-shipped launchers (npx/npm/pnpm/yarn) are .cmd shims that
    // are not directly spawnable, so run through a shell. The shell also resolves
    // commands via PATHEXT instead of failing with ENOENT.
    // Node deprecated args+shell:true (DEP0190), so pre-join into one quoted string.
    const useShell = process.platform === 'win32';
    const args = this.config.args ?? [];
    const cmd = useShell
      ? [this.config.command, ...args].map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ')
      : this.config.command;
    const proc = spawn(cmd, useShell ? [] : args, {
      cwd: this.workspaceRoot,
      env: { ...process.env, ...(this.config.env ?? {}) },
      shell: useShell,
    });
    this.proc = proc;

    // Wait for the spawn to succeed or fail before writing anything. Writing
    // `initialize` into a process that never started produces "write EPIPE",
    // which says nothing about the cause and hid "command not found".
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        proc.off('spawn', onSpawn);
        proc.off('error', onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(describeSpawnFailure(this.config.command ?? cmd, error)));
      };
      proc.once('spawn', onSpawn);
      proc.once('error', onError);
    });
    // Every handler below belongs to THIS process. A reconnected server inherits
    // `this`, and a late event from the previous, dead child used to reject the
    // new child's in-flight handshake — so a retry after a crash always failed
    // with the old process's exit reason.
    const isCurrent = (): boolean => this.proc === proc;
    proc.stdin.on('error', (error) => {
      this.lastError = error.message;
      if (!isCurrent()) return;
      for (const { reject } of this.pending.values()) reject(error);
    });

    // Keep the last stderr lines so a startup failure surfaces a real reason
    // instead of just "MCP server closed".
    let stderrTail = '';
    proc.stdout.on('data', (d) => {
      if (isCurrent()) this._onData(d.toString());
    });
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    proc.on('error', (e) => {
      if (!isCurrent()) return;
      this.lastError = e.message;
      this.connected = false;
    });
    proc.on('close', (code) => {
      if (!isCurrent()) return;
      this.connected = false;
      if (code) {
        this.lastError = describeServerExit(this.config.command ?? '', code, stderrTail);
      }
      const reason = this.lastError || 'MCP server closed';
      for (const { reject } of this.pending.values()) reject(new Error(reason));
      this.pending.clear();
    });

    // The handshake goes straight to this process's pipe. Routing it through
    // `_request` made a server that fails to start reconnect from inside its own
    // connect(), which respawned it before the caller ever saw the reason.
    const initialized = await this._requestRaw(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: this.host?.elicit ? { elicitation: { form: {}, url: {} } } : {},
        clientInfo: { name: 'sleepycode', version: '1.0.0' },
      },
      undefined,
      timeoutMs,
    );
    if (typeof initialized?.instructions === 'string') this.instructions = initialized.instructions;
    this._notify('notifications/initialized', {});

    await this.refreshTools(timeoutMs);
    this.connected = true;
  }

  private authProvider(): McpOAuthProvider | undefined {
    if (!this.oauth && this.host && this.config.url) {
      this.oauth = new McpOAuthProvider(
        this.config.url,
        this.config.name,
        this.host.secrets,
        (url) => this.host!.openExternal(url),
        this.config.oauth,
      );
    }
    return this.oauth;
  }

  private async connectRemote(timeoutMs: number): Promise<void> {
    if (!this.config.url) throw new Error('Remote MCP requires a server URL.');
    const url = validateMcpRemoteUrl(this.config.url);
    const authProvider = this.authProvider();
    const configuredHeaders = this.config.headers ?? {};
    const scopedFetch: typeof fetch = (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      if (target.origin === url.origin) {
        for (const [name, value] of Object.entries(configuredHeaders)) if (!headers.has(name)) headers.set(name, value);
      }
      // Do not forward arbitrary configured secret headers through HTTP redirects.
      return fetch(input, { ...init, headers, redirect: 'error' });
    };
    const client = new Client(
      { name: 'sleepycode', version: '0.8.3' },
      { capabilities: this.host?.elicit ? { elicitation: { form: {}, url: {} } } : {} },
    );
    client.onerror = (error) => {
      this.lastError = error.message;
    };
    client.onclose = () => {
      if (this.client === client) this.connected = false;
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools().catch((error) => {
        this.lastError = String(error);
      });
      this.host?.notification?.(this.config.name, 'notifications/tools/list_changed', {});
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, (event) => {
      this.host?.notification?.(this.config.name, event.method, event.params);
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (event) => {
      this.host?.notification?.(this.config.name, event.method, event.params);
    });
    if (this.host?.elicit) {
      client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
        this.host!.elicit!(this.config.name, request.params, extra.signal),
      );
    }
    const transport = this.config.transport === 'sse'
      ? new SSEClientTransport(url, { authProvider, fetch: scopedFetch })
      : new StreamableHTTPClientTransport(url, {
        authProvider,
        fetch: scopedFetch,
        reconnectionOptions: {
          initialReconnectionDelay: 500,
          maxReconnectionDelay: 5000,
          reconnectionDelayGrowFactor: 2,
          maxRetries: 3,
        },
      });
    this.client = client;
    this.remote = transport;
    try {
      // Marked connected BEFORE discovery: a remote transport has no pipe to
      // inspect, so `refreshTools` asking through `_requestRaw` must not be
      // treated as a dead connection.
      await client.connect(transport, { timeout: timeoutMs });
      if (this.disposed) {
        await client.close();
        throw new Error('MCP connection was disposed during initialization.');
      }
      const serverInstructions = client.getInstructions?.();
      if (typeof serverInstructions === 'string') this.instructions = serverInstructions;
      this.connected = true;
      if (client.getServerCapabilities()?.tools) await this.refreshTools(timeoutMs);
      else this.tools = [];
      this.connected = true;
      this.lastError = undefined;
      this.authState = (await authProvider?.tokens()) ? 'authenticated' : 'none';
    } catch (error) {
      this.connected = false;
      if (
        error instanceof UnauthorizedError ||
        error instanceof McpAuthRequiredError ||
        (error as { code?: number })?.code === 401
      ) {
        this.authState = this.authState === 'authorizing' ? 'authorizing' : 'required';
      }
      throw error;
    }
  }

  private async refreshTools(timeoutMs = 15_000): Promise<void> {
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      const tools: McpToolDef[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        // A stdio catalog refresh goes straight to the pipe: it is part of
        // connecting (or of a `list_changed` note), and reconnecting from here
        // would recurse into connect(). `_request` handles the reconnecting case
        // for tool CALLS. A remote refresh must go through `remoteRequest`,
        // which is where the SDK's own transport lives.
        const result = this.config.transport === 'stdio'
          ? await this._requestRaw('tools/list', cursor ? { cursor } : {}, undefined, timeoutMs)
          : await this._request('tools/list', cursor ? { cursor } : {}, undefined, timeoutMs);
        for (const tool of result?.tools ?? []) {
          if (typeof tool.name === 'string' && !tools.some((existing) => existing.name === tool.name)) {
            tools.push({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              annotations: tool.annotations,
            });
          }
        }
        cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
        // A server that repeats a cursor would loop forever.
        if (cursor && seen.has(cursor)) throw new Error('MCP tools pagination repeated a cursor.');
        if (cursor) seen.add(cursor);
        if (seen.size > 100 || tools.length > 10_000) throw new Error('MCP tool catalog exceeds the supported limit.');
      } while (cursor);
      this.tools = tools;
    })();
    try {
      await this.refresh;
    } finally {
      this.refresh = undefined;
    }
  }

  async login(): Promise<void> {
    if (this.config.transport === 'stdio') throw new Error('OAuth applies to remote MCP servers.');
    const provider = this.authProvider();
    if (!provider) throw new Error('MCP authentication host has not been initialized.');
    this.disposed = false;
    this.authState = 'authorizing';
    try {
      await provider.beginAuthorization();
      await this.client?.close();
      try {
        await this.connectRemote(15_000);
      } catch (error) {
        if (!provider.authorizationUrl || !this.remote) throw error;
        const code = await provider.waitForCode();
        await this.remote.finishAuth(code);
        await this.client?.close();
        await this.connectRemote(15_000);
      }
      this.authState = (await provider.tokens()) ? 'authenticated' : 'none';
      this.lastError = undefined;
    } catch (error) {
      this.authState = 'required';
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      provider.endAuthorization();
    }
  }

  async logout(): Promise<void> {
    await this.authProvider()?.invalidateCredentials('all');
    this.dispose();
    this.authState = 'required';
  }

  async callTool(name: string, args: any, signal?: AbortSignal): Promise<string> {
    return formatMcpToolResult(await this.callToolDetailed(name, args, signal));
  }

  async callToolDetailed(name: string, args: any, signal?: AbortSignal): Promise<McpToolResult> {
    const res = await this._request('tools/call', { name, arguments: args ?? {} }, signal);
    return CallToolResultSchema.parse(res);
  }

  /** List resources exposed by this server (resources/list). */
  async listResources(signal?: AbortSignal): Promise<{ uri: string; name?: string; description?: string; mimeType?: string }[]> {
    const resources = await this.paginate('resources/list', 'resources', signal);
    return resources.map((r: any) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplate[]> {
    return this.paginate('resources/templates/list', 'resourceTemplates', signal);
  }

  private async paginate(method: string, key: string, signal?: AbortSignal): Promise<any[]> {
    const values: any[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this._request(method, cursor ? { cursor } : {}, signal);
      if (Array.isArray(result?.[key])) values.push(...result[key]);
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error(`MCP ${method} repeated a pagination cursor.`);
      if (cursor) seen.add(cursor);
      if (seen.size > 100 || values.length > 10_000) throw new Error(`MCP ${method} exceeds the supported limit.`);
    } while (cursor);
    return values;
  }

  /** Read a resource (resources/read); returns its text contents joined. */
  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    const res = await this.readResourceContents(uri, signal);
    const contents = res?.contents;
    if (Array.isArray(contents)) {
      return contents
        .map((c: any) => (typeof c.text === 'string' ? c.text : c.blob !== undefined ? `[binary ${c.mimeType ?? ''}]` : JSON.stringify(c)))
        .join('\n');
    }
    return JSON.stringify(res ?? {});
  }

  async readResourceContents(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    return ReadResourceResultSchema.parse(await this._request('resources/read', { uri }, signal));
  }

  dispose(): void {
    this.disposed = true;
    this.closeRequested = true;
    this.oauth?.endAuthorization();
    for (const controller of this.serverRequests.values()) controller.abort();
    this.serverRequests.clear();
    void this.client?.close().catch(() => {});
    for (const { reject } of this.pending.values()) reject(new Error('MCP connection closed'));
    this.pending.clear();
    this.proc?.kill();
    this.proc = undefined;
    this.connected = false;
  }

  private _onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > 16 * 1024 * 1024) {
      this.lastError = 'MCP message exceeds 16 MiB.';
      this.dispose();
      return;
    }
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(t);
      } catch {
        continue;
      }
      if (msg.method) {
        void this.handleServerMessage(msg);
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  }

  private async handleServerMessage(message: JsonRpcResponse): Promise<void> {
    try {
      if (message.method === 'notifications/cancelled') {
        this.serverRequests.get(message.params?.requestId)?.abort();
        return;
      }
      if (message.method === 'notifications/tools/list_changed') {
        await this.refreshTools();
        this.host?.notification?.(this.config.name, message.method, message.params);
        return;
      }
      if (message.id === undefined) {
        this.host?.notification?.(this.config.name, message.method!, message.params);
        return;
      }
      let result: unknown;
      if (message.method === 'ping') {
        result = {};
      } else if (message.method === 'elicitation/create') {
        const request = ElicitRequestSchema.parse(message);
        const controller = new AbortController();
        this.serverRequests.set(message.id, controller);
        try {
          result = (await this.host?.elicit?.(this.config.name, request.params, controller.signal)) ?? { action: 'decline' };
        } finally {
          this.serverRequests.delete(message.id);
        }
      } else {
        this.writeServerResponse(message.id, undefined, { code: -32601, message: 'Unsupported client request' });
        return;
      }
      this.writeServerResponse(message.id, result);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (message.id !== undefined) this.writeServerResponse(message.id, undefined, { code: -32603, message: text });
      else this.lastError = text;
    }
  }

  private writeServerResponse(id: number | string, result?: unknown, error?: { code: number; message: string }): void {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n', () => {});
  }

  /**
   * Reconnect after the server went away, once per request.
   *
   * A stdio server that crashes or is restarted takes the pipe with it, and an
   * HTTP server that restarts drops its session. Nothing above this class holds
   * a connection open between turns, so without this the next tool call failed
   * with "MCP connection is closed" and every later one did too — the only way
   * back was to reconnect by hand in Settings.
   */
  private ensureAlive(): Promise<boolean> {
    // `closeRequested` means "closed on purpose" (close(), logout()), not "the
    // server died": a stdio server that crashed has a dead pipe and MUST be
    // reconnected. `disposed` is deliberately NOT consulted for that reason.
    if (this.closeRequested) return Promise.resolve(false);
    if (!this.pipeDead()) return Promise.resolve(true);
    if (this.reconnect) return this.reconnect.then(() => true, () => false);
    // Assigned before the attempt starts and cleared by its own completion. No
    // `async` keyword on purpose: an async body runs synchronously up to its
    // first `await`, which is BEFORE the caller can store this promise — so two
    // callers would each start a reconnect, and a server that cannot start was
    // respawned in a loop instead of being reported once.
    const attempt = this.connect()
      .then(() => {
        this.host?.notification?.(this.config.name, 'notifications/reconnected', {});
        return true;
      })
      .catch((error: unknown) => {
        this.connected = false;
        this.lastError = error instanceof Error ? error.message : String(error);
        return false;
      })
      .finally(() => {
        if (this.reconnect === attempt) this.reconnect = undefined;
      });
    this.reconnect = attempt;
    return attempt;
  }

  /** Has this server's pipe gone away? The only evidence a retry is worth it. */
  private pipeDead(): boolean {
    return !this.proc || this.proc.stdin.destroyed || this.proc.killed || this.proc.exitCode !== null;
  }

  /**
   * Send one request, reconnecting once when the server died under it.
   *
   * A stdio server that crashes or is restarted takes the pipe with it, so
   * without a retry the next call failed with "exited (code 1)" and every later
   * one did too — the only way back was to reconnect by hand in Settings.
   *
   * The retry is judged by the PIPE, never by the `connected` flag: the flag is
   * cleared the instant the process exits, which can be after a request is
   * already on the wire, and a freshly spawned process has not been marked
   * connected yet. Asking about the flag turned a reconnect into an endless
   * respawn of a server that simply fails to start. A timeout or a
   * server-reported error is not retried either: it is the answer the caller
   * asked for.
   */
  private async _request(method: string, params: any, signal?: AbortSignal, timeoutMs = 300_000): Promise<any> {
    if (signal?.aborted) throw new Error('aborted: MCP request');
    if (this.config.transport !== 'stdio') return this.remoteRequest(method, params, signal, timeoutMs);
    if (!this.pipeDead()) {
      try {
        return await this._requestRaw(method, params, signal, timeoutMs);
      } catch (error) {
        if (!this.pipeDead() || signal?.aborted) throw error;
      }
    }
    // The pipe is gone: one reconnect, then the request on the new pipe. When
    // the server is genuinely broken, its own reason is what the caller sees.
    const alive = await this.ensureAlive();
    if (!alive) throw new Error(this.lastError || 'MCP connection is closed');
    try {
      return await this._requestRaw(method, params, signal, timeoutMs);
    } catch (error) {
      throw this.lastError ? new Error(this.lastError) : error;
    }
  }

  private _requestRaw(method: string, params: any, signal?: AbortSignal, timeoutMs = 300_000): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = (reason: string) => {
        if (settled) return;
        // MCP cancellation is advisory: the server may already have committed
        // an action. Never imply that settling the local promise rolls it back.
        if (method !== 'initialize') this._notify('notifications/cancelled', { requestId: id, reason });
        finish(new Error(`${reason}; server cancellation is best effort`));
      };
      const onAbort = () => cancel('aborted: MCP request');
      const timer = setTimeout(() => cancel(`timeout: MCP ${method}`), timeoutMs);
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.proc!.stdin.write(payload, (error) => {
          if (!error) return;
          // A closed pipe means the server died; its stderr explains why, so
          // prefer that over the bare EPIPE.
          const code = (error as NodeJS.ErrnoException).code;
          finish(code === 'EPIPE' && this.lastError ? new Error(this.lastError) : error);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async remoteRequest(method: string, params: any, signal?: AbortSignal, timeout = 300_000): Promise<any> {
    const client = this.client;
    if (!client || this.disposed) throw new Error('MCP connection is closed');
    // Placed here rather than in the retry wrapper so the shape of a handed-in
    // client is unchanged for every earlier caller.
    const options = {
      signal,
      timeout,
      maxTotalTimeout: timeout,
      onprogress: (progress: unknown) => this.host?.notification?.(this.config.name, 'notifications/progress', progress),
    };
    try {
      switch (method) {
        case 'tools/list':
          return await client.listTools(params, options);
        case 'tools/call':
          return await client.callTool(params, CallToolResultSchema, options);
        case 'resources/list':
          return await client.listResources(params, options);
        case 'resources/templates/list':
          return await client.listResourceTemplates(params, options);
        case 'resources/read':
          return await client.readResource(params, options);
        default:
          throw new Error(`Unsupported remote MCP request ${method}`);
      }
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof McpAuthRequiredError) {
        this.authState = 'required';
        this.connected = false;
      }
      if (signal?.aborted) throw new Error('aborted: MCP request; server cancellation is best effort');
      throw error;
    }
  }

  private _notify(method: string, params: any): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try {
      if (!this.proc?.stdin.destroyed) {
        this.proc?.stdin.write(payload, () => {
          /* close handler settles requests */
        });
      }
    } catch {
      /* cancellation notifications are best effort */
    }
  }
}