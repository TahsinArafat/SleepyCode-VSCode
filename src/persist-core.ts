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
