/**
 * Engine selection.
 *
 * One conversation belongs to one engine. If the Sleepy CLI is available it owns
 * the run loop, tools, permissions, compaction, and `sleepy.db`; the extension
 * only renders its events. The local `ToolLoopAgent` stays as the offline
 * fallback for machines without the CLI, and it is never a second source of
 * truth for a CLI session.
 *
 * The mode is resolved once per conversation and pinned. Swapping engines while
 * a chat is open would mix tool ids, permission rules, and compaction
 * watermarks, so a mode change only applies to conversations that have not run
 * yet.
 */

import { findCliBinary, startOrAttach } from './cli-server.ts';
import { cliErrorText, applyPausedProjection, projectMessage, recoverableAssistant, type CliMessage, type ToolLabel } from './cli-projection.ts';
import type { CliClient } from './cli-client.ts';
import type { TranscriptItem } from './types';

export type EngineMode = 'cli' | 'local';

export type EngineStatus = {
  mode: EngineMode;
  /** Why this mode was chosen, surfaced in the sidebar so the user is never guessing. */
  reason: string;
  url?: string;
};

const SESSION_KEY = 'sleepycode.cliSessionId';

/**
 * Decide the engine for a workspace. The CLI wins whenever it is installed and
 * can serve; otherwise the local loop stays in charge.
 */
