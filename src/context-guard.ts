/*
 * Where the loop stops starting steps, and what it drops to keep a request small.
 *
 * Stored history is budgeted before every request (`structuredHistory`). The live
 * slice — the tool calls and results produced by the turn in flight — was not, so
 * a long agentic turn could grow past the model's window with nothing measuring
 * it, and the first thing to notice was the provider rejecting the request.
 *
 * Two decisions live here, both pure:
 *   - `contextPressure`: stop launching steps when the previous request already
 *     used most of the window, instead of finding out from a 400;
 *   - `trimToolResultsForRequest`: shrink the request by replacing the bulk inside
 *     its oldest tool results, never by removing messages — a missing tool result
 *     is what strict providers reject, and the saved transcript must stay whole.
 */

/** Fraction of the window at which the loop stops starting new steps. */
export const CONTEXT_PRESSURE_RATIO = 0.9;

/** Stands in for a tool result that was dropped from one request. */
export const TOOL_RESULT_STUB =
  '[older tool result removed from this request to stay within the model\'s context window. Read the file or run the command again if you need it.]';

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

/** Tokens the live slice may spend: whatever history and the prompt leave behind. */
export function liveSliceBudget(input: { budgetTokens: number; historyTokens?: number; promptTokens?: number }): number {
  const budget = Number.isFinite(input.budgetTokens) ? input.budgetTokens : 0;
  const history = Number.isFinite(input.historyTokens ?? 0) ? (input.historyTokens ?? 0) : 0;
  const prompt = Number.isFinite(input.promptTokens ?? 0) ? (input.promptTokens ?? 0) : 0;
  return Math.max(0, Math.floor(budget - history - prompt));
}

export interface ToolResultMessage {
  role?: string;
  content?: unknown;
  toolCalls?: unknown;
}

/**
 * A request-only view of the live slice that fits `budgetTokens`.
 *
 * Messages are never removed, and the caller's array is never mutated: the same
 * messages are persisted at the end of the run, and a tool result dropped from the
 * transcript would be lost for good. Only the bulk inside the oldest tool results
 * is replaced, walking backwards so the newest results survive.
 *
 * A message whose shape is not the expected `{ type: 'tool-result' }` list is left
 * alone: mangling a provider-specific payload is how a request becomes invalid.
 */
export function trimToolResultsForRequest<T extends ToolResultMessage>(
  messages: readonly T[],
  budgetTokens: number,
  estimate: (message: T) => number,
  stub: string = TOOL_RESULT_STUB,
): { messages: readonly T[]; stubbed: number } {
  const size = (list: readonly T[]): number => list.reduce((sum, message) => sum + estimate(message), 0);
  if (size(messages) <= budgetTokens) return { messages, stubbed: 0 };

  const next = [...messages];
  let stubbed = 0;
  // Oldest first: the newest results are the ones the model is still working from.
  for (let index = 0; index < next.length; index++) {
    if (size(next) <= budgetTokens) break;
    const message = next[index]!;
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    let changed = false;
    const content = message.content.map((part: unknown) => {
      const record = part as { type?: unknown; output?: { type?: unknown; value?: unknown } } | null;
      if (!record || record.type !== 'tool-result' || !record.output || typeof record.output !== 'object') return part;
      const value = record.output.value;
      // Small results are not worth a stub: replacing them saves nothing and costs
      // the model real information.
      if (typeof value !== 'string' || value.length <= stub.length) return part;
      changed = true;
      return { ...record, output: { ...record.output, type: 'text', value: stub } };
    });
    if (!changed) continue;
    next[index] = { ...message, content } as T;
    stubbed++;
  }
  return { messages: next, stubbed };
}
