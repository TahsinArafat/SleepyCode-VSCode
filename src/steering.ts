/*
 * Mid-run steering: guidance for the task in progress.
 *
 * A message sent while a run is working used to be either a queued follow-up (a
 * new turn, once the current one ends) or, from the queue's own control, an
 * abort-and-restart that threw away the run and started over. Neither is what
 * the user means: they are correcting the task they already started.
 *
 * So steering is its own kind of queue entry. It sits in the same queue, it is
 * consumed by the run that is working (see `drainSteering` at the top of each
 * step in `src/agent.ts`), and it never begins a run of its own.
 *
 * DOM-free and host-free so the framing and the queue arithmetic are assertable
 * directly; `test/steering.direct.mjs` holds both.
 */

/** A queued item that is guidance for the running task rather than a new turn. */
export interface SteeringEntry {
  id: string;
  text: string;
  conversationId: string;
  steering?: true;
}

/**
 * How mid-run guidance reaches the model.
 *
 * Without the framing the update reads as a brand-new instruction and the model
 * restarts the task from an empty head — which is exactly the behaviour this
 * feature exists to avoid — so the "continue from where you are" sentence is
 * part of the payload, not decoration.
 */
export function steeringGuidance(text: string): string {
  return `<user_update>\nThe user added this while you were working. It is an update to the current task, not a new request: take it into account and continue from where you are.\n\n${text}\n</user_update>`;
}

/** The steering entries waiting for this conversation, in arrival order. */
export function steeringEntries<T extends SteeringEntry>(queue: readonly T[], conversationId: string): T[] {
  return queue.filter((entry) => entry.conversationId === conversationId && entry.steering === true);
}

/** Split the queue into the guidance this conversation can consume now, and the rest. */
export function takeSteering<T extends SteeringEntry>(queue: readonly T[], conversationId: string): { taken: T[]; rest: T[] } {
  const taken: T[] = [];
  const rest: T[] = [];
  for (const entry of queue) {
    if (entry.conversationId === conversationId && entry.steering === true) taken.push(entry);
    else rest.push(entry);
  }
  return { taken, rest };
}