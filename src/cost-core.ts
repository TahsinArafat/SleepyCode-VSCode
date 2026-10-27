/*
 * What a turn cost, and how full the window is.
 *
 * The classic composer showed a per-request cost from the account's model prices,
 * a session total, throughput, and a measured context readout. The React UI shows
 * a context ring and nothing else — no cost anywhere, chat or settings.
 *
 * The arithmetic is where the mistakes live, so it is pure and pinned:
 *
 *   - prompt tokens INCLUDE cache reads, so billing the whole prompt at the input
 *     rate overcharges every cached turn. The legacy implementation already knew
 *     this and split the count; that split is preserved here.
 *   - cache WRITES are billed on top of the prompt, not inside it, so they are
 *     added separately and never double-counted.
 *   - an unpriced model reports NO cost rather than a zero one, because "$0.00"
 *     reads as "this was free" and a session total that silently omits a model
 *     says the session was cheaper than it was.
 */

export interface ModelPrice {
  modelId: string;
  name: string;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostBreakdown {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
}

/** The price for a model, matched on id or display name. */
export function findPrice(prices: readonly ModelPrice[] | undefined, model: string | undefined): ModelPrice | undefined {
  if (!Array.isArray(prices) || !model) return undefined;
  return prices.find(entry => entry && typeof entry === 'object' && (entry.modelId === model || entry.name === model));
}

/**
 * The cost of one request, or null when it cannot be priced.
 *
 * `total` is null in the caller's summary, not here: a single request with no
 * prices returns null so it contributes no cost rather than a zero.
 */
export function costOf(tokens: TokenCounts | undefined, price: ModelPrice | undefined): CostBreakdown | null {
  if (!tokens || !price) return null;
  const hasInput = typeof price.inputPrice === 'number';
  const hasOutput = typeof price.outputPrice === 'number';
  // Both ends are needed: half a price cannot produce a whole figure.
  if (!hasInput || !hasOutput) return null;
  const input = Math.max(0, tokens.input || 0);
  const output = Math.max(0, tokens.output || 0);
  const cacheWrite = Math.max(0, tokens.cacheWrite || 0);
  if (!input && !output && !cacheWrite) return null;

  const inputPrice = price.inputPrice!;
  const outputPrice = price.outputPrice!;
  // A provider that does not price caching separately charges it as input.
  const cacheReadPrice = typeof price.cacheReadPrice === 'number' ? price.cacheReadPrice : inputPrice;
  const cacheWritePrice = typeof price.cacheWritePrice === 'number' ? price.cacheWritePrice : inputPrice;

  // Never bill more cached reads than there were prompt tokens.
  const cachedRead = Math.min(Math.max(0, tokens.cacheRead || 0), input);
  const uncachedInput = input - cachedRead;

  const result: CostBreakdown = {
    input: uncachedInput * (inputPrice / 1e6),
    cacheRead: cachedRead * (cacheReadPrice / 1e6),
    cacheWrite: cacheWrite * (cacheWritePrice / 1e6),
    output: output * (outputPrice / 1e6),
    total: 0,
  };
  result.total = result.input + result.cacheRead + result.cacheWrite + result.output;
  return result;
}

/**
 * A cost with enough precision to be useful.
 *
 * A small turn costs a fraction of a cent, and "$0.00" would say nothing about it.
 * Costs below a cent get more decimals; larger ones do not need them.
 */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.001) return '$' + value.toFixed(5);
  if (value < 0.01) return '$' + value.toFixed(4);
  return '$' + value.toFixed(2);
}

/** Abbreviate a token count the way the classic pills did. */
export function formatTokens(value: number | null | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (n >= 1e6) return trimZeros((n / 1e6).toFixed(2)) + 'M';
  if (n >= 1e3) return trimZeros((n / 1e3).toFixed(1)) + 'k';
  return String(Math.round(n));
}

function trimZeros(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** How full the context window is, as a percentage clamped to 0–100. */
export function contextPercent(used: number | undefined, limit: number | undefined): number {
  const total = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : 0;
  if (!total) return 0;
  const value = typeof used === 'number' && Number.isFinite(used) ? used : 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

/**
 * The band the readout is in.
 *
 * The colour is the only signal that a turn is about to be trimmed, so the
 * boundaries are explicit and pinned.
 */
export function contextLevel(percent: number): 'safe' | 'warn' | 'danger' {
  if (percent >= 80) return 'danger';
  if (percent >= 50) return 'warn';
  return 'safe';
}

export interface SessionSummary {
  tokens: TokenCounts;
  cost: { input: number; cacheRead: number; cacheWrite: number; output: number; total: number | null };
}

/**
 * Totals across a session's requests.
 *
 * `total` is null as soon as ANY contributing model could not be priced: a figure
 * that silently omits part of the session understates it, which is worse than
 * saying it is unknown.
 */
export function sessionSummary(
  entries: readonly { model?: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }[] | undefined,
  prices: readonly ModelPrice[] | undefined,
): SessionSummary {
  const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 as number | null };
  let priceable = true;

  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const slice: TokenCounts = {
      input: Math.max(0, entry.input ?? 0),
      output: Math.max(0, entry.output ?? 0),
      cacheRead: Math.max(0, entry.cacheRead ?? 0),
      cacheWrite: Math.max(0, entry.cacheWrite ?? 0),
    };
    tokens.input += slice.input;
    tokens.output += slice.output;
    tokens.cacheRead += slice.cacheRead;
    tokens.cacheWrite += slice.cacheWrite;

    const breakdown = costOf(slice, findPrice(prices, entry.model));
    if (breakdown) {
      cost.input += breakdown.input;
      cost.cacheRead += breakdown.cacheRead;
      cost.cacheWrite += breakdown.cacheWrite;
      cost.output += breakdown.output;
    } else if (slice.input || slice.output || slice.cacheWrite) {
      // Tokens were spent and could not be priced.
      priceable = false;
    }
  }

  const spent = tokens.input || tokens.output || tokens.cacheWrite;
  cost.total = !spent || !priceable ? null : cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
  return { tokens, cost };
}

