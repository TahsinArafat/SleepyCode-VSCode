/**
 * Forcing a garbage collection without restarting the process.
 *
 * Every report so far has had to say "this total includes unreclaimed space, compare
 * repeated reports instead". That is a real handicap: V8 sizes its heap by allocation
 * rate, so `heapUsed` routinely sits far above what is genuinely retained, and the
 * difference between "leak" and "has not collected yet" decides which way an
 * investigation goes. The user's own numbers showed both at once -- 406 MB falling to
 * 151 MB on its own while `old_space` stayed at 126 MB.
 *
 * `global.gc` only exists when the process was started with `--expose-gc`, which an
 * extension host is not. But V8 applies `setFlagsFromString` eagerly and a fresh `vm`
 * context picks the flag up, so `runInNewContext('gc')` yields a working collector.
 * Verified directly: after making ~50 MB of garbage, this reclaimed all of it.
 *
 * This is a diagnostic only. It never runs unless the user explicitly asks for a
 * report, and it pauses the event loop for the duration of the collection.
 */

export type GcAccess = {
  /** Runs a collection, or returns false when this engine will not allow one. */
  collect: () => boolean;
};

/**
 * Obtain a working garbage collector.
 *
 * Returns undefined rather than throwing: a diagnostic that cannot run must not be a
 * diagnostic that breaks.
 */
export function acquireGc(deps: {
  setFlagsFromString?: (flags: string) => void;
  runInNewContext?: (code: string) => unknown;
} = {}): GcAccess | undefined {
  const setFlags = deps.setFlagsFromString;
  const runInNewContext = deps.runInNewContext;
  if (!setFlags || !runInNewContext) return undefined;
  try {
    setFlags('--expose-gc');
    const candidate = runInNewContext('gc');
    if (typeof candidate !== 'function') return undefined;
    const gc = candidate as () => void;
    return {
      collect: () => {
        try {
          gc();
          return true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * The heap after a collection, or undefined when no collector is available.
 *
 * A boolean plus a number would let a caller confuse "collected nothing" with "could
 * not collect", so the absence is `undefined` and is stated in the report as such.
 */
export function heapAfterCollection(gc: GcAccess | undefined, heapUsed: () => number): number | undefined {
  if (!gc?.collect()) return undefined;
  return heapUsed();
}

/**
 * What the extension host looked like before this extension allocated anything.
 *
 * The extension host is ONE process shared by every activated extension, so its total
 * says nothing about any one of them. The user's own log showed eight built-ins in the
 * same host as this one, including `vscode.git`, which walks every repository in the
 * workspace.
 *
 * Capturing `heapUsed` at the top of `activate` is the only way to attribute the rest:
 * whatever was already resident is somebody else's, and the difference is ours. Without
 * it, "the extension host is 151 MB" and "SleepyCode is 151 MB" are indistinguishable
 * from a report, which is how a shared-process figure kept looking like a leak.
 */
export type HeapBaseline = {
  /** `heapUsed` before this extension's first allocation. */
  heapUsedAtActivation: number;
  /** `rss` at the same moment: the whole process, other extensions included. */
  rssAtActivation: number;
};

export function captureBaseline(usage: { heapUsed: number; rss: number }): HeapBaseline {
  return { heapUsedAtActivation: usage.heapUsed, rssAtActivation: usage.rss };
}

/**
 * The part of the current heap this extension is responsible for.
 *
 * A negative difference is clamped to zero: the baseline was taken inside a process that
 * keeps working, so the host can legitimately shrink below it after a collection. A
 * negative "ours" figure would be an arithmetic artefact presented as evidence.
 */
export function attributableBytes(baseline: HeapBaseline | undefined, currentHeapUsed: number): number | undefined {
  if (!baseline) return undefined;
  return Math.max(0, currentHeapUsed - baseline.heapUsedAtActivation);
}
