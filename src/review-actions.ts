/*
 * The actions on a response's changed files.
 *
 * The classic changes card offered Stage all, Commit, Source Control and Restore
 * checkpoint. The React review bar offers Keep All / Undo All and per-file Keep /
 * Undo, so a response could be staged but never committed from the chat, and its
 * checkpoint was only reachable through the Undo History panel.
 *
 * Each action here is paired with the messages it posts, and `enabled` is derived
 * from whether those messages exist — a button that is offered but posts nothing
 * is the failure mode this module prevents.
 *
 * Everything needs both a conversation and a turn: the host resolves which files
 * to touch through those two ids, and acting on the wrong turn's files is worse
 * than doing nothing.
 */

export interface ChangeContext {
  conversationId?: string;
  itemId?: string;
  paths?: readonly string[];
  running?: boolean;
}

export type ChangeActionId = 'stageAll' | 'commit' | 'sourceControl' | 'restore';

const ACTIONS: { id: ChangeActionId; label: string; hint: string }[] = [
  { id: 'stageAll', label: 'Stage all', hint: 'Stage every file this response changed.' },
  { id: 'commit', label: 'Commit', hint: 'Commit this response’s changes with a generated message.' },
  { id: 'sourceControl', label: 'Source Control', hint: 'Open these changes in VS Code’s Source Control view.' },
  { id: 'restore', label: 'Restore checkpoint', hint: 'Return the workspace to how it was before this response.' },
];

/** Whether a response has something to act on. */
function hasTarget(context: ChangeContext): boolean {
  return Boolean(context.conversationId && context.itemId);
}

/**
 * The host messages for an action, or [] when the action cannot run.
 *
 * `running` gates the three that mutate files, because the host refuses them
 * mid-run. Source Control only reveals a view, so it stays available.
 */
export function changeActionMessages(action: string, context: ChangeContext): Record<string, unknown>[] {
  if (!hasTarget(context)) return [];
  const conversationId = context.conversationId!;
  const itemId = context.itemId!;
  const mutating = action === 'stageAll' || action === 'commit' || action === 'restore';
  if (mutating && context.running) return [];

  if (action === 'stageAll') {
    const paths = (context.paths ?? []).filter(path => typeof path === 'string' && path);
    // Staging nothing is not a request worth posting.
    if (!paths.length) return [];
    return [{ type: 'gitStageChanges', conversationId, itemId, paths }];
  }
  if (action === 'commit') return [{ type: 'gitCommit', conversationId, itemId }];
  if (action === 'sourceControl') return [{ type: 'reviewChanges', conversationId, itemId }];
  if (action === 'restore') return [{ type: 'restoreCheckpoint', conversationId, itemId }];
  return [];
}

/**
 * The actions to render, with `enabled` derived from the message builders so the
 * two cannot drift.
 */
export function changeActions(context: ChangeContext): { id: ChangeActionId; label: string; hint: string; enabled: boolean }[] {
  return ACTIONS.map(action => ({
    ...action,
    enabled: changeActionMessages(action.id, context).length > 0,
  }));
}