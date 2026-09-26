/**
 * Pure iteration-loop helpers. This module has NO imports so it can be loaded by
 * the dependency-free direct tests (node --experimental-strip-types).
 *
 * Mid-iteration context is the live tool-call / tool-result history produced
 * during the current user turn. That history must stay attached to the next
 * model call whenever the turn continues (auto-continue after a length stop,
 * retry, or "Continue iteration"). Dropping it is the "partial context lost
 * in the middle of an iteration" bug: later steps re-read files and forget
 * earlier tool results.
 */

export function pausedByStepLimit(maxSteps: number, stepCount: number, finishReason: string): boolean {
  return maxSteps > 0 && stepCount >= maxSteps && finishReason === 'tool-calls';
}

export type HistoryMessage = {
  role?: string;
  content?: unknown;
  toolCalls?: unknown;
};

function sameHistoryMessages(left: readonly HistoryMessage[] | undefined, right: readonly HistoryMessage[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Recover a crash/reload checkpoint into durable structured history.
 *
 * Fold `pending` onto the tail whenever it is newer work than the stored
 * history. An earlier empty-history-only rule dropped in-progress turns after
 * older messages already existed.
 */
export function recoverPendingHistory<T extends HistoryMessage>(
  messages: T[] | undefined,
  pending: { userText?: string; messages?: T[] } | undefined,
  maxStored: number,
): T[] | undefined {
  if (!pending?.messages?.length) return messages;
  const existing = messages ?? [];
  const pendingTail = pending.messages;
  if (existing.length) {
    const existingTail = existing.slice(-pendingTail.length);
    if (sameHistoryMessages(existingTail, pendingTail)) return existing;
  }
  let alreadyHasUser = false;
  for (let cursor = existing.length - 1; cursor >= 0; cursor--) {
    if (existing[cursor]?.role !== 'user') continue;
    alreadyHasUser = existing[cursor]?.content === (pending.userText ?? '');
    break;
  }
  const carried: T[] = alreadyHasUser
    ? [...existing, ...pendingTail]
    : [...existing, { role: 'user', content: pending.userText ?? '' } as T, ...pendingTail];
  return carried.length > maxStored ? carried.slice(-maxStored) : carried;
}

/**
 * First index that is safe to start a provider request at.
 *
 * Strict providers reject a history that begins with a tool result or an
 * assistant tool-call turn. Walk back to the user message that owns those
 * results so a trimmed slice never orphans a tool-call id.
 */
export function safeHistoryStart(messages: readonly HistoryMessage[], start: number): number {
  let cursor = Math.max(0, start);
  while (cursor > 0 && messages[cursor]!.role !== 'user') cursor--;
  return cursor;
}

/** Index of the next user message at or after `index` (a valid cut point). */
export function nextTurnStart(messages: readonly HistoryMessage[], index: number): number {
  for (let cursor = Math.max(0, index); cursor < messages.length; cursor++) {
    if (messages[cursor]!.role === 'user') return cursor;
  }
  return messages.length;
}

/** Index of the most recent user message, or 0 when none exists. */
export function lastUserStart(messages: readonly HistoryMessage[]): number {
  for (let cursor = messages.length - 1; cursor >= 0; cursor--) {
    if (messages[cursor]!.role === 'user') return cursor;
  }
  return 0;
}

export type EstimateMessageTokens = (message: HistoryMessage) => number;

/**
 * Select the structured history that fits the token budget, cutting only at
 * user-turn boundaries so tool results stay attached to the assistant
 * message that requested them.
 */
export function selectStructuredHistory<T extends HistoryMessage>(
  stored: readonly T[] | undefined,
  budgetTokens: number,
  estimateTokens: EstimateMessageTokens,
): T[] {
  if (!stored?.length) return [];
  let start = stored.findIndex(message => message.role === 'user');
  if (start < 0) return [];
  if (start > 0) start = safeHistoryStart(stored, start);
  const aligned = stored.slice(start);
  let cost = 0;
  let cut = 0;
  for (let index = aligned.length - 1; index >= 0; index--) {
    cost += estimateTokens(aligned[index]!);
    if (cost <= budgetTokens) continue;
    // Overflowed at this message. Keep newer complete turns. If the newest
    // turn itself is oversized, keep that whole turn rather than returning
    // an empty slice — that empty cut is how mid-iteration context vanished
    // after a large tool result.
    const afterOverflow = nextTurnStart(aligned, index + 1);
    cut = afterOverflow < aligned.length ? afterOverflow : lastUserStart(aligned);
    break;
  }
  if (cut > 0) return aligned.slice(cut);
  return aligned;
}

/**
 * Append a completed user turn and the messages it produced. Always trims
 * from the front so the newest context survives the hard count bound.
 */
export function appendConversationMessages<T extends HistoryMessage>(
  existing: readonly T[] | undefined,
  userText: string,
  produced: readonly T[],
  maxStored: number,
  reuseUser = false,
): T[] {
  const prior = existing ?? [];
  const lastUser = lastUserStart(prior);
  const alreadyHasUser = reuseUser && prior.length > 0 && prior[lastUser]?.role === 'user' && prior[lastUser]?.content === userText;
  const next = alreadyHasUser ? [...prior, ...produced] : [...prior, { role: 'user', content: userText } as T, ...produced];
  return next.length > maxStored ? next.slice(-maxStored) : next;
}

/**
 * Messages to send on the next model call of the current turn.
 *
 * Prior conversation history plus any live messages already produced in this
 * iteration (tool calls and their results) stay attached. Resume/auto-continue
 * used to drop that live slice and send only a text prompt, which is how
 * partial context disappeared mid-iteration.
 */
export function iterationRequestMessages<T extends HistoryMessage>(
  priorHistory: readonly T[],
  liveMessages: readonly T[],
  prompt: string,
): T[] {
  const live = liveMessages.length ? [...liveMessages] : [];
  return [...priorHistory, ...live, { role: 'user', content: prompt } as T];
}
