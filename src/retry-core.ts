/**
 * One retry policy for every layer that resends work.
 *
 * The provider fetch wrapper and the run loop previously kept three separate
 * budgets (auth / not-found / transient), each with its own counter and backoff
 * curve. Stacked, they multiplied into 14 sends per request and 11 restarts per
 * turn, and the user-visible "Reconnecting n/max" row disagreed between layers.
 *
 * Both layers now draw from one budget created per turn, with one backoff curve
 * and one label vocabulary. A failing turn therefore has a single, bounded,
 * predictable amount of work instead of a product of unrelated limits.
 *
 * The budget counts a *streak*, not a lifetime: any completed exchange calls
 * `succeed()` and the streak restarts, so one flapping request early in a turn
 * cannot spend the retries a genuinely broken gateway needs later. A separate
 * ceiling caps the whole turn, so a flapping gateway still cannot retry forever.
 */

/** Why a request or a whole attempt is being resent. */
export type RetryKind =
  /** The gateway refused our credentials (401/403). First-party only: a rotated token is recovered instead of being reported as a sign-out. */
  | 'auth'
  /** 404 on a request that is safe to replay (a read), so an edge still routing to the old catalog can settle. */
  | 'not_ready'
  /** 408/409/429/5xx or a transport failure. */
  | 'transient';

/** Consecutive retries allowed before a turn gives up. Reset by any success. */
export const MAX_RUN_RETRIES = 6;

/** Title for the card shown only when a turn could not be recovered. */
export const AUTH_ERROR_TITLE = 'SleepyAI could not verify this session';

/**
 * The single backoff curve: fast enough that a rotated token is picked up within
 * half a second, long enough that a flapping gateway is not hammered. It follows
 * the streak, so a fresh streak starts fast again instead of inheriting a long wait.
 */
export function retryBackoffMs(attempt: number): number {
  return Math.min(15_000, 500 * Math.pow(2, Math.max(0, attempt - 1)));
}

/**
 * Why a response should be resent, or undefined when it has to be surfaced.
 *
 * `replayable` must only be set for requests without a body to repeat (a read),
 * so a prompt or tool call is never resent blindly on a 404.
 */
export function retryKindForStatus(status: number, options: { replayable?: boolean; isFirstParty?: boolean }): RetryKind | undefined {
  if (options.isFirstParty && (status === 401 || status === 403)) return 'auth';
  if (status === 404 && options.replayable) return 'not_ready';
  if (status === 408 || status === 409 || status === 429 || status >= 500) return 'transient';
  return undefined;
}

/** One short sentence for the "Reconnecting n/max" row: what failed, and what happens next. */
export function retryMessage(options: { kind: RetryKind; status?: number; detail?: string; recovered?: boolean }): string {
  const head = options.status ? `HTTP ${options.status}` : 'Request failed';
  if (options.kind === 'auth') return `${head}: SleepyAI session ${options.recovered ? 'refreshed' : 'refresh unavailable'}`;
  if (options.kind === 'not_ready') return `${head}: endpoint or model not ready yet`;
  return options.detail ? `${head}: ${options.detail}` : head;
}

export type RetryDecision = {
  kind: RetryKind;
  /** Position in the current streak, 1-based. This is the number the user sees. */
  attempt: number;
  max: number;
  backoffMs: number;
  message: string;
};

export type RetryBudget = {
  /** Consecutive retries allowed; the streak resets on every success. */
  readonly max: number;
  /** Retries spent in the current streak. */
  readonly spent: number;
  /** Retries spent by this turn in total. Never resets; bounded by `totalMax`. */
  readonly total: number;
  readonly totalMax: number;
  /** Spend one retry, or return undefined when the turn has no budget left. */
  take: (kind: RetryKind, message: string) => RetryDecision | undefined;
  /** Report a completed exchange: the streak, its numbering, and its backoff all restart. */
  succeed: () => void;
};

/** Create the one budget a turn shares across every layer that resends work. */
export function createRetryBudget(max: number = MAX_RUN_RETRIES, totalMax: number = max * 2): RetryBudget {
  let spent = 0;
  let total = 0;
  return {
    max,
    totalMax,
    get spent() {
      return spent;
    },
    get total() {
      return total;
    },
    take(kind: RetryKind, message: string): RetryDecision | undefined {
      if (spent >= max || total >= totalMax) return undefined;
      spent++;
      total++;
      return { kind, attempt: spent, max, backoffMs: retryBackoffMs(spent), message };
    },
    succeed(): void {
      spent = 0;
    },
  };
}