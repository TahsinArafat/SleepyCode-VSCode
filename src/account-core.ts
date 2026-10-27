/*
 * The SleepyAI account readout.
 *
 * The account existed everywhere except the UI: the host signs in, refreshes a
 * token, and already knows the tier — and the settings window had no section for
 * any of it, so the only way to see or change the account was a banner in the
 * chat. There was no sign-out at all.
 *
 * Every figure here is optional because the provider reports what it reports: a
 * missing limit is left out rather than drawn as zero, which would read as "you
 * have used nothing" instead of "this is not known".
 */

import { contextLevel, formatTokens } from './cost-core.ts';

export interface AccountLimits {
  usedTokensToday?: number;
  tokensPerDay?: number;
  cost5h?: number;
  limit5h?: number;
  cost24h?: number;
  limit24h?: number;
  costWeekly?: number;
  limitWeekly?: number;
  costMonthly?: number;
  limitMonthly?: number;
}

export interface AccountView {
  loggedIn?: boolean;
  email?: string;
  tier?: string;
  limits?: AccountLimits;
  balances?: { credits?: number; currency?: string };
  subscription?: { plan?: string; status?: string; monthlySpend?: number; monthlyLimit?: number };
}

export interface AccountRow {
  label: string;
  value: string;
  /** 0–100, only when the figure is a share of a known limit. */
  percent?: number;
  level?: 'safe' | 'warn' | 'danger';
  /**
   * Which page shows it. Usage & Quota answers "what is left", the account page
   * answers "who am I and what do I owe" — showing the same rows on both is how a
   * readout starts looking duplicated.
   */
  group: 'limits' | 'billing';
}

export interface AccountSummary {
  signedIn: boolean;
  /** "you@example.com" or a plain statement when signed out. */
  identity: string;
  plan: string;
  rows: AccountRow[];
}

function money(value: number | undefined, currency = 'USD'): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const symbol = currency === 'USD' ? '$' : '';
  return `${symbol}${value.toFixed(2)}${symbol ? '' : ' ' + currency}`;
}

function share(used: number | undefined, limit: number | undefined): Pick<AccountRow, 'percent' | 'level'> {
  if (typeof used !== 'number' || typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return {};
  const percent = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  return { percent, level: contextLevel(percent) };
}

/** A spend-vs-limit row, or nothing when either end is unknown. */
function spendRow(label: string, spent: number | undefined, limit: number | undefined, currency?: string): AccountRow | null {
  const left = money(spent, currency);
  const right = money(limit, currency);
  if (!left || !right) return null;
  return { label, value: `${left} / ${right}`, group: 'limits', ...share(spent, limit) };
}

/**
 * What the account section shows.
 *
 * The first-party token allowance is the headline: it is the one limit that
 * silently stops free models working, and it was only visible in the classic
 * webview's popover.
 */
export function accountSummary(account: AccountView | undefined): AccountSummary {
  if (!account || account.loggedIn !== true) {
    return {
      signedIn: false,
      identity: 'Not signed in',
      plan: '',
      rows: [],
    };
  }

  const limits = account.limits ?? {};
  const rows: AccountRow[] = [];

  if (typeof limits.usedTokensToday === 'number' && typeof limits.tokensPerDay === 'number') {
    rows.push({
      label: 'Free tokens today',
      value: `${formatTokens(limits.usedTokensToday)} / ${formatTokens(limits.tokensPerDay)}`,
      group: 'limits',
      ...share(limits.usedTokensToday, limits.tokensPerDay),
    });
  }
  // There is no requests-per-day figure. The provider's `limit24h` is a COST
  // ceiling, and reporting it as a request count invented a number the account
  // does not have.

  for (const [label, spent, limit] of [
    ['Spend, last 5 hours', limits.cost5h, limits.limit5h],
    ['Spend, last 24 hours', limits.cost24h, limits.limit24h],
    ['Spend, this week', limits.costWeekly, limits.limitWeekly],
    ['Spend, this month', limits.costMonthly, limits.limitMonthly],
  ] as const) {
    const row = spendRow(label, spent, limit);
    if (row) rows.push(row);
  }

  const credits = money(account.balances?.credits, account.balances?.currency);
  if (credits) rows.push({ label: 'Credits', value: credits, group: 'billing' });

  const subscription = account.subscription;
  const subscriptionRow = spendRow('Plan usage this month', subscription?.monthlySpend, subscription?.monthlyLimit);
  // Billing, not a limit you are about to hit.
  if (subscriptionRow) rows.push({ ...subscriptionRow, group: 'billing' });

  return {
    signedIn: true,
    identity: account.email || 'Signed in',
    plan: account.subscription?.plan || account.tier || '',
    rows,
  };
}