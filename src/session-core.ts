/**
 * Pure conversation session-state helpers. This module has NO imports so it can
 * be loaded by the dependency-free direct tests (node --experimental-strip-types).
 *
 * A conversation is one record: display items, model-visible messages, an
 * unfinished pending turn, and the workspace snapshot for that turn. Every
 * mutation must cut or restore all four. Setting messages = undefined is how
 * undo/retry/continue looked like they worked and then lost context.
 */

export type SessionHistoryMessage = {
  role?: string;
  content?: unknown;
  toolCalls?: unknown;
};

export type SessionTranscriptItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: 'error' | 'divider' | 'approval';
  /** Mirrors `ApprovalRecord` in types.ts, redeclared structurally to keep this module dependency-free. */
  approval?: {
    title: string;
    kind: 'edit' | 'command';
    command?: string;
    risk?: 'low' | 'medium' | 'high';
    decision: 'once' | 'session' | 'rejected';
  };
  partialText?: string;
  work?: unknown[];
  changes?: unknown[];
  fileSnapshot?: unknown[];
  gitTree?: string;
  paused?: boolean;
  pauseReason?: string;
  pauseLimit?: number;
};

export type SessionPendingExtras = {
  partialText?: string;
  work?: unknown[];
  changes?: unknown[];
  fileSnapshot?: unknown[];
  gitTree?: string;
};

export type SessionPending<TMessage extends SessionHistoryMessage = SessionHistoryMessage> = {
  userText: string;
  messages: TMessage[];
  startedAt: number;
} & SessionPendingExtras;

export type SessionFileSnapshot = {
  path: string;
  existed: boolean;
  content: string;
};

export type SessionConversation<TItem extends SessionTranscriptItem = SessionTranscriptItem, TMessage extends SessionHistoryMessage = SessionHistoryMessage> = {
  items: TItem[];
  messages?: TMessage[];
  pending?: SessionPending<TMessage>;
  turnUndo?: SessionTurnSnapshot<TItem, TMessage>[];
  turnRedo?: SessionTurnSnapshot<TItem, TMessage>[];
};

function sameHistoryMessages(left: readonly SessionHistoryMessage[] | undefined, right: readonly SessionHistoryMessage[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export type SessionTurnSnapshot<TItem extends SessionTranscriptItem = SessionTranscriptItem, TMessage extends SessionHistoryMessage = SessionHistoryMessage> = {
  items: TItem[];
  messages: TMessage[];
  redoFiles?: SessionFileSnapshot[];
  redoGitTree?: string;
};

export type SessionCompactionSnapshot<TItem extends SessionTranscriptItem = SessionTranscriptItem, TMessage extends SessionHistoryMessage = SessionHistoryMessage> = {
  beforeItems: TItem[];
  afterItems: TItem[];
  beforeMessages: TMessage[];
  afterMessages: TMessage[];
};

export type InterruptedTurnInput = {
  userText: string;
  reason: 'stop' | 'error' | 'max_steps' | 'max_tokens';
  message: string;
  work?: unknown[];
  changes?: unknown[];
  fileSnapshot?: unknown[];
  gitTree?: string;
  partialText?: string;
  pauseLimit?: number;
};

/** Index of the user message that owns the last complete turn. */
export function lastOwnedUserStart(messages: readonly SessionHistoryMessage[] | undefined): number {
  if (!messages?.length) return 0;
  for (let cursor = messages.length - 1; cursor >= 0; cursor--) {
    if (messages[cursor]?.role === 'user') return cursor;
  }
  return 0;
}

/**
 * Recover a crash/reload checkpoint into durable structured history.
 *
 * Fold `pending` onto the tail whenever it is newer work than the stored
 * history. A previous empty-history-only rule dropped in-progress turns after
 * older messages already existed.
 */
export function recoverPendingHistory<T extends SessionHistoryMessage>(
  messages: T[] | undefined,
  pending: { userText?: string; messages?: T[] } | undefined,
  maxStored: number,
): T[] | undefined {
  if (!pending?.messages?.length) return messages;
  const existing = messages ?? [];
  const pendingTail = pending.messages;
  if (existing.length) {
    const existingTail = existing.slice(-pendingTail.length);
    if (sameHistoryMessages(existingTail, pendingTail)) return existing;
  }
  const alreadyHasUser = existing.length > 0 && existing[lastOwnedUserStart(existing)]?.content === (pending.userText ?? '') && existing[lastOwnedUserStart(existing)]?.role === 'user';
  const carried: T[] = alreadyHasUser
    ? [...existing, ...pendingTail]
    : [...existing, { role: 'user', content: pending.userText ?? '' } as T, ...pendingTail];
  return carried.length > maxStored ? carried.slice(-maxStored) : carried;
}

/**
 * Slice structured history so it matches a rolled-back transcript. Cuts at the
 * last user-owned boundary that still belongs to `keptItems`.
 */
export function sliceMessagesToItems<T extends SessionHistoryMessage>(
  messages: readonly T[] | undefined,
  keptItems: readonly SessionTranscriptItem[],
): T[] | undefined {
  if (!messages?.length) return messages ? messages.slice() : messages;
  const keptUsers = keptItems.filter(item => item.role === 'user' && item.kind !== 'divider');
  if (!keptUsers.length) return [];
  let seen = 0;
  let end = 0;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role !== 'user') continue;
    seen += 1;
    if (seen > keptUsers.length) {
      return messages.slice(0, end);
    }
    end = messages.length;
    for (let cursor = index + 1; cursor < messages.length; cursor++) {
      if (messages[cursor]?.role === 'user') {
        end = cursor;
        break;
      }
    }
  }
  return seen >= keptUsers.length ? messages.slice(0, end) : messages.slice();
}

