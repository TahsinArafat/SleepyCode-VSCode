/**
 * Per-model option overrides.
 *
 * The React model picker lets the user edit options for a model and posts
 * `saveModelOptions` / `resetModelOptions`. SleepyCode had no such store, so
 * both were dropped and the editor had nothing to read or write.
 *
 * Only options SleepyCode can actually act on are modelled: the context window
 * and the output limit, both of which change how a request is budgeted. An
 * unknown key is ignored rather than stored hopefully.
 *
 * Dependency-free and pure: the host owns storage, this owns the rules.
 */

export interface ModelOverrides {
  max_context?: number;
  max_output?: number;
}

export type OverrideStore = Record<string, ModelOverrides>;

/** A picker entry in the shape the webview renders. */
export interface ModelOptionInfo {
  key: string;
  label: string;
  description?: string;
  type: 'select';
  values: string[];
  value: string;
}

/** Windows offered for `max_context`; the discovered value is added alongside. */
const CONTEXT_CHOICES = [32_000, 64_000, 128_000, 200_000, 400_000, 1_000_000];
const OUTPUT_CHOICES = [4_000, 8_000, 16_000, 32_000, 64_000];

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Accept only what can be acted on.
 *
 * `globalState` is a trust boundary, so anything unexpected is dropped rather
 * than passed through to a budget calculation.
 */
export function normalizeOverrides(stored: unknown): OverrideStore {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out: OverrideStore = {};
  for (const [modelId, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const overrides: ModelOverrides = {};
    const context = positiveInteger(entry.max_context);
    const output = positiveInteger(entry.max_output);
    if (context) overrides.max_context = context;
    if (output) overrides.max_output = output;
    if (Object.keys(overrides).length) out[modelId] = overrides;
  }
  return out;
}

/**
 * Apply overrides to the limits discovered from the provider.
 *
 * An override only adjusts a limit that was actually discovered: inventing a
 * context window for a model that reports none would mis-budget every request.
 */
export function applyOverrides(
  discovered: { contextWindow?: number; maxOutputLimit?: number },
  overrides: ModelOverrides | undefined,
): { contextWindow?: number; maxOutputLimit?: number } {
  const applied = { ...discovered };
  const context = positiveInteger(overrides?.max_context);
  const output = positiveInteger(overrides?.max_output);
  if (context && applied.contextWindow) applied.contextWindow = context;
  if (output && applied.maxOutputLimit) applied.maxOutputLimit = output;
  return applied;
}

/** The options to offer for a model, given what is known about it. */
export function optionsFor(
  discovered: { contextWindow?: number; maxOutputLimit?: number },
  overrides: ModelOverrides | undefined,
): ModelOptionInfo[] {
  const list: ModelOptionInfo[] = [];
  const window = positiveInteger(overrides?.max_context) ?? positiveInteger(discovered.contextWindow);
  if (window) {
    list.push({
      key: 'max_context',
      label: 'Context window',
      description: 'Tokens the model can see at once. Changes how a request is budgeted.',
      type: 'select',
      values: [...new Set([...CONTEXT_CHOICES, window])].sort((a, b) => a - b).map(String),
      value: String(window),
    });
  }
  const output = positiveInteger(overrides?.max_output) ?? positiveInteger(discovered.maxOutputLimit);
  if (output) {
    list.push({
      key: 'max_output',
      label: 'Max output',
      description: 'Tokens the model may produce in one response.',
      type: 'select',
      values: [...new Set([...OUTPUT_CHOICES, output])].sort((a, b) => a - b).map(String),
      value: String(output),
    });
  }
  return list;
}

/** Remove one model's overrides, leaving the others alone. */
export function resetModel(store: OverrideStore, modelId: string): OverrideStore {
  const next = { ...store };
  delete next[modelId];
  return next;
}

/** Record overrides for one model, dropping any that cannot be acted on. */
export function setModel(store: OverrideStore, modelId: string, values: Record<string, unknown>): OverrideStore {
  const accepted = normalizeOverrides({ [modelId]: values })[modelId];
  const next = { ...store };
  // An empty edit clears the entry rather than storing an empty object.
  if (!accepted) delete next[modelId];
  else next[modelId] = accepted;
  return next;
}