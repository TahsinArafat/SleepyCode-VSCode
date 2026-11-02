/*
 * Where the loop stops starting steps.
 *
 * The only thing that may reduce a conversation is compaction. Nothing here
 * removes a message or replaces a tool result: a request shrunk without a summary
 * is context the model silently loses, and the agent then re-reads a file it
 * already read or, worse, edits against a file it no longer has.
 *
 * So the one decision left is when to STOP rather than send a request that cannot
 * fit: the previous step's `prompt_tokens` is measured truth, and at that size the
 * next step would overflow. Stopping there keeps the turn's work, and the caller
 * compacts before continuing.
 */

/** Fraction of the window at which the loop stops starting new steps. */
export const CONTEXT_PRESSURE_RATIO = 0.9;

export interface ContextPressureInput {
  /** The provider's prompt_tokens for the previous step; 0 when unknown. */
  measuredPromptTokens?: number;
  contextWindow?: number | null;
  /** The send budget, used when no window is known. */
  budgetTokens?: number;
}

/**
 * `near` means: the last request already used most of what this model can hold, so
 * another step would very likely overflow. Measured, not estimated — the provider
 * reported it, so it includes the system prompt, tool schemas and the live slice.
 */
export function contextPressure(input: ContextPressureInput): 'ok' | 'near' {
  const measured = typeof input.measuredPromptTokens === 'number' && Number.isFinite(input.measuredPromptTokens)
    ? input.measuredPromptTokens
    : 0;
  if (measured <= 0) return 'ok';
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : 0;
  if (window) return measured >= window * CONTEXT_PRESSURE_RATIO ? 'near' : 'ok';
  // No window known: judge against the budget the request was built from. A guessed
  // window is the dangerous value here, so nothing is invented.
  const budget = input.budgetTokens && input.budgetTokens > 0 ? input.budgetTokens : 0;
  return budget && measured >= budget * CONTEXT_PRESSURE_RATIO ? 'near' : 'ok';
}
