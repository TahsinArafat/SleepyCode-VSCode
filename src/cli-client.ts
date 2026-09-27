/**
 * HTTP + SSE client for the Sleepy CLI.
 *
 * Every call here maps to a route the CLI already owns. The client creates user
 * messages through `prompt_async` and renders what the CLI streams back; it
 * never fabricates a user turn, never runs tools, and never writes SQLite.
 * That is the whole point of adopting the harness: one engine, one history.
 */

import { realpathSync } from 'node:fs';

import { DIRECTORY_HEADER, isDirectoryDenied } from './cli-server.ts';
import type { CliMessage } from './cli-projection';

export type CliSession = {
  id: string;
  slug?: string;
  title?: string;
  projectID?: string;
  directory?: string;
  version?: string;
  time?: { created?: number; updated?: number };
};

export type CliEvent = { type: string; properties?: Record<string, unknown> };

/** Permission replies the CLI accepts. Sent as `response`, not `reply`. */
export type CliPermissionReply = 'once' | 'always' | 'reject';

/** One provider from `GET /provider`, with the models it can currently run. */
export type CliProvider = {
  id: string;
  name?: string;
  models?: Record<string, { id?: string; name?: string } | undefined>;
};

/** `GET /provider`, reduced to what choosing a model actually needs. */
export type CliProviderCatalog = {
  providers: CliProvider[];
  /** providerID -> the model the CLI prefers for it. */
  defaults: Record<string, string>;
  /** Providers with working credentials. Only these can actually run a turn. */
  connected: string[];
};

/**
 * SleepyCode's built-in account provider is `sleepyai`; the Sleepy CLI
 * registers that same first-party account as `sleepy`. The two sides name one
 * provider differently, so matching ids exactly rejected a model the CLI
 * really does have and every send fell back to the CLI default.
 */
export function cliProviderAlias(providerId: string): string | undefined {
  return providerId === 'sleepyai' ? 'sleepy' : undefined;
}

/**
 * True when `resolved` is the model the sidebar asked for. The provider id is
 * compared through {@link cliProviderAlias}, so the account provider counts as
 * a match under either name and a send that did honour the pick stays quiet.
 */
export function isPreferredCliModel(
  preferred: { providerID: string; modelID: string },
  resolved: { providerID: string; modelID: string } | undefined,
): boolean {
  if (!resolved || resolved.modelID !== preferred.modelID) return false;
  return resolved.providerID === preferred.providerID
    || cliProviderAlias(preferred.providerID) === resolved.providerID;
}

/**
 * Choose a model the CLI can really run.
 *
 * The CLI resolves an unspecified model from its own config, and on a fresh
 * install that default is a placeholder (`sleepy/auto-best-coding`) which is in
 * no provider's model list -- so every send failed with "Model not found". The
 * prompt route takes no model filter, so the only way to avoid that is to send
 * a concrete model. Preference order: the sidebar's own pick when the CLI has
 * it, then the CLI's preferred model for a connected provider, then that
 * provider's first model.
 */
export function pickCliModel(
  catalog: CliProviderCatalog,
  preferred?: { providerID: string; modelID: string },
): { providerID: string; modelID: string } | undefined {
  // A model only counts if its provider has working credentials. A preferred id
  // on a provider the user never connected would fail the turn on auth, which
  // is strictly worse than picking a model that can actually run.
  const connected = new Set(catalog.connected);
  const has = (providerId: string, modelId: string): boolean => {
    if (!connected.has(providerId)) return false;
    const entry = catalog.providers.find(candidate => candidate.id === providerId);
    return Boolean(entry?.models && Object.hasOwn(entry.models, modelId));
  };
  if (preferred) {
    if (has(preferred.providerID, preferred.modelID)) {
      return { providerID: preferred.providerID, modelID: preferred.modelID };
    }
    // Same account, other name: the sidebar says `sleepyai`, the CLI says
    // `sleepy`. Without this the user's real pick (e.g.
    // `sleepy/gemini-3.5-flash-lite`) was discarded for the CLI default.
    const aliased = cliProviderAlias(preferred.providerID);
    if (aliased && has(aliased, preferred.modelID)) {
      return { providerID: aliased, modelID: preferred.modelID };
    }
  }
  for (const providerId of catalog.connected) {
    const preferredModel = catalog.defaults[providerId];
    if (preferredModel && has(providerId, preferredModel)) {
      return { providerID: providerId, modelID: preferredModel };
    }
  }
  for (const providerId of catalog.connected) {
    const first = Object.keys(catalog.providers.find(entry => entry.id === providerId)?.models ?? {})[0];
    if (first) return { providerID: providerId, modelID: first };
  }
  return undefined;
}

