/**
 * Persistence recovery primitives.
 *
 * Conversation state lives in `globalState`, written through a serial promise chain.
 * A chain is fragile in one specific way: once a promise in it rejects, every later
 * `.then` callback is skipped, so a single failed write silently stops all saving for
 * the rest of the session. These helpers keep one failure from poisoning the chain and
 * make the loss visible instead of silent.
 */

/**
 * Append a write to a serial chain that survives failure.
 *
 * The returned chain never rejects: a failed write is reported through `onError` and the
 * chain stays usable, so the next write still lands. That matters because callers fire
 * writes with `void` -- a rejected chain would both skip every later write and surface as
 * an unhandled rejection.
 */
export function enqueuePersist<T>(
  chain: Promise<T>,
  write: () => Promise<T>,
  onError: (error: unknown) => void,
): Promise<T> {
  return chain.then(write, write).catch(error => {
    onError(error);
    return undefined as T;
  });
}

/**
 * Split a stored project index into usable entries and entries that failed validation.
 *
 * The unreadable entries are returned rather than discarded because the index is rewritten
 * after load: filtering them out of that rewrite deletes their history permanently.
 */
export function splitProjectIndex<T>(
  entries: readonly unknown[],
  isValid: (entry: unknown) => entry is T,
): { usable: T[]; unreadable: unknown[] } {
  const usable: T[] = [];
  const unreadable: unknown[] = [];
  for (const entry of entries) {
    if (isValid(entry)) usable.push(entry);
    else unreadable.push(entry);
  }
  return { usable, unreadable };
}

/**
 * Run a loader over one stored record, degrading to a fallback if that record is corrupt.
 *
 * Startup used to map every persisted conversation unguarded, so a single bad record threw
 * out of the whole load and the panel rendered an empty chat with nothing to explain it.
 */
export function loadEach<T, R>(
  records: readonly T[],
  load: (record: T, index: number) => R,
  fallback: (record: T, index: number, error: unknown) => R,
  onError: (error: unknown, index: number) => void,
): R[] {
  return records.map((record, index) => {
    try {
      return load(record, index);
    } catch (error) {
      onError(error, index);
      return fallback(record, index, error);
    }
  });
}

/**
 * Trim a persisted conversation list to a byte budget, oldest-first.
 *
 * The stored record carries every transcript item, and an item carries the complete
 * pre-edit contents of every file the turn touched. Neither had a cap: the only limits
 * were counts (projects, conversations, items), so a handful of conversations editing
 * large files could write tens of megabytes into `globalState` on every checkpoint.
 *
 * Two rules make this safe to apply to a live product:
 *
 * - **Never drop a conversation that is still open in the window.** The active
 *   conversation is the one the user is looking at; trimming it to satisfy a budget
 *   turns a storage limit into apparent data loss.
 * - **Trim in removal order, not display order.** The caller passes conversations
 *   already sorted most-recent-first, and `pinned` entries sort first. Pinned
 *   conversations are protected because the user asked to keep them.
 *
 * Returns the kept list plus what was dropped, so the caller can report the loss the
 * way the conversation-count limit already does.
 */
export function trimPersistedConversations<T extends { id: string; pinned?: boolean }>(
  conversations: readonly T[],
  budgetBytes: number,
  measure: (conversation: T) => number,
  options: { keepId?: string } = {},
): { kept: T[]; dropped: T[]; bytes: number } {
  const sizes = conversations.map(conversation => measure(conversation));
  let total: number;
  try {
    total = sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    // A record that cannot be measured at all (circular or a throwing getter) is the
    // caller's problem to report; do not let the budget logic be the thing that throws.
    return { kept: [...conversations], dropped: [], bytes: 0 };
  }
  if (total <= budgetBytes) return { kept: [...conversations], dropped: [], bytes: total };

  const dropped: T[] = [];
  const kept: T[] = [];
  // Decide removability first so the loop does not reconsider a protected entry.
  const removable = conversations.map((conversation, index) =>
    conversation.pinned === true || (options.keepId !== undefined && conversation.id === options.keepId) ? -1 : index);

  // Walk from the least-recent end, which is the tail of the caller's ordering.
  const evictionOrder = removable.filter(index => index >= 0).reverse();
  const removed = new Set<number>();
  for (const index of evictionOrder) {
    if (total <= budgetBytes) break;
    removed.add(index);
    dropped.push(conversations[index]!);
    total -= sizes[index]!;
  }

  for (let index = 0; index < conversations.length; index++) {
    if (!removed.has(index)) kept.push(conversations[index]!);
  }
  // `dropped` reads oldest-first so the caller can name the count naturally.
  dropped.reverse();
  return { kept, dropped, bytes: Math.max(0, total) };
}

