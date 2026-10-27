/*
 * Controls for compaction.
 *
 * The React compaction marker is passive: it reports that earlier conversation was
 * summarized and can be expanded, but nothing can be done about it. The classic
 * webview had Cancel while summarizing, Undo to restore the full conversation,
 * Redo to re-apply it, and a manual `/compact`.
 *
 * Each action here is paired with the messages it posts, and `enabled` is derived
 * from whether those messages exist. Availability comes from what the host
 * reports — `undoable`/`redoable` are stack state the webview cannot infer, and
 * guessing would offer Undo whenever a divider was visible, which is not the same
 * thing.
 */

export interface CompactionContext {
  conversationId?: string;
  /** A turn is in flight; the host refuses to compact or rewind then. */
  running?: boolean;
  /** A compaction is in progress right now. */
  compacting?: boolean;
  /** The host has a compaction to undo. */
  undoable?: boolean;
  /** The host has an undone compaction to re-apply. */
  redoable?: boolean;
}

export type CompactionActionId = 'compact' | 'cancel' | 'undo' | 'redo';

const ACTIONS: { id: CompactionActionId; label: string; hint: string }[] = [
  { id: 'compact', label: 'Compact now', hint: 'Summarize earlier messages to free context.' },
  { id: 'cancel', label: 'Cancel compaction', hint: 'Stop the summary that is running.' },
  { id: 'undo', label: 'Undo compaction', hint: 'Restore the full conversation that was summarized.' },
  { id: 'redo', label: 'Redo compaction', hint: 'Re-apply the compaction you just undid.' },
];

/** The host messages for an action, or [] when it cannot run. */
export function compactionMessages(action: string, context: CompactionContext): Record<string, unknown>[] {
  const conversationId = typeof context.conversationId === 'string' ? context.conversationId : '';
  if (!conversationId) return [];

  if (action === 'compact') {
    // Compacting an active conversation is refused host-side, and compacting one
    // that is already compacting is meaningless.
    if (context.running || context.compacting) return [];
    return [{ type: 'compact', conversationId }];
  }
  if (action === 'cancel') {
    if (!context.compacting) return [];
    return [{ type: 'cancelCompact', conversationId }];
  }
  // Undo and redo rewind the transcript, so they cannot run under a live turn.
  if (context.running) return [];
  if (action === 'undo') return context.undoable ? [{ type: 'undoLastTurn', conversationId }] : [];
  if (action === 'redo') return context.redoable ? [{ type: 'redoLastTurn', conversationId }] : [];
  return [];
}

/** The actions to render, in a fixed order, with availability derived above. */
export function compactionActions(context: CompactionContext): { id: CompactionActionId; label: string; hint: string; enabled: boolean }[] {
  return ACTIONS.map(action => ({ ...action, enabled: compactionMessages(action.id, context).length > 0 }));
}