export class CliApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CliApiError';
    this.status = status;
  }
}

/** Parse a body without letting a non-JSON error page throw through. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The CLI reports the fully resolved directory for a session, so a workspace
 * reached through a symlink (`/tmp` -> `/private/tmp`) must be compared the same
 * way or its sessions would never match.
 */
function resolveDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Default timeout for individual HTTP requests (10 seconds). Long enough for a
 * slow server boot, short enough that a hung server does not block the send path
 * indefinitely. SSE streams use their own signal from the caller.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export class CliClient {
  private readonly baseUrl: string;
  private readonly directory: string | undefined;

  /**
   * In-flight `messages()` fetch, keyed by session id. A burst of SSE events
   * fires many parallel requests; deduplicate so one fetch serves them all
   * rather than N fetches racing each other for a stale-write win.
   */
  private readonly messagesInFlight = new Map<string, Promise<CliMessage[]>>();

  /**
   * `directory` is the workspace this client speaks for. The CLI resolves the
   * project per request from this header, so passing it every time is what keeps
   * a session from being filed under whichever project the server was started in.
   */
  constructor(baseUrl: string, directory?: string) {
    this.baseUrl = baseUrl;
    this.directory = directory;
  }

  private scopedHeaders(extra?: HeadersInit): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.directory ? { [DIRECTORY_HEADER]: this.directory } : {}),
      ...((extra ?? {}) as Record<string, string>),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.scopedHeaders(init.headers),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // A refused workspace is a scoping problem, not a broken request. Say so,
      // because the alternative is the user staring at an empty session list.
      if (isDirectoryDenied(safeParse(body))) {
        throw new CliApiError(
          'The Sleepy server cannot serve this folder. It was started somewhere else, so this workspace needs its own server.',
          response.status,
        );
      }
      throw new CliApiError(`sleepy ${init.method ?? 'GET'} ${path} failed (${response.status}): ${body.slice(0, 200)}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /**
   * Sessions for a workspace directory.
   *
   * The server's own `?directory=` filter is an exact string match and does not
   * resolve symlinks, so a workspace opened through one (`/tmp` vs
   * `/private/tmp`) comes back empty. Fetch the list and match resolved paths
   * here instead of trusting that filter.
   */
  async listSessions(directory?: string): Promise<CliSession[]> {
    const sessions = await this.request<CliSession[]>('/session');
    if (!directory) return sessions;
    const wanted = resolveDirectory(directory);
    return sessions.filter(session => {
      if (!session.directory) return false;
      return session.directory === wanted || session.directory === directory;
    });
  }

  async createSession(directory: string, title?: string): Promise<CliSession> {
    return this.request<CliSession>('/session', { method: 'POST', body: JSON.stringify(title ? { directory, title } : { directory }) });
  }

  /**
   * Fetch the authoritative message list for a session.
   *
   * Deduplicated: if a request for `sessionId` is already in flight, that same
   * Promise is returned so a burst of SSE events does not fire N parallel
   * fetches that race each other. The in-flight entry is removed once settled
   * (success or failure), so the next caller after settlement gets a fresh fetch.
   */
  async messages(sessionId: string): Promise<CliMessage[]> {
    const existing = this.messagesInFlight.get(sessionId);
    if (existing) return existing;
    const request = this.request<CliMessage[]>(`/session/${encodeURIComponent(sessionId)}/message`).finally(() => {
      this.messagesInFlight.delete(sessionId);
    });
    this.messagesInFlight.set(sessionId, request);
    return request;
  }

  /**
   * The providers and models this CLI can actually run.
   *
   * Needed because the CLI keeps its own registry: the sidebar's picker lists
   * SleepyCode's models, and those ids mean nothing to the CLI. Passing one
   * straight through fails the turn with `ProviderModelNotFoundError`.
   */
  async providerCatalog(): Promise<CliProviderCatalog> {
    type Wire = { all?: CliProvider[]; default?: Record<string, string>; connected?: string[] };
    const body = await this.request<Wire | CliProvider[]>('/provider');
    const list: Wire = Array.isArray(body) ? { all: body } : body;
    return {
      providers: list.all ?? [],
      defaults: list.default ?? {},
      connected: list.connected ?? [],
    };
  }

  /**
   * Create a real user message and start the loop. The CLI creates the user
   * message itself, so the client never writes a synthetic "Continue" turn.
   */
  async prompt(sessionId: string, text: string, model?: { providerID: string; modelID: string }): Promise<void> {
    await this.request<void>(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: 'POST',
      // The model must travel with the prompt. Left out, the CLI resolves one
      // from its own config, which on a fresh install is a placeholder that
      // does not exist and every send fails with "Model not found".
      body: JSON.stringify({ parts: [{ type: 'text', text }], ...(model ? { model, providerID: model.providerID } : {}) }),
    });
  }

  /** Stop the run. Incomplete assistant and tool parts stay in SQLite. */
  async abort(sessionId: string): Promise<void> {
    await this.request<boolean>(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });
  }

  /** Unfinished turns the CLI can still resume. */
  async recovery(sessionId: string): Promise<unknown[]> {
    return this.request<unknown[]>(`/session/${encodeURIComponent(sessionId)}/recovery`);
  }

  /**
   * Resume one interrupted assistant. There is no new user message, so the
   * interrupted turn keeps its identity instead of becoming a new turn.
   */
  async resumeTurn(sessionId: string, assistantMessageId: string): Promise<void> {
    await this.request<void>(`/session/${encodeURIComponent(sessionId)}/turn/${encodeURIComponent(assistantMessageId)}/resume`, { method: 'POST' });
  }

  /** Undo. The CLI restores snapshot/patch parts and remembers the revert point. */
  async revert(sessionId: string, messageId: string): Promise<void> {
    await this.request<void>(`/session/${encodeURIComponent(sessionId)}/revert`, { method: 'POST', body: JSON.stringify({ messageID: messageId }) });
  }

  async unrevert(sessionId: string): Promise<void> {
    await this.request<void>(`/session/${encodeURIComponent(sessionId)}/unrevert`, { method: 'POST' });
  }

  /**
   * Answer a permission prompt so the CLI's deferred resolves. There is no
   * VS Code-side approval cache: without this the tool stays blocked forever.
   */
  async respondToPermission(sessionId: string, permissionId: string, response: CliPermissionReply, message?: string): Promise<void> {
    await this.request<boolean>(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: 'POST',
      body: JSON.stringify(message ? { response, message } : { response }),
    });
  }

  /**
   * Stream server events. Reconnects on drop with exponential backoff so a long
   * session survives a server restart; the caller decides what each event means.
   *
   * Backoff starts at 500 ms and doubles on each reconnect up to 16 seconds,
   * then stays flat. A successful connection resets the backoff to zero so a
   * brief restart does not permanently slow down a long-running session.
   */
  events(onEvent: (event: CliEvent) => void, signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      const run = async (): Promise<void> => {
        let backoffMs = 0;
        const MIN_BACKOFF_MS = 500;
        const MAX_BACKOFF_MS = 16_000;

        while (!signal?.aborted) {
          // Wait out the backoff before the next attempt (skipped on first try).
          if (backoffMs > 0) {
            await new Promise(done => setTimeout(done, backoffMs));
            if (signal?.aborted) return;
          }

          try {
            const response = await fetch(`${this.baseUrl}/event`, {
              headers: this.scopedHeaders({ accept: 'text/event-stream' }),
              signal,
              // keepalive lets the browser (or Node fetch) hold the connection
              // open across navigations; harmless on a long-lived extension host.
              keepalive: true,
            });
            if (!response.ok || !response.body) {
              // Bad response: start / continue backoff.
              backoffMs = backoffMs === 0 ? MIN_BACKOFF_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
              continue;
            }

            // Successful connection: reset backoff so a later drop restarts fast.
            backoffMs = 0;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              // SSE frames are separated by a blank line.
              let split: number;
              while ((split = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, split);
                buffer = buffer.slice(split + 2);
                for (const line of frame.split('\n')) {
                  if (!line.startsWith('data:')) continue;
                  try {
                    onEvent(JSON.parse(line.slice(5).trim()) as CliEvent);
                  } catch {
                    // Ignore a partial frame; the next chunk completes it.
                  }
                }
              }
            }
            // Stream closed cleanly; use the minimum backoff for the reconnect.
            backoffMs = MIN_BACKOFF_MS;
          } catch (error) {
            if (signal?.aborted) return;
            // Transport error: grow the backoff.
            backoffMs = backoffMs === 0 ? MIN_BACKOFF_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          }
        }
      };
      void run().then(resolve);
    });
  }
}