/**
 * Estimate UTF-8 / JSON-like byte length without allocating serialized strings
 * or recursing unsafely across cycles or deeply nested objects.
 */
export function estimateSerializedBytes(value: unknown, maxNodes = 250_000): number {
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();
  const stack: Array<{ val: unknown; exit?: object }> = [{ val: value }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      active.delete(frame.exit);
      continue;
    }
    if (++nodes > maxNodes) break;

    const current = frame.val;
    if (current === null || current === undefined) {
      bytes += 4;
      continue;
    }
    const kind = typeof current;
    if (kind === 'string') {
      bytes += (current as string).length + 2;
      continue;
    }
    if (kind === 'number') {
      bytes += 10;
      continue;
    }
    if (kind === 'boolean') {
      bytes += (current as boolean) ? 4 : 5;
      continue;
    }
    if (kind === 'bigint') {
      bytes += String(current).length;
      continue;
    }
    if (kind !== 'object') {
      bytes += 8;
      continue;
    }
    const obj = current as object;
    if (active.has(obj)) {
      bytes += 8;
      continue;
    }
    active.add(obj);
    stack.push({ val: undefined, exit: obj });
    if (Array.isArray(obj)) {
      bytes += 2 + Math.max(0, obj.length - 1);
      for (let i = obj.length - 1; i >= 0; i -= 1) {
        stack.push({ val: obj[i] });
      }
    } else {
      bytes += 2;
      const keys = Object.keys(obj);
      bytes += Math.max(0, keys.length - 1);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i]!;
        const v = (obj as Record<string, unknown>)[key];
        if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
          bytes += key.length + 3;
          stack.push({ val: v });
        }
      }
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Lazy per-conversation storage (v2)

import type { Conversation, Project } from './types.ts';

