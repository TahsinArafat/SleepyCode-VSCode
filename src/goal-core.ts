/**
 * Conversation goals: an objective, an optional token budget, and its status.
 *
 * The React composer shows a goal banner and lets the user pause or complete the
 * goal. SleepyCode had no goal model at all, so `setGoal`/`setGoalStatus` were
 * dropped and the banner never appeared.
 *
 * Dependency-free and pure: the host owns storage, this owns the rules —
 * including the one that matters for a budget, which is that a goal stops being
 * "active" once the budget is spent rather than silently continuing to spend.
 */

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'budgetLimited' | 'complete';

export interface ConversationGoal {
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  updatedAt: number;
}

const STATUSES: readonly GoalStatus[] = ['active', 'paused', 'blocked', 'budgetLimited', 'complete'];

/** Statuses where spending more tokens is expected. */
const SPENDING = new Set<GoalStatus>(['active', 'blocked']);

/** Create a goal, or `undefined` when there is no objective worth tracking. */
export function createGoal(objective: string | undefined, tokenBudget?: number | undefined, now = Date.now()): ConversationGoal | undefined {
  const text = (objective ?? '').trim();
  if (!text) return undefined;
  const goal: ConversationGoal = { objective: text, status: 'active', tokensUsed: 0, updatedAt: now };
  // A budget of 0 or a negative number means "no budget", not "spend nothing".
  if (typeof tokenBudget === 'number' && Number.isFinite(tokenBudget) && tokenBudget > 0) {
    goal.tokenBudget = Math.floor(tokenBudget);
  }
  return goal;
}

/** True when a bounded goal has spent its budget. */
export function overBudget(goal: ConversationGoal | undefined): boolean {
  if (!goal?.tokenBudget) return false;
  return goal.tokensUsed >= goal.tokenBudget;
}

/**
 * Add tokens to a goal.
 *
 * Spending only moves a goal that is still spending: a completed or paused goal
 * must not flip to `budgetLimited` because a late usage event arrived.
 */
export function addTokens(goal: ConversationGoal, tokens: number, now = Date.now()): ConversationGoal {
  const amount = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  if (!amount || !SPENDING.has(goal.status)) return goal;
  const tokensUsed = goal.tokensUsed + amount;
  const status: GoalStatus = goal.tokenBudget && tokensUsed >= goal.tokenBudget ? 'budgetLimited' : goal.status;
  return { ...goal, tokensUsed, status, updatedAt: now };
}

/** Apply an explicit status change; an unrecognised value is ignored. */
export function withStatus(goal: ConversationGoal, status: unknown, now = Date.now()): ConversationGoal {
  if (!STATUSES.includes(status as GoalStatus)) return goal;
  return { ...goal, status: status as GoalStatus, updatedAt: now };
}

/**
 * What the model is told about the goal.
 *
 * Returns `''` when there is no goal, so a conversation without one gets no
 * prompt noise. A budget-limited goal says to stop, because the point of a
 * budget is that the run ends rather than continuing to spend.
 */
export function goalGuidance(goal: ConversationGoal | undefined): string {
  if (!goal?.objective) return '';
  const parts = [`Active goal: ${goal.objective}.`];
  if (goal.tokenBudget) {
    const spent = Math.min(goal.tokensUsed, goal.tokenBudget);
    parts.push(`Token budget: ${spent.toLocaleString()} of ${goal.tokenBudget.toLocaleString()} used.`);
  }
  if (goal.status === 'budgetLimited') {
    parts.push('The token budget for this goal is spent. Stop starting new work, summarise what is done and what remains, and tell the user the budget is exhausted.');
  } else if (goal.status === 'paused') {
    parts.push('This goal is paused: do not start new work toward it.');
  } else if (goal.status === 'complete') {
    parts.push('This goal is already complete: do not continue working toward it.');
  } else {
    parts.push('Work toward this goal; it is the purpose of this conversation.');
  }
  return parts.join(' ');
}