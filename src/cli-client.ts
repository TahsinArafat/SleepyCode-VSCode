/**
 * HTTP + SSE client for the Sleepy CLI.
 *
 * Every call here maps to a route the CLI already owns. The client creates user
 * messages through `prompt_async` and renders what the CLI streams back; it
 * never fabricates a user turn, never runs tools, and never writes SQLite.
 * That is the whole point of adopting the harness: one engine, one history.
 */

import { realpathSync } from 'node:fs';

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

export class CliApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CliApiError';
    this.status = status;
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

export class CliClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
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

  async messages(sessionId: string): Promise<CliMessage[]> {
    return this.request<CliMessage[]>(`/session/${encodeURIComponent(sessionId)}/message`);
  }

  /**
   * Create a real user message and start the loop. The CLI creates the user
   * message itself, so the client never writes a synthetic "Continue" turn.
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    await this.request<void>(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
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
   * Stream server events. Reconnects on drop so a long session survives a
   * server restart; the caller decides what each event means.
   */
  events(onEvent: (event: CliEvent) => void, signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      const run = async (): Promise<void> => {
        while (!signal?.aborted) {
          try {
            const response = await fetch(`${this.baseUrl}/event`, { headers: { accept: 'text/event-stream' }, signal });
            if (!response.ok || !response.body) {
              await new Promise(done => setTimeout(done, 1000));
              continue;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (; ;) {
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
          } catch (error) {
            if (signal?.aborted) return;
          }
          if (signal?.aborted) return;
          await new Promise(done => setTimeout(done, 1000));
        }
      };
      void run().then(resolve);
    });
  }
}