export interface ConversationKeyValueStore {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export type ConversationManifest = Omit<Project, 'conversations'> & {
  version: 2;
  conversations: Conversation[];
};

const HEAVY_CONVERSATION_KEYS = new Set([
  'items', 'messages', 'pending', 'turnUndo', 'turnRedo',
  'cold', 'resident', 'lastUsed', 'estimatedBytes', 'turnSnapshotRevision',
]);

function lastAssistantOf(conversation: Conversation): Conversation['items'][number] | undefined {
  for (let index = conversation.items.length - 1; index >= 0; index -= 1) {
    const item = conversation.items[index];
    if (item?.role === 'assistant') return item;
  }
  return undefined;
}

function metadataOf(conversation: Conversation, cold: boolean): Conversation {
  const metadata = Object.fromEntries(Object.entries(conversation).filter(([key]) => !HEAVY_CONVERSATION_KEYS.has(key))) as unknown as Conversation;
  if (conversation.cold !== true) {
    const assistant = lastAssistantOf(conversation);
    metadata.messageCount = conversation.items.length;
    metadata.changeCount = assistant?.changes?.length ?? 0;
    metadata.lastStatus = assistant?.paused
      ? 'paused'
      : assistant?.kind === 'error'
        ? (assistant.errorInfo?.code === 'interrupted' ? 'stopped' : 'failed')
        : assistant ? 'done' : 'empty';
    metadata.excerpt = (assistant?.text || conversation.items[conversation.items.length - 1]?.text || '').slice(0, 240);
  }
  metadata.items = [];
  metadata.cold = cold;
  return metadata;
}

export function summarizeConversation(conversation: Conversation, cold = conversation.cold === true): Conversation {
  return metadataOf(conversation, cold);
}

/**
 * Cheap identity of everything a conversation write would store.
 *
 * A checkpoint used to rewrite every resident conversation in the project, so a
 * three-second tick during a run meant 3 sequential `globalState.update` calls for
 * each of them — measured at ~17 MB serialized per checkpoint with eight resident
 * chats, all on the extension host's single thread.
 *
 * The reason a fingerprint is needed rather than a timestamp comparison: not every
 * mutation bumps `updatedAt`. `setPersona` and `setMode` deliberately do not, and
 * `goal.tokensUsed` changes on every step. A timestamp check would therefore skip
 * writes for real changes, which is silent data loss — the exact failure this file
 * exists to prevent. Several edits also mutate an item in place (`commitMessage`,
 * `change.staged`), which no array-length check would see.
 *
 * Cost is O(items) of property reads — no string building, no serialization. The
 * bound is deliberate: an in-place edit that preserves both the item's text length
 * and its sibling layout is invisible here. Every mutation in this codebase either
 * pushes, replaces an array, or changes a length, so that case does not arise.
 */
export function conversationFingerprint(conversation: Conversation): string {
  let items = `0:0:0`;
  // Reference identity per item plus its text length, rolled into one running
  // number: catches an in-place text edit without allocating per-item strings.
  let stamp = 0;
  let textLength = 0;
  for (const item of conversation.items) {
    stamp = (stamp * 31 + referenceStamp(item)) | 0;
    textLength += (item.text?.length ?? 0) + (item.partialText?.length ?? 0);
  }
  items = `${stamp}:${textLength}:${conversation.items.length}`;
  return [
    conversation.updatedAt,
    conversation.title,
    conversation.archived === true ? 1 : 0,
    conversation.pinned === true ? 1 : 0,
    conversation.model ?? '',
    conversation.provider ?? '',
    conversation.agentId ?? '',
    conversation.personaId ?? '',
    conversation.mode ?? '',
    conversation.reasoningEffort ?? '',
    conversation.messages?.length ?? -1,
    conversation.turnUndo?.length ?? 0,
    conversation.turnRedo?.length ?? 0,
    // `pending` is replaced with a fresh object on every checkpoint while
    // streaming, so its identity is what distinguishes "in flight" from "settled"
    // — and a still-pending turn whose text grew is a real change.
    referenceStamp(conversation.pending),
    // Goal token accounting mutates without bumping `updatedAt`, so the numbers
    // that move are part of the identity.
    conversation.goal?.tokensUsed ?? -1,
    conversation.goal?.status ?? '',
    conversation.goal?.tokenBudget ?? -1,
    // Cold summaries are themselves stored metadata, and offloading writes them
    // without bumping `updatedAt`. Leaving them out would let the manifest keep an
    // old message count for a chat that has since been released.
    conversation.cold === true ? 1 : 0,
    conversation.messageCount ?? -1,
    conversation.changeCount ?? -1,
    conversation.lastStatus ?? '',
    conversation.excerpt ?? '',
    // Reference-level identity for arrays that are replaced wholesale. Cheap, and
    // it catches a rewrite that happens to preserve every length.
    referenceStamp(conversation.items),
    referenceStamp(conversation.messages),
    referenceStamp(conversation.turnUndo),
    referenceStamp(conversation.turnRedo),
    items,
  ].join('\u0000');
}

/** A stable per-object integer, so reference identity is usable in a string key. */
let referenceCounter = 0;
const referenceIds = new WeakMap<object, number>();

function referenceStamp(value: object | undefined): number {
  if (!value) return 0;
  const existing = referenceIds.get(value);
  if (existing !== undefined) return existing;
  referenceCounter += 1;
  referenceIds.set(value, referenceCounter);
  return referenceCounter;
}

export function projectV2Key(projectId: string): string {
  return `sleepycode.project.v2.${projectId}`;
}

export function conversationV2Key(conversationId: string): string {
  return `sleepycode.conversation.${conversationId}`;
}

export function turnSnapshotsV2Key(conversationId: string, revision: string): string {
  return `sleepycode.turnSnapshots.${conversationId}.${revision}`;
}

/**
 * Copy-on-write per-conversation records. Snapshot revisions are immutable, so a
 * failed core update leaves the previous core and its previous undo readable.
 */
export class ConversationStore {
  private readonly storage: ConversationKeyValueStore;
  /**
   * Fingerprint of what was last written successfully, per conversation.
   *
   * Kept on the store rather than on the conversation so a failed write is never
   * recorded as persisted: the entry is set only after both records land.
   */
  private readonly written = new Map<string, string>();
  /** Fingerprint of what was last written successfully, per project manifest. */
  private readonly writtenManifest = new Map<string, string>();

  constructor(storage: ConversationKeyValueStore) {
    this.storage = storage;
  }

  readManifest(projectId: string): ConversationManifest | undefined {
    const manifest = this.storage.get<ConversationManifest>(projectV2Key(projectId));
    return manifest?.version === 2 && Array.isArray(manifest.conversations) ? manifest : undefined;
  }

