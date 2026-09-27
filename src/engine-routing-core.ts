import type { Conversation } from './types';

/**
 * Decide which engine runs a conversation's next turn.
 *
 * The rule is now fully CLI-first: when the engine is available (CLI installed
 * and reachable), every conversation goes to it — whether it is brand new,
 * already bound to a CLI session, or even carrying items that were projected
 * from a previous CLI turn.
 *
 * We no longer pin a conversation to the local agent just because it has
 * transcript items. Items in a CLI conversation are a *display mirror* of CLI
 * rows; they carry no model history the local agent could actually continue —
 * the local agent would have to restart from scratch, not resume. Treating them
 * as "local history" that blocks the CLI caused every conversation that had
 * received at least one CLI response to quietly fall back to the local agent on
 * the next send, silently forking the session into a parallel history the user
 * never chose.
 *
 * The only true local history is `messages` (the structured model input from
 * the local `ToolLoopAgent`) and `pending` (an interrupted local run). These do
 * not exist on CLI conversations; the CLI owns its own SQLite-backed history.
 *
 * `boundToSession` is checked first: a conversation already tied to a CLI
 * session stays there regardless of the engine status field, because its history
 * lives inside `sleepy.db` with no import path back to the local agent.
 */
export function usesCliEngine(input: {
  engineAvailable: boolean;
  boundToSession: boolean;
  hasLocalHistory: boolean;
}): boolean {
  if (!input.engineAvailable) return false;
  // Once a conversation is bound to a CLI session its history lives in
  // sleepy.db; always use the CLI regardless of local history state.
  if (input.boundToSession) return true;
  // New conversation with no real local history → go to the CLI.
  // "Local history" means the local ToolLoopAgent has written model messages or
  // has an interrupted run in progress; transcript items alone do not count
  // because they are populated by the CLI projection too.
  return !input.hasLocalHistory;
}

/**
 * Whether a conversation holds work the **local agent** owns.
 *
 * `messages` counts because those are the model-visible structured turns written
 * by `ToolLoopAgent`. `pending` counts because an interrupted local run must be
 * resumed locally. Plain transcript `items` and `turnUndo`/`turnRedo` snapshots
 * are NOT counted: in a CLI conversation those are display mirrors projected
 * from the CLI's rows, not evidence of local ownership.
 */
export function hasLocalHistory(conversation: Pick<Conversation, 'items' | 'messages' | 'pending'>): boolean {
  return (
    (conversation.messages?.length ?? 0) > 0 ||
    conversation.pending !== undefined
  );
}