export async function resolveEngine(directory: string): Promise<EngineStatus> {
  if (!findCliBinary()) {
    return { mode: 'local', reason: 'The Sleepy CLI is not installed, so this window uses the offline agent.' };
  }
  try {
    const server = await startOrAttach({ directory });
    return { mode: 'cli', reason: 'Using the Sleepy CLI.', url: server.url };
  } catch (error) {
    return { mode: 'local', reason: `The Sleepy CLI could not start (${errorText(error)}), so this window uses the offline agent.` };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Unwrap a `session.error` payload into something worth showing.
 *
 * Shares `cliErrorText` with the projection so a failure reads the same in the
 * toast and in the transcript card. The old local copy fell back to a vague
 * "reported a session error with no detail." while a separate copy in the
 * projection read `error.message`, which the wire format does not have -- so
 * the reason was lost two different ways depending on which path fired.
 */
function sessionErrorText(error: unknown): string {
  return cliErrorText(error) ?? 'The Sleepy CLI reported a session error with no detail.';
}

/**
 * Per-workspace CLI session registry. A VS Code conversation maps to exactly one
 * CLI session id, remembered so reopening the sidebar rejoins the same history
 * instead of starting a second one.
 */
export class CliSessionRegistry {
  private readonly mapping = new Map<string, string>();
  private readonly storage: { get(key: string): string | undefined; set(key: string, value: string): void };

  constructor(storage: { get(key: string): string | undefined; set(key: string, value: string): void }) {
    this.storage = storage;
    const remembered = storage.get(SESSION_KEY);
    if (!remembered) return;
    try {
      const parsed: unknown = JSON.parse(remembered);
      // A corrupt or stale value must not stop the extension from starting; the
      // conversation simply opens a fresh CLI session on its next send.
      if (parsed && typeof parsed === 'object') {
        for (const [conversationId, sessionId] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof sessionId === 'string' && sessionId) this.mapping.set(conversationId, sessionId);
        }
      }
    } catch {
      // Ignore anything that is not our own JSON.
    }
  }

  /**
   * The CLI session backing this conversation, if one was already opened.
   *
   * There is deliberately no "most recent session" fallback. One used to exist
   * because only a single id was persisted, and it handed every conversation the
   * newest session — so a second chat opened on the first chat's history, and two
   * conversations shared one run. Each conversation now keeps its own id.
   */
  sessionFor(conversationId: string): string | undefined {
    return this.mapping.get(conversationId);
  }

  /** Whether this conversation already lives in the CLI. */
  owns(conversationId: string): boolean {
    return this.mapping.has(conversationId);
  }

  bind(conversationId: string, sessionId: string): void {
    this.mapping.set(conversationId, sessionId);
    this.storage.set(SESSION_KEY, JSON.stringify(Object.fromEntries(this.mapping)));
  }

  forget(conversationId: string): void {
    this.mapping.delete(conversationId);
    this.storage.set(SESSION_KEY, JSON.stringify(Object.fromEntries(this.mapping)));
  }
}

/** Live bridge between one CLI session and the sidebar projection. */
export class CliChatSession {
  private readonly controller = new AbortController();
  private stream: Promise<void> | undefined;
  private readonly client: CliClient;
  readonly id: string;
  private readonly label: ToolLabel;
  private readonly onUpdate: (items: TranscriptItem[], busy: boolean) => void;
  private readonly onError: (message: string) => void;
  private readonly onPermission: (permission: { id: string; title?: string }) => void;
  /** Last rows the CLI returned, so a busy-state repaint keeps the transcript. */
  private lastMessages: CliMessage[] = [];
  /** Monotonic id of the newest refresh; older replies are dropped. */
  private refreshTicket = 0;

  constructor(
    client: CliClient,
    id: string,
    label: ToolLabel,
    onUpdate: (items: TranscriptItem[], busy: boolean) => void,
    onError: (message: string) => void,
    onPermission: (permission: { id: string; title?: string }) => void,
  ) {
    this.client = client;
    this.id = id;
    this.label = label;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onPermission = onPermission;
  }

  /** Load current history and start following server events. */
  async open(): Promise<void> {
    await this.refresh();
    if (!this.stream) {
      this.stream = this.client.events(event => this.handle(event), this.controller.signal);
    }
  }

  /** Re-read the authoritative rows. The CLI owns them; we only project. */
  /**
   * Re-read the authoritative rows. The CLI owns them; we only project.
   *
   * A streaming turn fires a burst of events, and each one starts an
   * independent request here. Without ordering, a slow early request resolves
   * after a fast later one and republishes an old snapshot on top of the
   * finished one. Nothing else arrives to correct it, so the sidebar freezes
   * on a partial transcript and the turn looks stuck. Only the newest request
   * is allowed to publish; an older reply is dropped.
   */
  async refresh(): Promise<void> {
    const ticket = ++this.refreshTicket;
    try {
      const messages = await this.client.messages(this.id);
      if (ticket !== this.refreshTicket) return;
      this.publish(messages, false);
    } catch (error) {
      if (ticket === this.refreshTicket) this.onError(errorText(error));
    }
  }

  private publish(messages: CliMessage[], busy: boolean): void {
    this.lastMessages = messages;
    const items = messages.flatMap(message => projectMessage(message, this.label));
    applyPausedProjection(items, busy);
    this.onUpdate(items, busy);
  }

  private handle(event: { type: string; properties?: Record<string, unknown> }): void {
    const properties = event.properties ?? {};
    const sessionID = properties.sessionID as string | undefined;
    // Only this session's events move this sidebar.
    if (sessionID && sessionID !== this.id) return;

    switch (event.type) {
      case 'server.connected':
        void this.refresh();
        break;
      case 'message.updated':
      case 'message.part.updated':
        void this.refresh();
        break;
      case 'permission.asked':
        this.onPermission({
          id: String(properties.permissionID ?? properties.id ?? ''),
          // The CLI publishes `permission` plus `patterns`, not a title.
          title: typeof properties.title === 'string' ? properties.title : undefined,
        });
        // The tool is blocked, so the run is busy — but republish what the CLI
        // last gave us instead of an empty list, or the approval prompt would
        // blank the conversation the user is reading.
        this.publish(this.lastMessages, true);
        break;
      case 'permission.replied':
        void this.refresh();
        break;
      case 'session.idle':
        void this.refresh();
        break;
      case 'session.error':
        this.onError(sessionErrorText(properties.error));
        void this.refresh();
        break;
      default:
        break;
    }
  }

  /** Create a real user message in the CLI and let the CLI run the loop. */
  async send(text: string, model?: { providerID: string; modelID: string }): Promise<void> {
    await this.client.prompt(this.id, text, model);
    await this.refresh();
  }

  async stop(): Promise<void> {
    await this.client.abort(this.id);
    await this.refresh();
  }

  /** Continue the last unfinished assistant, with no invented user turn. */
  async continueTurn(): Promise<boolean> {
    const messages = await this.client.messages(this.id);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info;
      if (info?.role === 'assistant' && recoverableAssistant(info)) {
        await this.client.resumeTurn(this.id, String(info.id));
        return true;
      }
    }
    return false;
  }

  /**
   * Undo the most recent assistant turn, so files come back with the transcript.
   *
   * The message id is resolved here rather than taken from the caller. CLI
   * message ids stay inside this session: the sidebar only ever holds projected
   * items, and letting one of them name a row would tie the display mirror to
   * the engine's private key space.
   */
  async undo(): Promise<boolean> {
    const messages = await this.client.messages(this.id);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info;
      if (info?.role === 'assistant' && info.id) {
        await this.client.revert(this.id, String(info.id));
        await this.refresh();
        return true;
      }
    }
    return false;
  }

  async redo(): Promise<void> {
    await this.client.unrevert(this.id);
    await this.refresh();
  }

  dispose(): void {
    this.controller.abort();
    this.stream = undefined;
  }
}