/** Pop the last user/assistant pair (and optional trailing divider) from a conversation. */
export function popLastTurn<TItem extends SessionTranscriptItem, TMessage extends SessionHistoryMessage>(
  conversation: SessionConversation<TItem, TMessage>,
): { popped: TItem[]; snapshot: SessionTurnSnapshot<TItem, TMessage> } | undefined {
  if (!conversation.items.length) return undefined;
  const beforeItems = conversation.items.slice();
  const beforeMessages = conversation.messages?.slice() ?? [];
  const popped: TItem[] = [];
  const last = conversation.items[conversation.items.length - 1];
  if (last?.role === 'assistant' || last?.kind === 'divider') popped.unshift(conversation.items.pop()!);
  const prev = conversation.items[conversation.items.length - 1];
  if (prev?.role === 'user') popped.unshift(conversation.items.pop()!);
  if (!popped.length) return undefined;
  conversation.messages = sliceMessagesToItems(beforeMessages, conversation.items);
  conversation.pending = undefined;
  return {
    popped,
    snapshot: { items: beforeItems, messages: beforeMessages },
  };
}

export function applyTurnSnapshot<TItem extends SessionTranscriptItem, TMessage extends SessionHistoryMessage>(
  conversation: SessionConversation<TItem, TMessage>,
  snapshot: SessionTurnSnapshot<TItem, TMessage>,
): void {
  conversation.items = snapshot.items.slice();
  conversation.messages = snapshot.messages.slice();
  conversation.pending = undefined;
}

/**
 * Fork a conversation at a transcript item. Items and model-visible messages
 * are sliced together so the branch does not replay later turns.
 */
export function branchConversationState<TItem extends SessionTranscriptItem, TMessage extends SessionHistoryMessage>(
  conversation: SessionConversation<TItem, TMessage>,
  targetIndex: number,
): { items: TItem[]; messages: TMessage[] } | undefined {
  if (targetIndex < 0 || targetIndex >= conversation.items.length) return undefined;
  const items = conversation.items.slice(0, targetIndex + 1);
  return {
    items,
    messages: sliceMessagesToItems(conversation.messages, items) ?? [],
  };
}

export function restoreCompaction<TItem extends SessionTranscriptItem, TMessage extends SessionHistoryMessage>(
  conversation: SessionConversation<TItem, TMessage>,
  snapshot: SessionCompactionSnapshot<TItem, TMessage>,
  side: 'before' | 'after',
): void {
  conversation.items = (side === 'before' ? snapshot.beforeItems : snapshot.afterItems).slice();
  conversation.messages = (side === 'before' ? snapshot.beforeMessages : snapshot.afterMessages).slice();
  conversation.pending = undefined;
}

export function originalUserText(items: readonly SessionTranscriptItem[], fallback = ''): string {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.role === 'user' && item.kind !== 'divider') return item.text;
  }
  return fallback;
}

/**
 * Resume payload for retry / continue / stop. Reuses the last real user item
 * instead of inventing a "Continue" turn that poisons structured history.
 */
