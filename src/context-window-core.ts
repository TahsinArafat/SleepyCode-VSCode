/**
 * One answer to "how large is this model's context window?"
 *
 * Two callers need this number and they must not disagree: the extension host, which
 * decides how much stored history a request may carry and when to auto-compact, and the
 * webview, which renders `occupied / window` in the session meter.
 *
 * They used to answer it separately. The host read only the provider's model catalog and,
 * when that catalog had nothing for the model (it is empty until `refreshModels` has
 * succeeded, and many compatible endpoints report no window at all), fell back to a
 * deliberately conservative 60k send budget. The webview read the catalog, then
 * SleepyAI's price list, then guessed from the model name. So the meter could read
 * "150k / 1M" beside a request that had just dropped 400 stored messages to fit inside
 * 60k. Every source and the name guess now live here, and the in-page copy is generated
 * from the same rules, so a budget and a meter built from this module agree by
 * construction.
 *
 * Priority is fixed and matters:
 *   1. what the provider reported for this exact model (authoritative),
 *   2. SleepyAI's price list for this exact model (authoritative for first-party models),
 *   3. the model-id families below (a guess, but the same guess the UI already shipped).
 *
 * A window guessed too large is the one dangerous value here: it turns "trim the request"
 * into a hard `context_too_large` failure. That is why a model that matches no source and
 * no family returns `undefined` and the caller keeps its conservative fallback, and why no
 * caller substitutes another model's window.
 */

export type ContextWindowSource = 'learned' | 'reported' | 'price' | 'inferred';

/** Model ids that spell out a 256k-class window, or the families that ship one. */
const SMALL_WINDOW_TOKENS = 256_000;

/** Model ids in the 1M-class families (Gemini/Flash/Pro routes). */
const LARGE_WINDOW_TOKENS = 1_000_000;

function positiveTokens(value?: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Context window implied by the model id alone, or `undefined` when the name says nothing.
 *
 * This is the same guess the webview has always shown in its meter. It is only consulted
 * after the authoritative sources come up empty, so it can only ever fill a gap.
 */
export function inferContextWindow(modelId?: string | null): number | undefined {
  const id = String(modelId ?? '').toLowerCase();
  if (!id) return undefined;
  if (/256k|quick|deepseek|mimo|macaron/.test(id)) return SMALL_WINDOW_TOKENS;
  if (/flash|gemini|pro/.test(id)) return LARGE_WINDOW_TOKENS;
  return undefined;
}

/**
 * The window to use for a model, plus where the number came from.
 *
 * `learned` is what the provider itself said when it rejected a request for being too
 * large, and it comes first: a catalog can be stale or generic (many compatibility
 * endpoints report nothing at all, and a relay in front of several vendors cannot
 * describe all of them), while the rejection names the real limit for this exact
 * endpoint and model.
 *
 * `source` exists so callers and tests can tell an authoritative window from a guess; the
 * budget itself does not branch on it.
 */
export function pickContextWindow(
  reportedWindow?: number | null,
  priceWindow?: number | null,
  modelId?: string | null,
  learnedWindow?: number | null,
): { window?: number; source?: ContextWindowSource } {
  const learned = positiveTokens(learnedWindow);
  if (learned) return { window: learned, source: 'learned' };
  const reported = positiveTokens(reportedWindow);
  if (reported) return { window: reported, source: 'reported' };
  const price = positiveTokens(priceWindow);
  if (price) return { window: price, source: 'price' };
  const inferred = inferContextWindow(modelId);
  return inferred ? { window: inferred, source: 'inferred' } : {};
}

/**
 * A context window read out of a provider's own rejection, or `undefined`.
 *
 * Every vendor words "your request does not fit" differently, and the number in it is
 * the one authoritative figure available for an endpoint whose catalog says nothing.
 * Learning it turns a permanent failure into a budget: the next request is compacted
 * against the real limit instead of a guess, and the caller persists it per model so
 * the fix survives a reload.
 *
 * Only a number that could plausibly be a window is accepted (at least 1000, under
 * 20M), so a message about "3 tokens" or an error code cannot invent one.
 */
export function contextWindowFromError(message: string | undefined | null): number | undefined {
  const text = String(message ?? '');
  if (!text) return undefined;
  const patterns = [
    // [OI] and compatible: "This model's maximum context length is 128000 tokens."
    /maximum context length is\s*([\d,]+)/i,
    // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum"
    /tokens?\s*>\s*([\d,]+)\s*maximum/i,
    // Gemini: "input token count exceeds the maximum number of tokens allowed: 1048576"
    /maximum number of tokens allowed:?\s*([\d,]+)/i,
    // "context window of 32768", "context length 8192", "max context: 200000"
    /context (?:window|length)\s*(?:of|is|:|=)?\s*([\d,]{4,})/i,
    // "context 8192 exceeded" — the bare word, but not "in the context of 2024", which
    // says "of" between the word and the number and is the one shape that could be prose.
    /context\s*[:=]?\s*([\d,]{4,})(?!\s*\.?\d)/i,
    /(?:max|maximum) context(?:\s*(?:window|length|size))?\s*(?:of|is|:|=)\s*([\d,]{4,})/i,
    // "limit of 65536 tokens", "maximum of 131072 tokens"
    /(?:limit|maximum|max) of\s*([\d,]{4,})\s*tokens?/i,
    // "reduce the length of the messages ... 16385 token context"
    /([\d,]{4,})\s*token (?:context|window|limit)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value) && value >= 1_000 && value <= 20_000_000) return Math.floor(value);
  }
  return undefined;
}

/**
 * `inferContextWindow` as browser source, injected into the webview template.
 *
 * The meter must return the same answer as the host or it will keep promising a window
 * the send budget does not spend, so the rules above are compiled into the page rather
 * than hand-copied. `0` is the in-page "no idea" value; the caller keeps its own default.
 */
export const CONTEXT_WINDOW_INFER_SOURCE = String.raw`function inferContextWindow(modelId){const id=String(modelId==null?'':modelId).toLowerCase();if(!id)return 0;if(/256k|quick|deepseek|mimo|macaron/.test(id))return ${SMALL_WINDOW_TOKENS};if(/flash|gemini|pro/.test(id))return ${LARGE_WINDOW_TOKENS};return 0}`;
