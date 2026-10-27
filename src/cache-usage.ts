/*
 * How a model's prompt tokens split between cache reads and ordinary input.
 *
 * Providers disagree about cache reporting: some give a cached count, some only
 * a historical total, some nothing. Whatever they omit was billed as ordinary
 * input, so it belongs in the non-cached half — a third "unknown" bucket made
 * the one number a user compares against a bill depend on two others they cannot
 * see.
 *
 * DOM-free so `test/cache-usage.direct.mjs` can hold the arithmetic that
 * `webview-ui/settings/CacheUsage.tsx` renders.
 */

export interface CacheUsageInput {
  promptTokens: number;
  /** Latest reported count of prompt tokens served from the cache. */
  cachedReadTokens?: number;
  /** Historical total of cache reads, when the provider reports that instead. */
  cacheReadInputTokens?: number;
}

export interface CacheSplit {
  /** Prompt tokens known to have been served from the cache. */
  cached: number;
  /** Everything else, including input whose cache status was never reported. */
  nonCached: number;
  /** False when the provider gave no cache information at all. */
  reported: boolean;
}

const count = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0);

export function cacheSplit(usage: CacheUsageInput): CacheSplit {
  const prompt = count(usage.promptTokens);
  const reportedCached = count(usage.cachedReadTokens);
  const cached = Math.min(prompt, reportedCached);
  // Asked of what the provider said, not of the clamped value: a report that the
  // prompt is smaller than is still a report.
  const reported = usage.cacheReadInputTokens !== undefined || reportedCached > 0;
  return { cached, nonCached: Math.max(0, prompt - cached), reported };
}