export function resumeFromLastAssistant<TItem extends SessionTranscriptItem>(
  items: readonly TItem[],
): { userText: string; resume: InterruptedTurnInput; item: TItem } | undefined {
  const last = items[items.length - 1];
  if (!last || last.role !== 'assistant') return undefined;
  const userText = originalUserText(items.slice(0, -1));
  if (!userText) return undefined;
  const reason: InterruptedTurnInput['reason'] = last.paused ? (last.pauseReason === 'max_tokens' ? 'max_tokens' : 'max_steps') : last.kind === 'error' ? 'error' : 'stop';
  return {
    userText,
    item: last,
    resume: {
      userText,
      reason,
      message: last.text,
      work: last.work,
      changes: last.changes,
      fileSnapshot: last.fileSnapshot,
      gitTree: last.gitTree,
      partialText: last.partialText || (last.paused || last.kind === 'error' ? undefined : last.text) || undefined,
      pauseLimit: last.pauseLimit,
    },
  };
}

/**
 * Card text for a turn that never finished. Retryable, never a dead end: a bare
 * "Stopped." hid the partial response and left no obvious way back in.
 *
 * The streamed partial is kept in `partialText` instead, because the webview
 * renders `partialText` as a bubble and the error card from `text`. Duplicating
 * it across both fields prints the same response twice.
 */
export const INTERRUPTED_TURN_TEXT = 'Response interrupted — retry continues from this point.';

export function interruptedAssistantFields(input: InterruptedTurnInput): {
  kind?: 'error';
  paused?: boolean;
  pauseReason?: 'max_steps';
  pauseLimit?: number;
  partialText?: string;
  work?: unknown[];
  changes?: unknown[];
  fileSnapshot?: unknown[];
  gitTree?: string;
} {
  return {
    kind: input.reason === 'error' || input.reason === 'stop' ? 'error' : undefined,
    paused: input.reason === 'max_steps' || undefined,
    pauseReason: input.reason === 'max_steps' ? 'max_steps' : undefined,
    pauseLimit: input.reason === 'max_steps' ? input.pauseLimit : undefined,
    partialText: input.partialText,
    work: input.work,
    changes: input.changes,
    fileSnapshot: input.fileSnapshot,
    gitTree: input.gitTree,
  };
}

/** Reload extras from a crash checkpoint so the interrupted card keeps work, files, and partial text. */
export function interruptedFieldsFromPending(pending: SessionPendingExtras | undefined): SessionPendingExtras {
  if (!pending) return {};
  return {
    partialText: pending.partialText,
    work: pending.work,
    changes: pending.changes,
    fileSnapshot: pending.fileSnapshot,
    gitTree: pending.gitTree,
  };
}

/** Undo restores the pre-turn snapshots; redo restores the post-turn files captured at undo time. */
export function workspaceRestoreFromSnapshot(
  snapshot: SessionTurnSnapshot,
  side: 'undo' | 'redo',
): SessionFileSnapshot[] | undefined {
  if (side === 'redo') return snapshot.redoFiles;
  const last = snapshot.items[snapshot.items.length - 1];
  return last?.fileSnapshot as SessionFileSnapshot[] | undefined;
}

/** Undo restores the pre-turn git tree; redo restores the tree captured at undo time. */
export function workspaceGitRestoreFromSnapshot(
  snapshot: SessionTurnSnapshot,
  side: 'undo' | 'redo',
): string | undefined {
  if (side === 'redo') return snapshot.redoGitTree;
  const last = snapshot.items[snapshot.items.length - 1];
  return last?.gitTree;
}

/** A later send or edit invalidates any undone/redone turn. */
export function clearForwardStacks<TItem extends SessionTranscriptItem, TMessage extends SessionHistoryMessage>(
  conversation: SessionConversation<TItem, TMessage>,
): void {
  conversation.turnUndo = [];
  conversation.turnRedo = [];
}

/** Move the latest undone snapshot onto the redo stack and return it. */
export function takeTurnRedo<TItem extends SessionTranscriptItem, TMessage extends SessionHistoryMessage>(
  conversation: SessionConversation<TItem, TMessage>,
): SessionTurnSnapshot<TItem, TMessage> | undefined {
  const snapshot = conversation.turnUndo?.at(-1);
  if (!snapshot) return undefined;
  conversation.turnUndo = conversation.turnUndo?.slice(0, -1) ?? [];
  conversation.turnRedo = [...(conversation.turnRedo ?? []), snapshot].slice(-5);
  return snapshot;
}

export function persistCompactionStacks<T>(input: { undo?: readonly T[]; redo?: readonly T[] }): { undo: T[]; redo: T[] } {
  return {
    undo: (input.undo ?? []).slice(-3) as T[],
    redo: (input.redo ?? []).slice(-3) as T[],
  };
}

