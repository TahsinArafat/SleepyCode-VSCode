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
 *
 * A turn that crashed mid-stream keeps its answer only in `partialText` (the
 * in-flight text never reaches the step-level message list), so it is folded in
 * too: otherwise the first message after a reload cannot see work the user
 * already watched arrive.
 */
export function recoverPendingHistory<T extends HistoryMessage>(
  messages: T[] | undefined,
  pending: { userText?: string; messages?: T[]; partialText?: string } | undefined,
  maxStored: number,
): T[] | undefined {
  const pendingTail = pending?.messages ?? [];
  const partial = pending?.partialText?.trim() ?? '';
  const lastPending = pendingTail[pendingTail.length - 1];
  const partialStored = Boolean(partial) && lastPending?.role === 'assistant' && typeof lastPending.content === 'string' && lastPending.content.includes(partial);
  const tail: T[] = partial && !partialStored ? [...pendingTail, { role: 'assistant', content: partial } as T] : [...pendingTail];
  if (!tail.length) return messages;
  const existing = messages ?? [];
  if (existing.length) {
    const existingTail = existing.slice(-tail.length);
    if (sameHistoryMessages(existingTail, tail)) return existing;
  }
  let alreadyHasUser = false;
  for (let cursor = existing.length - 1; cursor >= 0; cursor--) {
    if (existing[cursor]?.role !== 'user') continue;
    alreadyHasUser = existing[cursor]?.content === (pending?.userText ?? '');
    break;
  }
  const carried: T[] = alreadyHasUser
    ? [...existing, ...tail]
    : [...existing, { role: 'user', content: pending?.userText ?? '' } as T, ...tail];
  return carried.length > maxStored ? carried.slice(-maxStored) : carried;
}

/**
 * Drop history that a strict provider will reject.
 *
 * A tool call whose result never arrived is persisted as an assistant message
 * with a `tool-call` part and no matching `tool` message. That happens whenever
 * a turn is stopped between the model emitting the call and the tool finishing
 * — the common case for "I pressed stop", and the reason repeated stops left
 * later turns failing outright. Two repairs, both conservative:
 *
 *   - an assistant `tool-call` with no result is rewritten as text, so the model
 *     still knows it asked for the tool and that it did not run;
 *   - a `tool` message with no matching call is dropped, because it can only be
 *     an orphan.
 *
 * A message with no content left after repair is removed: a provider rejects an
 * empty assistant turn just as firmly.
 */
export function dropOrphanedToolCalls<T extends HistoryMessage>(messages: readonly T[]): T[] {
  /** The tool-call ids an assistant message asked for, in either stored shape. */
  const callIdsOf = (message: HistoryMessage): string[] => {
    const ids: string[] = [];
    if (Array.isArray((message as { toolCalls?: unknown }).toolCalls)) {
      for (const call of (message as { toolCalls: { id?: unknown; toolCallId?: unknown }[] }).toolCalls) {
        const id = call?.id ?? call?.toolCallId;
        if (typeof id === 'string') ids.push(id);
      }
    }
    if (Array.isArray(message?.content)) {
      for (const part of message.content as { type?: string; toolCallId?: unknown }[]) {
        if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') ids.push(part.toolCallId);
      }
    }
    return ids;
  };
  /** The tool-call ids this message answers. */
  const resultIdsOf = (message: HistoryMessage): string[] => {
    if (message?.role !== 'tool' || !Array.isArray(message.content)) return [];
    return (message.content as { toolCallId?: unknown }[])
      .map(part => part?.toolCallId)
      .filter((id): id is string => typeof id === 'string');
  };

  const answered = new Set<string>();
  for (const message of messages) for (const id of resultIdsOf(message)) answered.add(id);

  const out: T[] = [];
  for (const message of messages) {
    if (message?.role !== 'assistant') {
      // Tool results are left in place: one whose call fell outside the window is
      // an orphan, and `safeHistoryStart`/`selectStructuredHistory` are what drop
      // that whole leading fragment. Deleting the result here would remove a
      // legitimate answer on every slice that starts mid-turn.
      out.push(message);
      continue;
    }
    const unanswered = callIdsOf(message).filter(id => !answered.has(id));
    if (!unanswered.length) {
      // An assistant message with nothing in it at all is not history, it is a
      // placeholder: providers reject an empty turn outright.
      const emptyContent = Array.isArray(message.content) && message.content.length === 0;
      if (emptyContent && !callIdsOf(message).length) continue;
      out.push(message);
      continue;
    }
    const content = Array.isArray(message.content) ? message.content as { type?: string; toolCallId?: unknown; toolName?: unknown }[] : [];
    // A call with no result becomes a note: the model still knows it asked for
    // that tool and that nothing came back, instead of the provider rejecting the
    // entire request for a tool call that is never answered.
    const repaired: unknown[] = content.map(part => {
      if (part?.type !== 'tool-call') return part;
      const id = typeof part.toolCallId === 'string' ? part.toolCallId : '';
      if (id && answered.has(id)) return part;
      return { type: 'text', text: `[The tool \`${String(part.toolName ?? 'tool')}\` was requested but did not finish, so it produced no result.]` };
    });
    // Nothing left to say at all (an empty step, or every part was an unanswered
    // call that produced no note): providers reject an empty assistant turn just
    // as firmly as an unanswered one, so it is dropped.
    if (!repaired.length && !Array.isArray((message as { toolCalls?: unknown }).toolCalls)) continue;
    const keptCalls = Array.isArray((message as { toolCalls?: unknown }).toolCalls)
      ? (message as { toolCalls: { id?: unknown; toolCallId?: unknown }[] }).toolCalls.filter(call => {
        const id = call?.id ?? call?.toolCallId;
        return typeof id === 'string' && answered.has(id);
      })
      : undefined;
    const next = { ...message, content: repaired.length ? repaired : message.content } as T & { toolCalls?: unknown };
    if (keptCalls) next.toolCalls = keptCalls;
    out.push(next);
  }
  return out;
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
  // Repaired before selection: an orphaned tool call from a stopped turn makes
  // the WHOLE request invalid, not just that turn, so it must not survive to the
  // wire. `stored` itself is left untouched — it is the conversation's history.
  const repaired = dropOrphanedToolCalls(stored);
  if (!repaired.length) return [];
  stored = repaired;
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
 * How many stored messages a budgeted selection dropped from the front.
 *
 * `selectStructuredHistory` cuts silently, which reads to the user as the agent
 * forgetting. Callers use this to say so out loud.
 */
export function droppedMessageCount<T extends HistoryMessage>(
  stored: readonly T[] | undefined,
  selected: readonly T[],
): number {
  if (!stored?.length) return 0;
  return Math.max(0, stored.length - selected.length);
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
  // Repaired on the way IN as well as on the way out: a turn stopped between a
  // tool call and its result writes exactly one orphan, and repairing only at
  // request time would leave every later reload re-reading a broken history.
  const prior = dropOrphanedToolCalls(existing ?? []);
  const lastUser = lastUserStart(prior);
  const alreadyHasUser = reuseUser && prior.length > 0 && prior[lastUser]?.role === 'user' && prior[lastUser]?.content === userText;
  const next = alreadyHasUser ? [...prior, ...produced] : [...prior, { role: 'user', content: userText } as T, ...produced];
  // The slice can also orphan the first turn's results, so repair once more
  // after trimming rather than assuming the cut landed cleanly.
  const bounded = next.length > maxStored ? next.slice(-maxStored) : next;
  return dropOrphanedToolCalls(bounded);
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
