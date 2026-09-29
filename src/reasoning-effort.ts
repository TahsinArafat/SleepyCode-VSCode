/**
 * Reasoning-effort levels for models that accept a thinking budget.
 *
 * This module has NO imports so the strip-types test runner can load it.
 *
 * The value is a per-conversation UI choice, not a global setting: the same
 * workspace can hold a fast "none" chat and a deep "max" chat side by side.
 * `none` is the default and means "send nothing", so a model that does not
 * understand the parameter is never sent one.
 */

/** Ordered weakest to strongest. `none` first so it renders as the default. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'none';

/** Short labels for the composer menu. */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** One-line hint per level, shown under the label in the menu. */
export const REASONING_EFFORT_HINTS: Record<ReasoningEffort, string> = {
  none: 'Do not send a reasoning parameter. Default.',
  minimal: 'Almost no thinking. Fastest.',
  low: 'Brief thinking for simple tasks.',
  medium: 'Balanced thinking budget.',
  high: 'Deep thinking for hard problems.',
  xhigh: 'Very deep thinking. Slowest per step.',
  max: 'Highest budget the model allows.',
};

/**
 * Models that publish an OpenAI-style `reasoning_effort` field. Matched
 * case-insensitively against the model id, because providers disagree on
 * casing and on the `openai/`-style prefix.
 */
const EFFORT_MODEL_PATTERNS = [
  /\bgpt-5\b/,
  /\bgpt-5\.\d/,
  /\bo[1-9]\b/,
  /\bo[1-9]-/,
  /\bgpt-oss\b/,
  /\bcodex\b/,
];

/** True when this model id should receive `reasoning_effort`. */
export function supportsReasoningEffort(modelId: string | undefined): boolean {
  const id = (modelId ?? '').toLowerCase();
  if (!id) return false;
  return EFFORT_MODEL_PATTERNS.some(pattern => pattern.test(id));
}

/** True when the composer should offer the dropdown at all for this model. */
export function supportsReasoningControl(modelId: string | undefined): boolean {
  return supportsReasoningEffort(modelId);
}

/** Coerce any stored/UI value into a known level, falling back to the default. */
export function normalizeReasoningEffort(raw: unknown): ReasoningEffort {
  if (typeof raw !== 'string') return DEFAULT_REASONING_EFFORT;
  const value = raw.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

/**
 * Provider request fields for a level, or `{}` when nothing should be sent.
 *
 * `none` returns `{}` on purpose: a model that does not know the field must
 * not receive it, and a model that does falls back to its own default, which
 * is the behaviour the user asked for by choosing "none".
 */
export function reasoningEffortBody(
  effort: unknown,
  modelId: string | undefined,
): Record<string, string | number> {
  const level = normalizeReasoningEffort(effort);
  if (level === DEFAULT_REASONING_EFFORT) return {};
  if (supportsReasoningEffort(modelId)) {
    // `reasoningEffort` is the AI SDK's provider-option name. The
    // OpenAI-compatible adapter serializes it as `reasoning_effort` on the
    // wire. Passing the wire spelling here would bypass the adapter schema.
    const portable = level === 'minimal' ? 'low' : level === 'max' ? 'xhigh' : level;
    return { reasoningEffort: portable };
  }
  // The model does not advertise support: send nothing rather than risk a 400.
  return {};
}

/** Compact label for the composer pill. */
export function reasoningEffortLabel(raw: unknown): string {
  return REASONING_EFFORT_LABELS[normalizeReasoningEffort(raw)];
}
