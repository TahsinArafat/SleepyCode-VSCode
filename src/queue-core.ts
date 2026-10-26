/*
 * The follow-up queue: ordering rules only.
 *
 * The host owns one global FIFO array of queued prompts, but the user sees the
 * queue per conversation and can reorder it. Draining prefers the first entry
 * belonging to the conversation that just finished and falls back to the head of
 * the array, so an entry's *conversation* decides when it runs — not its
 * absolute index.
 *
 * Two consequences shape everything here:
 *   - an entry moves to the slot of another entry **of its own conversation**,
 *     so a reorder never shifts a different conversation's position (that
 *     position is what decides who runs next when the current one is empty);
 *   - "already at the top" and "moved" must agree with `canMoveUp`, because the
 *     row only offers "Move earlier" when the predicate says there is somewhere
 *     to go. A visible control that does nothing is the bug this file prevents.
 *
 * Pure and dependency-free: the host, the direct test runner and any future
 * caller load it. The provider keeps the vscode-bound state.
 */

export interface QueueEntryLike {
  id: string;
  conversationId: string;
}

/** The entry the host's drain would pick for a conversation (`own ?? queue[0]`). */
export function nextFor<T extends QueueEntryLike>(queue: readonly T[], conversationId: string): T | undefined {
  return queue.find(entry => entry.conversationId === conversationId) ?? queue[0];
}

/** Drop the entry with this id. An unknown id leaves the queue untouched. */
export function removeEntry<T extends QueueEntryLike>(queue: readonly T[], id: string): T[] {
  return queue.filter(entry => entry.id !== id);
}

/**
 * Rewrite a conversation's entries into the slots that conversation already
 * occupies, so other conversations keep their absolute positions.
 */
function withConversationOrder<T extends QueueEntryLike>(queue: readonly T[], conversationId: string, order: readonly T[]): T[] {
  let index = 0;
  return queue.map(entry => (entry.conversationId === conversationId ? order[index++]! : entry));
}

/** The conversation's entries, in queue order. */
function entriesOf<T extends QueueEntryLike>(queue: readonly T[], conversationId: string): T[] {
  return queue.filter(entry => entry.conversationId === conversationId);
}

/** Make this entry the next one to run for its conversation. */
export function promoteToFront<T extends QueueEntryLike>(queue: readonly T[], id: string): T[] {
  const target = queue.find(entry => entry.id === id);
  if (!target) return [...queue];
  const entries = entriesOf(queue, target.conversationId);
  if (entries[0] === target) return [...queue];
  return withConversationOrder(queue, target.conversationId, [target, ...entries.filter(entry => entry !== target)]);
}

/** True when "Move earlier" has somewhere to go. */
export function canMoveUp<T extends QueueEntryLike>(queue: readonly T[], id: string): boolean {
  const target = queue.find(entry => entry.id === id);
  if (!target) return false;
  return entriesOf(queue, target.conversationId)[0] !== target;
}

/** Swap this entry with the previous entry of its own conversation. */
export function moveUp<T extends QueueEntryLike>(queue: readonly T[], id: string): T[] {
  const target = queue.find(entry => entry.id === id);
  if (!target) return [...queue];
  const entries = entriesOf(queue, target.conversationId);
  const at = entries.indexOf(target);
  // `at <= 0` covers both "not present" and "already first".
  if (at <= 0) return [...queue];
  const reordered = [...entries];
  reordered[at - 1] = entries[at]!;
  reordered[at] = entries[at - 1]!;
  return withConversationOrder(queue, target.conversationId, reordered);
}