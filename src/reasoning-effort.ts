/**
 * Reasoning-effort levels for models that accept a thinking budget.
 *
 * This module has NO imports so the strip-types test runner can load it.
 *
 * The value is a per-conversation UI choice, not a global setting: the same
 * workspace can hold a fast "none" chat and a deep "max" chat side by side.
 * The control is offered for every model -- model ids are open-ended, so any
 * allow-list would hide the choice from models it has not heard of.
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
 * Models whose provider is known to accept the OpenAI-style
 * `reasoning_effort` field.
 *
 * This is a best-effort, case-insensitive substring match against the model
 * id: providers disagree on casing and on the `openai/`-style prefix, and new
 * reasoning models ship constantly. It decides only *which* provider-option
 * key carries the level -- never whether the user may pick one. Known
 * idempotent reasoning families also accept a parameter they already default
 * to, so treating an unrecognised id as a member of this set stays harmless.
 */
const EFFORT_MODEL_PATTERNS = [
  /\bgpt-5\b/,
  /\bgpt-5\.\d/,
  /\bo[1-9]\b/,
  /\bo[1-9]-/,
  /\bgpt-oss\b/,
  /\bcodex\b/,
  /\bgpt-4\.1\b/,
  /\bgpt-4o\b/,
  /\bgpt-4-turbo\b/,
  /\bgemini\b/,
  /\bgrok\b/,
  /\bqwen/,
  /\bdeepseek/,
  /\bglm/,
  /\bminimax/,
  /\bkimi/,
  /\bmistral\b/,
  /\bmixtral\b/,
  /\bpixtral\b/,
  /\bgranite\b/,
  /\bnemotron\b/,
  /\breasoner\b/,
  /\bthinking\b/,
];

/** True when this model id is recognised as an OpenAI-style effort consumer. */
export function supportsReasoningEffort(modelId: string | undefined): boolean {
  const id = (modelId ?? '').toLowerCase();
  if (!id) return false;
  return EFFORT_MODEL_PATTERNS.some(pattern => pattern.test(id));
}

/**
 * True when the composer should offer the reasoning dropdown.
 *
 * Always. The control is available for every model, not just ones we can
 * recognise: model ids are user-supplied and the catalog grows faster than any
 * allow-list, so hiding the control stranded users on models it simply had not
 * heard of -- including models that do honour the field. Levels are additive
 * (see `reasoningEffortBody`), so choosing one is always safe.
 */
export function supportsReasoningControl(_modelId?: string | undefined): boolean {
  return true;
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
 * `none` returns `{}` on purpose: no reasoning parameter is sent at all, so a
 * model is never handed a field it does not understand and simply uses its own
 * default.
 *
 * A non-`none` level is sent for every model. Providers that do not know
 * `reasoning_effort` ignore an unknown body field, so this is additive rather
 * than destructive; the alternative (silently dropping the choice because the
 * model id was not recognised) is what made the control unusable off-list.
 */
export function reasoningEffortBody(
  effort: unknown,
  _modelId: string | undefined,
): Record<string, string | number> {
  const level = normalizeReasoningEffort(effort);
  if (level === DEFAULT_REASONING_EFFORT) return {};
  // `reasoningEffort` is the AI SDK's provider-option name. The
  // OpenAI-compatible adapter serializes it as `reasoning_effort` on the
  // wire. Passing the wire spelling here would bypass the adapter schema.
  const portable = level === 'minimal' ? 'low' : level === 'max' ? 'xhigh' : level;
  return { reasoningEffort: portable };
}

/** Compact label for the composer pill. */
export function reasoningEffortLabel(raw: unknown): string {
  return REASONING_EFFORT_LABELS[normalizeReasoningEffort(raw)];
}
