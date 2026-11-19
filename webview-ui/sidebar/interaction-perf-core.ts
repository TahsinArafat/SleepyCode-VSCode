/**
 * Timing for the interaction path, so "clicks feel slow" arrives with numbers.
 *
 * Everything I could measure from here said the interaction path was fine: scroll
 * frames at 16.7 ms, a tab click at 14.4 ms, 21 layout reads per scroll frame. Those
 * numbers were taken from the shipped bundle in a headless browser with a synthetic
 * transcript, which is exactly the environment least likely to reproduce a slow
 * machine. Rather than keep guessing at causes, this records what actually happens on
 * the reporter's hardware and puts it in the log they already know how to copy.
 *
 * Deliberately cheap and bounded: a long-task observer plus a ring of slow samples. It
 * must not become another thing that makes the UI slow.
 */

export type InteractionSample = {
  /** What was being timed. */
  label: string;
  /** Milliseconds. */
  ms: number;
  /** Milliseconds since the session started, so samples can be ordered against events. */
  at: number;
};

/** Long tasks are the browser's own measure of "the main thread was blocked". */
export type LongTaskSample = {
  ms: number;
  at: number;
  /** Where it happened, when the entry names a source. */
  source?: string;
};

/**
 * How slow a sample must be before it is kept.
 *
 * A frame is 16.7 ms. Anything under a full frame is not what a user calls slow, and
 * keeping those would bury the real ones in noise.
 */
export const SLOW_SAMPLE_MS = 50;

/** How many samples to keep. A ring, so a long session cannot grow it without bound. */
export const MAX_SAMPLES = 40;

/**
 * Add a sample if it is slow enough to matter, keeping the ring bounded.
 *
 * Returns the new list rather than mutating, so a caller cannot accidentally share one
 * array between two sessions and so this is trivially testable.
 */
export function recordSample(
  samples: readonly InteractionSample[],
  label: string,
  ms: number,
  at: number,
  thresholdMs = SLOW_SAMPLE_MS,
): InteractionSample[] {
  if (!Number.isFinite(ms) || ms < thresholdMs) return samples as InteractionSample[];
  const next = [...samples, { label, ms, at }];
  return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
}

/** The same ring rule for long tasks. */
export function recordLongTask(
  tasks: readonly LongTaskSample[],
  ms: number,
  at: number,
  source?: string,
  thresholdMs = SLOW_SAMPLE_MS,
): LongTaskSample[] {
  if (!Number.isFinite(ms) || ms < thresholdMs) return tasks as LongTaskSample[];
  const next = [...tasks, source ? { ms, at, source } : { ms, at }];
  return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
}

/**
 * The samples as text for the log or a pasted report.
 *
 * Percentiles rather than a list: a user pasting 40 raw lines tells a reader less than
 * "p95 180 ms, worst 900 ms" does, and the worst few are listed by name so the slow
 * interaction is identifiable.
 */
export function formatInteractionReport(
  samples: readonly InteractionSample[],
  tasks: readonly LongTaskSample[],
  extra: { frameRate?: number } = {},
): string {
  if (!samples.length && !tasks.length) {
    return 'No interaction took longer than 50 ms.';
  }
  const lines: string[] = [];
  if (samples.length) {
    const sorted = [...samples].map(s => s.ms).sort((a, b) => a - b);
    const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    lines.push(`Slow interactions (${samples.length} kept, over 50 ms)`);
    lines.push(`  p50 ${p(0.5).toFixed(0)} ms · p95 ${p(0.95).toFixed(0)} ms · worst ${(sorted[sorted.length - 1] ?? 0).toFixed(0)} ms`);
    for (const sample of [...samples].sort((a, b) => b.ms - a.ms).slice(0, 8)) {
      lines.push(`  ${sample.ms.toFixed(0).padStart(6)} ms  ${sample.label}`);
    }
  }
  if (tasks.length) {
    const worst = Math.max(...tasks.map(t => t.ms));
    const total = tasks.reduce((n, t) => n + t.ms, 0);
    lines.push('');
    lines.push(`Main-thread blocks (${tasks.length} over 50 ms, ${total.toFixed(0)} ms total, worst ${worst.toFixed(0)} ms)`);
    for (const task of [...tasks].sort((a, b) => b.ms - a.ms).slice(0, 6)) {
      lines.push(`  ${task.ms.toFixed(0).padStart(6)} ms  ${task.source ?? '(source not reported)'}`);
    }
  }
  if (extra.frameRate) lines.push('', `Measured frame rate: ${extra.frameRate.toFixed(0)} fps (60 is smooth)`);
  return lines.join('\n');
}