  async writeManifest(project: Project): Promise<boolean> {
    // The manifest is a projection of every conversation's metadata, so it goes
    // stale exactly when one of them changes. Fingerprinting the projection is
    // what lets a checkpoint skip it when nothing moved: without this, dropping
    // the per-conversation core write would leave the history list showing an old
    // message count and excerpt for a turn that had already been saved.
    const conversations = project.conversations.map(conversation => metadataOf(conversation, conversation.cold === true));
    // Fingerprinted from the SOURCE conversations, not the summaries: `metadataOf`
    // allocates a fresh `items: []` on every call, so a summary's reference stamp
    // would differ on each pass and the manifest would never be skipped. The source
    // carries everything the summary is derived from.
    const fingerprint = `${project.updatedAt}\u0000${project.activeConversationId}\u0000${project.name}\u0000` +
      project.conversations.map(conversation => conversationFingerprint(conversation)).join('\u0001');
    if (this.writtenManifest.get(project.id) === fingerprint) return true;
    try {
      const manifest: ConversationManifest = {
        version: 2,
        id: project.id,
        name: project.name,
        path: project.path,
        activeConversationId: project.activeConversationId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        conversations,
      };
      await this.storage.update(projectV2Key(project.id), manifest);
      this.writtenManifest.set(project.id, fingerprint);
      return true;
    } catch {
      this.writtenManifest.delete(project.id);
      return false;
    }
  }

  readConversation(conversationId: string): Conversation | undefined {
    const core = this.storage.get<Conversation & { turnSnapshotRevision?: string }>(conversationV2Key(conversationId));
    if (!core || !Array.isArray(core.items)) return undefined;
    let turnUndo: Conversation['turnUndo'] = [];
    let turnRedo: Conversation['turnRedo'] = [];
    if (core.turnSnapshotRevision) {
      const snapshots = this.storage.get<{ undo?: Conversation['turnUndo']; redo?: Conversation['turnRedo'] }>(
        turnSnapshotsV2Key(conversationId, core.turnSnapshotRevision),
      );
      turnUndo = snapshots?.undo ?? [];
      turnRedo = snapshots?.redo ?? [];
    }
    return { ...core, turnUndo, turnRedo, cold: false };
  }

  async writeConversation(conversation: Conversation): Promise<boolean> {
    const fingerprint = conversationFingerprint(conversation);
    // Already durable and nothing changed: this is the common case on a checkpoint,
    // which fires every three seconds and previously rewrote every resident chat.
    // `true` is correct here — the caller's contract is "is this conversation on
    // disk", and it is.
    if (this.written.get(conversation.id) === fingerprint) return true;
    const previousRevision = conversation.turnSnapshotRevision;
    const undo = conversation.turnUndo ?? [];
    const redo = conversation.turnRedo ?? [];
    // An empty stack carries no information, so it does not need a record of its
    // own. Writing one meant a checkpoint paid three store writes per conversation
    // to persist two empty arrays, and leaving `turnSnapshotRevision` pointing at
    // the OLD record would resurrect undo entries that have since been cleared.
    const revision = undo.length || redo.length
      ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : undefined;
    try {
      if (revision) {
        await this.storage.update(turnSnapshotsV2Key(conversation.id, revision), { revision, undo, redo });
      }
      const core = {
        ...metadataOf(conversation, false),
        items: conversation.items,
        messages: conversation.messages,
        pending: conversation.pending,
        ...(revision ? { turnSnapshotRevision: revision } : {}),
      };
      await this.storage.update(conversationV2Key(conversation.id), core);
      if (previousRevision && previousRevision !== revision) {
        await Promise.resolve(this.storage.update(turnSnapshotsV2Key(conversation.id, previousRevision), undefined)).catch(() => undefined);
      }
      conversation.turnSnapshotRevision = revision;
      conversation.cold = false;
      // Recorded only after both writes land, so a failure is retried next time
      // instead of being remembered as saved.
      this.written.set(conversation.id, fingerprint);
      return true;
    } catch {
      this.written.delete(conversation.id);
      return false;
    }
  }

  /** Write every record before exposing the v2 manifest; v1 remains untouched. */
  async migrateProject(project: Project): Promise<boolean> {
    for (const conversation of project.conversations) {
      if (!(await this.writeConversation(conversation))) return false;
    }
    return this.writeManifest(project);
  }

  async deleteConversation(conversationId: string, turnSnapshotRevision?: string): Promise<void> {
    // Drop the memo first: a conversation recreated under the same id must be
    // written, not skipped as already-durable.
    this.written.delete(conversationId);
    await this.storage.update(conversationV2Key(conversationId), undefined);
    if (turnSnapshotRevision) await this.storage.update(turnSnapshotsV2Key(conversationId, turnSnapshotRevision), undefined);
  }
}
