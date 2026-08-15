/**
 * Pure compaction helpers. This module intentionally has NO imports so it can be
 * loaded by the dependency-free direct tests (node --experimental-strip-types).
 *
 * Context-window occupancy is ESTIMATED from transcript text, not from the
 * cumulative per-item token counters. Those counters record lifetime token spend
 * (each run re-sends the whole history, so summing them grows without bound and
 * can exceed the context window many times over — the "5.33M / 1M" bug).
 * Occupancy must instead approximate what the NEXT run would actually send.
 */

export type CompactableItem = {
  role: 'user' | 'assistant';
  text?: string;
  kind?: 'error';
};

/**
 * Rough token allowance for the system prompt, tool schemas, and formatting
 * overhead that accompanies every run but is not visible in transcript text.
 */
export const CONTEXT_SYSTEM_OVERHEAD_TOKENS = 1_500;

/** Characters per token heuristic used for the occupancy estimate. */
export const CHARS_PER_TOKEN = 4;

/**
 * The run prompt only flattens the most recent history items
 * (see `conversation.items.slice(-10, -1)` in agent.ts), so occupancy is
 * estimated over the same window plus the pending turn.
 */
export const COMPACTION_HISTORY_ITEMS = 10;

/** Fraction of the context window at which auto-compaction kicks in. */
export const AUTO_COMPACT_RATIO = 0.75;

/**
 * Default output-token budget for the summarizer call. Reasoning models spend
 * output tokens on thinking BEFORE writing text: with a small budget (the old
 * 1024) they finish with reasoning-only output and result.text comes back
 * empty — the provider dashboard shows a "valid" completion while the
 * extension sees nothing and hops to the next model. 8192 leaves room for
 * thinking plus the requested ~1200-word summary (~1600 tokens).
 */
export const COMPACTION_OUTPUT_BUDGET = 8_192;

/**
 * Output budget for a compaction call with a specific model: the default
 * budget, clamped down to the provider's advertised maxOutputLimit when one
 * is known (sending more than the limit makes strict providers reject the
 * request, which again looks like a model that "does not answer").
 */
export function compactionOutputBudget(maxOutputLimit?: number | null): number {
  if (maxOutputLimit && maxOutputLimit > 0) return Math.min(COMPACTION_OUTPUT_BUDGET, Math.floor(maxOutputLimit));
  return COMPACTION_OUTPUT_BUDGET;
}

/** Assumed context window when the provider does not report one. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Estimated tokens the next run would consume for the given transcript:
 * fixed system overhead plus a chars/4 estimate over the recent history window.
 * Reasoning/work content is never sent to the model, so it is not counted.
 */
export function estimateContextTokens(items: readonly CompactableItem[]): number {
  const recent = items.slice(-COMPACTION_HISTORY_ITEMS);
  let chars = 0;
  for (const item of recent) chars += (item.text ?? '').length;
  return CONTEXT_SYSTEM_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN);
}

/** True when the estimated occupancy reaches the auto-compaction threshold. */
export function shouldAutoCompact(contextTokens: number, contextWindow?: number | null): boolean {
  const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  if (contextTokens <= 0) return false;
  return contextTokens / window >= AUTO_COMPACT_RATIO;
}

/**
 * Builds the summarizer input from transcript items. Only the visible message
 * text is included — reasoning/"think" traces are deliberately skipped, and any
 * inline <think> blocks leaked into text by providers are stripped defensively.
 */
export function compactionPromptInput(items: readonly CompactableItem[], maxItemChars = 4_000): string {
  return items
    .map(item => {
      const role = item.role === 'user' ? 'User' : 'Assistant';
      const content = (item.text ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxItemChars);
      return `[${role}] ${content}`;
    })
    .join('\n\n');
}

/**
 * Picks the latest exchange worth carrying into the compacted transcript.
 * Error items are never carried forward: they add bulk without continuity value.
 */
export function selectCarriedItems<T extends CompactableItem>(items: readonly T[]): { lastUser?: T; lastAssistant?: T } {
  let lastUser: T | undefined;
  let lastAssistant: T | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (!lastUser && item.role === 'user') lastUser = item;
    if (!lastAssistant && item.role === 'assistant' && item.kind !== 'error') lastAssistant = item;
    if (lastUser && lastAssistant) break;
  }
  return { lastUser, lastAssistant };
}
