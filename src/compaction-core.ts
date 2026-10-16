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
  kind?: 'error' | 'divider';
  contextTokens?: number;
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
  for (const item of recent) {
    if (item.kind === 'divider') continue; // markers carry no model-visible text
    chars += (item.text ?? '').length;
  }
  return CONTEXT_SYSTEM_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Current context-window occupancy: the provider-reported prompt_tokens from the
 * most recent run when available (the true measured context size), falling back
 * to the chars/4 estimate for fresh or just-compacted sessions that have not
 * produced a measured run yet. `measured` reports which path was used.
 */
export function contextOccupancy(items: readonly CompactableItem[]): { tokens: number; measured: boolean } {
  for (let index = items.length - 1; index >= 0; index--) {
    const tokens = items[index]?.contextTokens;
    if (typeof tokens === 'number' && tokens > 0) return { tokens, measured: true };
  }
  return { tokens: estimateContextTokens(items), measured: false };
}

/**
 * Estimate the tokens a single model-visible message contributes, using the same
 * chars/4 heuristic as the rest of the harness. Tool calls and their results are
 * counted from their serialized payload so a large observation is not undercounted.
 */
export function estimateMessageTokens(message: { role?: string; content?: unknown; toolCalls?: unknown }): number {
  let chars = 0;
  const content = message.content;
  if (typeof content === 'string') chars += content.length;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') chars += part.length;
      else if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>;
        if (typeof record.text === 'string') chars += record.text.length;
        else chars += JSON.stringify(part).length;
      }
    }
  } else if (content && typeof content === 'object') {
    chars += JSON.stringify(content).length;
  }
  if (message.toolCalls) chars += JSON.stringify(message.toolCalls).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Summarize which files the conversation already read and changed, so a compacted
 * transcript still tells the next turn what has been inspected. Mirrors Pi's
 * CompactionDetails (readFiles/modifiedFiles). Returns '' when nothing is known.
 */
export function summarizeFileOperations(items: readonly { work?: readonly { kind?: string; tool?: string; text?: string }[] }[]): string {
  const read = new Set<string>();
  const modified = new Set<string>();
  const READ_TOOLS = /^(read_file|obs_recall)$/;
  const WRITE_TOOLS = /^(write_file|replace_text|delete_file)$/;
  // Tool labels read as "<Human Name> · <path>"; match a path-like token anywhere.
  const PATH_IN_TEXT = /([\w./@-]+\.[A-Za-z0-9]{1,8})(?![\w./@-])/g;
  for (const item of items) {
    for (const entry of item.work ?? []) {
      if (entry.kind !== 'task' || !entry.tool || !entry.text) continue;
      const paths = [...entry.text.matchAll(PATH_IN_TEXT)].map(match => match[1]!).filter(Boolean);
      for (const filePath of paths) {
        if (READ_TOOLS.test(entry.tool)) read.add(filePath);
        else if (WRITE_TOOLS.test(entry.tool)) modified.add(filePath);
      }
    }
  }
  for (const filePath of [...modified]) read.delete(filePath);
  const lines = [
    read.size ? `Files already read (do not re-read unless changed): ${[...read].slice(0, 40).join(', ')}` : '',
    modified.size ? `Files modified in this session: ${[...modified].slice(0, 40).join(', ')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Token budget for the structured history handed to the provider on each turn.
 * Deliberately well below the compaction threshold so the newest work always fits
 * with room for the model's response; older turns are summarized by compaction.
 */
export const STRUCTURED_HISTORY_BUDGET_TOKENS = 60_000;

/** True when the estimated occupancy reaches the auto-compaction threshold. */
export function shouldAutoCompact(contextTokens: number, contextWindow?: number | null): boolean {
  const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  if (contextTokens <= 0) return false;
  return contextTokens / window >= AUTO_COMPACT_RATIO;
}

/**
 * Total budget for the summarizer prompt, in characters.
 *
 * The per-item clamp alone was not enough: with `MAX_STORED_ITEMS` = 2_000 the prompt
 * reached ~8M chars (~2M tokens), overran every model's context window, and failed on
 * each candidate in turn. Compaction therefore broke exactly when it was needed.
 */
export const COMPACTION_PROMPT_MAX_CHARS = 600_000;

/**
 * Builds the summarizer input from transcript items. Only the visible message
 * text is included — reasoning/"think" traces are deliberately skipped, and any
 * inline <think> blocks leaked into text by providers are stripped defensively.
 *
 * The result is capped to `maxChars` overall, keeping the newest turns: the recent end
 * of a conversation is what a summary is judged on, and dropping it would summarize the
 * wrong part of the history.
 */
export function compactionPromptInput(
  items: readonly CompactableItem[],
  maxItemChars = 4_000,
  maxChars = COMPACTION_PROMPT_MAX_CHARS,
): string {
  const lines = items
    .filter(item => item.kind !== 'divider') // markers are never sent to the summarizer
    .map(item => {
      const role = item.role === 'user' ? 'User' : 'Assistant';
      const content = (item.text ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxItemChars);
      return `[${role}] ${content}`;
    })
    .reverse(); // newest first, so the budget is spent on the recent turns
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    const size = line.length + 2;
    if (total + size > maxChars) break;
    kept.push(line);
    total += size;
  }
  const newest = lines[0];
  if (!kept.length && newest !== undefined) {
    // The newest turn is larger than the whole budget. Summarizing nothing would be
    // worse than summarizing its tail, so truncate it instead of dropping it.
    kept.push(newest.slice(0, Math.max(0, maxChars - 12)));
  }
  return kept.reverse().join('\n\n');
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
    if (item.kind === 'divider') continue;
    if (!lastUser && item.role === 'user') lastUser = item;
    if (!lastAssistant && item.role === 'assistant' && item.kind !== 'error') lastAssistant = item;
    if (lastUser && lastAssistant) break;
  }
  return { lastUser, lastAssistant };
}