export function loadCompactionStacks<T>(stored: unknown): { undo: T[]; redo: T[] } {
  if (Array.isArray(stored)) return { undo: stored.slice(-3) as T[], redo: [] };
  if (stored && typeof stored === 'object') {
    const record = stored as { undo?: T[]; redo?: T[] };
    return {
      undo: Array.isArray(record.undo) ? record.undo.slice(-3) : [],
      redo: Array.isArray(record.redo) ? record.redo.slice(-3) : [],
    };
  }
  return { undo: [], redo: [] };
}

/**
 * Everything that must be true of a conversation recovered from storage.
 *
 * Loading a conversation is not "read the JSON back". A stored record can be truncated
 * by a reload mid-run, written by an older build, or hand-edited, so the load path has
 * three jobs that are easy to lose one at a time:
 *
 * 1. **Normalize each item**, degrading a single corrupt one instead of aborting the
 *    whole load (a throw here used to render an empty chat with no explanation).
 * 2. **Fold an interrupted run's checkpoint** onto the transcript, so the next message
 *    keeps that work and the user can see the turn did not finish.
 * 3. **Clamp the undo stacks.** They are bounded when pushed, but a stored stack longer
 *    than the cap must not survive a reload.
 *
 * This lives here rather than in the provider so the rules are testable without a VS
 * Code host, and so a future store cannot reimplement one of the three and miss another.
 */
export function restoreLoadedConversation<
  TItem extends SessionTranscriptItem,
  TMessage extends SessionHistoryMessage,
  TConversation extends SessionConversation<TItem, TMessage> & { pending?: SessionPending<TMessage> },
>(
  conversation: TConversation,
  options: {
    /** Per-model history floor; see `storedMessageLimit`. */
    maxStoredMessages: number;
    /** Cap for the undo/redo stacks. */
    maxTurnUndo: number;
    /** Coerce one stored item, or throw to have it replaced by `fallbackItem`. */
    normalizeItem: (item: unknown, index: number) => TItem;
    /** The item substituted when one fails to normalize. */
    fallbackItem: () => TItem;
    /** The marker item appended when a run was interrupted with nothing already shown. */
    interruptedItem: (extras: SessionPendingExtras) => TItem;
    onCorruptItem?: (error: unknown, index: number) => void;
  },
): TConversation {
  const stored = Array.isArray(conversation.items) ? conversation.items : [];
  const items = loadEachLike(stored, options.normalizeItem, options.fallbackItem, options.onCorruptItem);
  const pending = conversation.pending;
  conversation.messages = recoverPendingHistory(conversation.messages, pending, options.maxStoredMessages);
  if (pending) {
    const last = items[items.length - 1];
    const alreadyShown = last?.role === 'assistant' && (last.kind === 'error' || last.paused);
    const extras = interruptedFieldsFromPending(pending);
    if (!alreadyShown) {
      const interrupted = options.interruptedItem(extras);
      interrupted.partialText = extras.partialText ?? (typeof last?.partialText === 'string' ? last.partialText : undefined);
      if (extras.work) interrupted.work = extras.work;
      if (extras.changes) interrupted.changes = extras.changes;
      if (extras.fileSnapshot) interrupted.fileSnapshot = extras.fileSnapshot;
      if (extras.gitTree) interrupted.gitTree = extras.gitTree;
      items.push(interrupted);
    } else {
      last.partialText ??= extras.partialText;
      last.work ??= extras.work;
      last.changes ??= extras.changes;
      last.fileSnapshot ??= extras.fileSnapshot;
      last.gitTree ??= extras.gitTree;
    }
    conversation.pending = undefined;
  }
  conversation.turnUndo = Array.isArray(conversation.turnUndo) ? conversation.turnUndo.slice(-options.maxTurnUndo) : [];
  conversation.turnRedo = Array.isArray(conversation.turnRedo) ? conversation.turnRedo.slice(-options.maxTurnUndo) : [];
  return { ...conversation, items };
}

/**
 * `loadEach` from `persist-core`, redeclared here.
 *
 * `session-core` is deliberately import-free so the dependency-free direct suite can
 * load it; importing `persist-core` would drag in the persistence layer for a helper
 * that is six lines of map/try.
 */
function loadEachLike<T, R>(records: readonly T[], load: (record: T, index: number) => R, fallback: (record: T, index: number) => R, onError?: (error: unknown, index: number) => void): R[] {
  return records.map((record, index) => {
    try {
      return load(record, index);
    } catch (error) {
      onError?.(error, index);
      return fallback(record, index);
    }
  });
}
