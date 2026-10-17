import { CliChatSession, CliSessionRegistry, type CliLiveEvent } from './cli-engine.ts';
import { CliApiError, type CliClient } from './cli-client.ts';
import type { TranscriptItem } from './types';

export type CliChatCallbacks = {
  label: (tool: string, input: unknown) => string;
  update: (items: TranscriptItem[], busy: boolean) => void;
  error: (message: string) => void;
  permission: (permission: { id: string; title?: string }) => void;
  live?: (event: CliLiveEvent) => void;
};

/**
 * Owns the one-to-one relationship between extension conversations and live
 * CLI chat objects. Opening is single-flight per conversation: concurrent UI
 * events cannot create two CLI sessions and race which id gets persisted.
 */
export class CliSessionManager {
  private readonly chats = new Map<string, CliChatSession>();
  private readonly opening = new Map<string, Promise<CliChatSession | undefined>>();
  private readonly client: CliClient;
  private readonly registry: CliSessionRegistry;
  private readonly directory: string;
  private readonly callbacks: (conversationId: string) => CliChatCallbacks;
  /** Called when a bound CLI session disappeared, before a replacement is created. */
  onSessionLost?: (conversationId: string) => void;

  constructor(
    client: CliClient,
    registry: CliSessionRegistry,
    directory: string,
    callbacks: (conversationId: string) => CliChatCallbacks,
  ) {
    this.client = client;
    this.registry = registry;
    this.directory = directory;
    this.callbacks = callbacks;
  }

  get(conversationId: string): CliChatSession | undefined {
    return this.chats.get(conversationId);
  }

  has(conversationId: string): boolean {
    return this.chats.has(conversationId) || this.opening.has(conversationId);
  }

  open(conversationId: string): Promise<CliChatSession | undefined> {
    const existing = this.chats.get(conversationId);
    if (existing) return Promise.resolve(existing);
    const pending = this.opening.get(conversationId);
    if (pending) return pending;

    const task = this.create(conversationId).finally(() => {
      if (this.opening.get(conversationId) === task) this.opening.delete(conversationId);
    });
    this.opening.set(conversationId, task);
    return task;
  }

  forget(conversationId: string): void {
    this.registry.forget(conversationId);
    this.chats.get(conversationId)?.dispose();
    this.chats.delete(conversationId);
    void this.opening.get(conversationId)?.then(chat => chat?.dispose());
    this.opening.delete(conversationId);
  }

  dispose(): void {
    for (const chat of this.chats.values()) chat.dispose();
    this.chats.clear();
    for (const opening of this.opening.values()) void opening.then(chat => chat?.dispose());
    this.opening.clear();
  }

  private async create(conversationId: string): Promise<CliChatSession | undefined> {
    let sessionId = this.registry.sessionFor(conversationId);
    if (!sessionId) {
      sessionId = await this.startSession(conversationId);
    } else if ((await this.sessionState(sessionId)) === 'gone') {
      // The CLI no longer knows this session. Starting a fresh one orphans the old
      // history in sleepy.db, so say so before doing it.
      this.onSessionLost?.(conversationId);
      sessionId = await this.startSession(conversationId);
    }
    // 'unknown' (the probe itself failed) keeps the existing binding and retries against
    // it: a transient error is not evidence the session is gone, and rebinding on one was
    // silently orphaning whole conversations.

    const callbacks = this.callbacks(conversationId);
    const chat = new CliChatSession(
      this.client,
      sessionId,
      callbacks.label,
      callbacks.update,
      callbacks.error,
      callbacks.permission,
      callbacks.live,
    );
    this.chats.set(conversationId, chat);
    await chat.open();
    return chat;
  }

  private async startSession(conversationId: string): Promise<string> {
    const session = await this.client.createSession(this.directory);
    this.registry.bind(conversationId, session.id);
    return session.id;
  }

  /**
   * Does the CLI still hold this session?
   *
   * Only an explicit 404 means gone. Any other failure — a timeout, a 5xx, the CLI
   * restarting, a locked database — is `unknown`, and treating that as gone was
   * silently minting a new session and orphaning the conversation's history.
   */
  private async sessionState(sessionId: string): Promise<'exists' | 'gone' | 'unknown'> {
    try {
      await this.client.messages(sessionId);
      return 'exists';
    } catch (error) {
      return error instanceof CliApiError && error.status === 404 ? 'gone' : 'unknown';
    }
  }
}
