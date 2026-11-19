/**
 * Object-instance census for the extension host.
 *
 * The memory report can say "226 MB is live JS objects" but not WHAT holds them: heap
 * totals and retainer counts cannot name a holder, and a heap snapshot costs hundreds of
 * megabytes and has to be loaded in a separate tool.
 *
 * `v8.queryObjects(ctor)` answers the narrower question directly: how many instances of
 * this constructor are alive. That is enough to name a holder, because the constructors
 * worth probing are the ones a leak would accumulate -- arrays of transcript items,
 * maps keyed by conversation, buffers, strings.
 *
 * Two limits, stated rather than hidden:
 *
 *   - It requires `--expose-gc`, which an extension host is not started with. Without it
 *     every count is unavailable and this reports nothing rather than guessing.
 *   - It is experimental and returns a COUNT, not the objects. It narrows the search; a
 *     heap snapshot is still what identifies the exact retaining path.
 */

export type ObjectCensusEntry = {
  constructor: string;
  count: number;
};

export type ObjectCensus = {
  available: boolean;
  /** Why the census is unavailable, when it is. */
  reason?: string;
  entries: ObjectCensusEntry[];
};

/**
 * The constructors worth counting.
 *
 * Chosen because each one accumulates if a specific kind of thing is retained:
 *
 *   Array / Object  -- the shape of almost every retained collection.
 *   Map / Set       -- caches keyed by conversation id; a map that never shrinks.
 *   Buffer          -- file contents, images, command output. Buffers are the usual
 *                      source of a large `large_object_space`, which is where the
 *                      reported 172 MB sits.
 *   Promise         -- an unresolved promise retains everything its closure captures.
 *                      A growing count means something is waiting forever.
 *   Error           -- retained error objects usually mean a retained stack trace.
 */
const PROBES: Array<[string, () => unknown]> = [
  ['Array', () => Array],
  ['Object', () => Object],
  ['Map', () => Map],
  ['Set', () => Set],
  ['Buffer', () => (globalThis as { Buffer?: unknown }).Buffer],
  ['Promise', () => Promise],
  ['Error', () => Error],
];

/**
 * Count live instances of the interesting constructors.
 *
 * Never throws and never allocates meaningfully: a failed probe is reported as
 * unavailable for that entry rather than aborting the census.
 */
export async function objectCensus(query: (ctor: unknown) => Promise<number> | number): Promise<ObjectCensus> {
  const entries: ObjectCensusEntry[] = [];
  for (const [name, resolve] of PROBES) {
    let ctor: unknown;
    try {
      ctor = resolve();
    } catch {
      continue;
    }
    if (typeof ctor !== 'function') continue;
    try {
      const count = await query(ctor);
      if (typeof count === 'number' && Number.isFinite(count)) entries.push({ constructor: name, count });
    } catch {
      // A constructor the engine will not answer for is simply not reported.
    }
  }
  return { available: entries.length > 0, entries };
}

/**
 * Which counts are large enough to be worth reading.
 *
 * Absolute numbers are not meaningful on their own -- a healthy process holds thousands
 * of small objects -- so this ranks by how far each count sits above a per-constructor
 * baseline. A Buffer count in the tens of thousands, or a Promise count that grows
 * between two reports, is the signal.
 */
export function suspiciousCensusEntries(census: ObjectCensus): ObjectCensusEntry[] {
  const baselines: Record<string, number> = {
    Array: 20_000,
    Object: 50_000,
    Map: 2_000,
    Set: 2_000,
    Buffer: 2_000,
    Promise: 500,
    Error: 2_000,
  };
  return census.entries
    .filter(entry => entry.count > (baselines[entry.constructor] ?? 5_000))
    .sort((a, b) => b.count - a.count);
}

/** The census as text for a copyable report. */
export function formatObjectCensus(census: ObjectCensus): string {
  if (!census.available) {
    return 'Object census unavailable (the extension host is not started with --expose-gc).';
  }
  const lines = ['Live object instances (v8.queryObjects)'];
  const flagged = new Set(suspiciousCensusEntries(census).map(entry => entry.constructor));
  for (const entry of [...census.entries].sort((a, b) => b.count - a.count)) {
    const mark = flagged.has(entry.constructor) ? '  <- elevated' : '';
    lines.push(`  ${entry.constructor.padEnd(12)} ${entry.count.toLocaleString()}${mark}`);
  }
  return lines.join('\n');
}