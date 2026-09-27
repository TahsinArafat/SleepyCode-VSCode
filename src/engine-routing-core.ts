import type { Conversation } from './types';

/**
 * Decide which engine runs a conversation's next turn.
 *
 * The rule is deliberately one-sided. A conversation with no history yet is free
 * to go to the CLI, and one that already lives there stays there, because the
 * CLI's rows are the real record for it. But a conversation carrying leftover
 * local history is pinned to the local agent for good.
 *
 * We are not migrating those. The CLI exposes no route that accepts a history we
 * cannot hand-write: `POST /session/{id}/message` and `prompt_async` both run
 * the model, and `/import/run` only reads other tools' own on-disk formats. The
 * only way to "import" would be replaying each old turn as a fresh prompt, which
 * re-runs the model on work the user already paid for and fabricates a
 * transcript that never happened. Staying local keeps the record honest, which
 * matters more than moving it.
 *
 * `boundToSession` is checked before `hasLocalHistory` on purpose: a CLI
 * conversation's items are a display mirror of CLI rows, so they look like local
 * history and would otherwise be demoted in the middle of a conversation.
 */
export function usesCliEngine(input: {
  engineAvailable: boolean;
  boundToSession: boolean;
  hasLocalHistory: boolean;
}): boolean {
  if (!input.engineAvailable) return false;
  if (input.boundToSession) return true;
  return !input.hasLocalHistory;
}

/**
 * Whether a conversation holds work the local agent owns.
 *
 * `items` counts because a user turn that was never answered is still history the
 * user can see, and `pending` counts because an interrupted run is unfinished
 * work that must be resumed locally rather than restarted under the CLI.
 */
export function hasLocalHistory(conversation: Pick<Conversation, 'items' | 'messages' | 'pending'>): boolean {
  return (
    (conversation.items?.length ?? 0) > 0 ||
    (conversation.messages?.length ?? 0) > 0 ||
    conversation.pending !== undefined
  );
}
