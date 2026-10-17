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
 */

/** Why a request or a whole attempt is being resent. */
export type RetryKind =
  /** The gateway refused our credentials (401/403). First-party only: a rotated token is recovered instead of being reported as a sign-out. */
  | 'auth'
  /** 404 on a request that is safe to replay (a read), so an edge still routing to the old catalog can settle. */
  | 'not_ready'
  /** 408/409/429/5xx or a transport failure. */
  | 'transient';

/** Total retries a single turn may spend, shared by the request layer and the run loop. */
export const MAX_RUN_RETRIES = 6;

/** Title for the card shown only when a turn could not be recovered. */
export const AUTH_ERROR_TITLE = 'SleepyAI could not verify this session';

/**
 * The single backoff curve: fast enough that a rotated token is picked up within
 * half a second, long enough that a flapping gateway is not hammered.
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
  attempt: number;
  max: number;
  backoffMs: number;
  message: string;
};

export type RetryBudget = {
  readonly max: number;
  readonly spent: number;
  /** Spend one retry, or return undefined when the turn has no budget left. */
  take: (kind: RetryKind, message: string) => RetryDecision | undefined;
};

/** Create the one budget a turn shares across every layer that resends work. */
export function createRetryBudget(max: number = MAX_RUN_RETRIES): RetryBudget {
  let spent = 0;
  return {
    max,
    get spent() {
      return spent;
    },
    take(kind: RetryKind, message: string): RetryDecision | undefined {
      if (spent >= max) return undefined;
      spent++;
      return { kind, attempt: spent, max, backoffMs: retryBackoffMs(spent), message };
    },
  };
}