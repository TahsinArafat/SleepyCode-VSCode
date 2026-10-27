/*
 * The three settings surfaces the React window lacks: first-run setup, a
 * danger-zone reset, and the extension-log viewer.
 *
 * Two are small state machines whose entire purpose is to make an irreversible
 * action deliberate — so they are pure and pinned, because "the third click is the
 * one that wipes everything" is not something to rediscover by testing.
 *
 * The log viewer is formatting. The host has always kept these entries; nothing
 * could read them from the window.
 */

/** Clicks needed before the reset actually runs. */
export const DANGER_CONFIRM_CLICKS = 3;

/** What a reset destroys, stated before it happens. */
export const RESET_CONSEQUENCE =
  'Every SleepyCode setting returns to its default, saved API keys are deleted, and your MCP servers and custom agents are removed. Conversations are kept.';

/** True when the reset button has been pressed enough times to count. */
export function isResetArmed(clicks: number): boolean {
  return clicks >= DANGER_CONFIRM_CLICKS;
}

/** The button's text, counting down so each press visibly does something. */
export function resetLabel(clicks: number): string {
  if (clicks >= DANGER_CONFIRM_CLICKS) return 'Click again to confirm reset';
  if (clicks <= 0) return 'Reset all settings';
  const remaining = DANGER_CONFIRM_CLICKS - clicks;
  return `Click ${remaining} more time${remaining === 1 ? '' : 's'} to reset`;
}

/**
 * How long a partly-armed reset stays armed.
 *
 * Disarming on `mouseleave` looks safer and is not: the label changes on every
 * press, so the button re-renders between mousedown and mouseup and a stray leave
 * zeroes the count — the three-click gesture became unreachable. A timeout decays
 * it instead, which is forgiving and still cannot be left primed.
 */
export const RESET_ARM_TIMEOUT_MS = 4000;

/** Whether a partly-armed reset has gone stale. */
export function resetExpired(elapsedMs: number): boolean {
  return elapsedMs >= RESET_ARM_TIMEOUT_MS;
}

/**
 * The next click count.
 *
 * Leaving the button disarms, so the gesture cannot be completed later by
 * accident; clicking past the threshold stays at it rather than drifting upward.
 */
export function nextResetClicks(clicks: number, kind: 'click' | 'leave'): number {
  if (kind === 'leave') return 0;
  return Math.min(DANGER_CONFIRM_CLICKS, Math.max(0, clicks) + 1);
}

export interface LogEntry {
  timestamp?: number;
  level?: string;
  event?: string;
  detail?: string;
}

/**
 * Log entries as readable lines: time, level, event, and detail when there is one.
 *
 * Entries missing the parts that make a line useful are dropped rather than
 * printed as `undefined` — a log full of placeholders is worse than a short one.
 */
export function logLines(entries: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as LogEntry;
    if (typeof record.level !== 'string' || !record.level) continue;
    if (typeof record.event !== 'string' || !record.event) continue;
    const at = typeof record.timestamp === 'number' ? new Date(record.timestamp).toISOString() : '';
    const head = [at, record.level.toUpperCase(), record.event].filter(Boolean).join(' ');
    out.push(record.detail ? `${head}: ${record.detail}` : head);
  }
  return out;
}

/** How many lines of each level, so the panel can say why it is worth reading. */
export function logTally(entries: readonly unknown[] | undefined): { total: number; info: number; warn: number; error: number } {
  const tally = { total: 0, info: 0, warn: 0, error: 0 };
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const level = (entry as LogEntry).level;
    if (typeof level !== 'string' || !level) continue;
    tally.total++;
    if (level === 'info') tally.info++;
    else if (level === 'warn') tally.warn++;
    else if (level === 'error') tally.error++;
  }
  return tally;
}

export function logEmptyText(): string {
  return 'No entries yet. Run something and come back.';
}

// ---------------------------------------------------------------- first run

export const FIRST_RUN_TITLE = 'Set up SleepyCode';
export const FIRST_RUN_BODY =
  'Sign in to SleepyAI to use its models. You can also add a compatibility endpoint, or run a local model — nothing is required until you send a message.';
export const FIRST_RUN_ACTION = 'Sign in to SleepyAI';
export const FIRST_RUN_DISMISS = 'Not now';

/**
 * Whether an action means setup is done.
 *
 * Unblocking the extension is what ends setup — signing in, or explicitly
 * dismissing. Opening the window is not an answer, or the step is never shown
 * again to a user who is still stuck.
 */
export function completesSetup(action: string | undefined): boolean {
  return action === 'signIn' || action === 'dismiss';
}