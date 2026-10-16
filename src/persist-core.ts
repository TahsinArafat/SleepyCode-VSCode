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