/** Throughput, or null when the provider did not report one. */
export function formatSpeed(tokensPerSecond: number | undefined): string | null {
  if (typeof tokensPerSecond !== 'number' || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;
  return `${Math.round(tokensPerSecond)} tok/s`;
}

// ---------------------------------------------------------------- the one readout

/**
 * A window size used only when the model does not advertise one. A zero limit
 * means "not reported", not "no window": dividing by it would paint a full ring
 * and claim Infinity%.
 */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

export interface RingRow {
  label: string;
  value: string;
}

export interface RingReadout {
  used: number;
  limit: number;
  percent: number;
  level: 'safe' | 'warn' | 'danger';
  /** "45k / 200k · 23%", the context line the popover leads with. */
  context: string;
  /** One sentence with every fact a screen reader needs, for the arc itself. */
  label: string;
  /** The session figures, in a fixed order, omitting rows with nothing to say. */
  rows: RingRow[];
}

/**
 * Everything the composer's single session readout shows.
 *
 * The ring is the whole readout now: how full the window is, and what the
 * session has spent. Keeping the arithmetic here rather than in the component is
 * what makes the arc and the figures provably read the same numbers.
 */
export function ringReadout(input: {
  usedTokens?: number;
  contextLimit?: number;
  tokens?: Partial<TokenCounts>;
  cost?: { total?: number | null };
  speed?: number;
}): RingReadout {
  const limit = typeof input.contextLimit === 'number' && Number.isFinite(input.contextLimit) && input.contextLimit > 0
    ? input.contextLimit
    : DEFAULT_CONTEXT_LIMIT;
  const used = typeof input.usedTokens === 'number' && Number.isFinite(input.usedTokens) && input.usedTokens > 0
    ? input.usedTokens
    : 0;
  const percent = contextPercent(used, limit);
  const level = contextLevel(percent);
  const context = `${formatTokens(used)} / ${formatTokens(limit)} · ${percent}%`;
  const cost = formatCost(input.cost?.total);

  const tokens = input.tokens ?? {};
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const speed = formatSpeed(input.speed);

  const rows: RingRow[] = [
    { label: 'Input', value: formatTokens(tokens.input) + (cacheRead > 0 ? ` · ${formatTokens(cacheRead)} cached` : '') },
    { label: 'Output', value: formatTokens(tokens.output) },
    ...(cacheWrite > 0 ? [{ label: 'Cache write', value: formatTokens(cacheWrite) }] : []),
    // Cost is always a row: an unpriced model must say so rather than omit what
    // it could not measure.
    { label: 'Cost', value: cost },
    ...(speed ? [{ label: 'Speed', value: speed }] : []),
  ];

  return {
    used,
    limit,
    percent,
    level,
    context,
    label: `Session usage: ${percent}% of the context window used (${formatTokens(used)} / ${formatTokens(limit)} tokens), ${cost}`,
    rows,
  };
}
// ---------------------------------------------------------------- session records

/** The conversation a stored usage record belongs to, or '' when unscoped. */
export function recordConversation(record: { conversationId?: unknown } | undefined | null): string {
  const id = record?.conversationId;
  return typeof id === 'string' ? id : '';
}

/**
 * The records for one conversation, oldest first.
 *
 * Records written before the id existed are unscoped and belong to no
 * conversation, so they are excluded rather than attributed to whichever
 * conversation happens to be open.
 */
export function recordsFor<
  T extends { conversationId?: unknown; timestamp?: number },
>(records: readonly T[] | undefined, conversationId: string): T[] {
  if (!conversationId || !Array.isArray(records)) return [];
  return records
    .filter(record => record && typeof record === 'object' && recordConversation(record) === conversationId)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/** The speed of the most recent request, for the live readout. */
export function latestSpeed(records: readonly { timestamp?: number; tokensPerSecond?: number }[] | undefined): number | undefined {
  let best: { timestamp: number; speed: number } | undefined;
  for (const record of records ?? []) {
    if (typeof record?.tokensPerSecond !== 'number' || record.tokensPerSecond <= 0) continue;
    const timestamp = record.timestamp ?? 0;
    if (!best || timestamp > best.timestamp) best = { timestamp, speed: record.tokensPerSecond };
  }
  return best?.speed;
}
