/*
 * SleepyCode's five side panels — Worktrees, Project Index, Agents, Scheduled
 * Tasks, and Undo History — are host-generated lists: the extension decides
 * what each row says, and the webview only renders them.
 *
 * This module is the whole model those screens need, kept free of `vscode` and
 * of React so the same rules serve the host, the React drawer, and the tests.
 * The rule it exists to enforce: a button is only offered when pressing it
 * produces a message the host already handles. A visible control that posts
 * nothing is indistinguishable from a broken one.
 */

export type PanelId = 'worktrees' | 'index' | 'agents' | 'tasks' | 'checkpoints';

export const PANEL_IDS: readonly PanelId[] = ['worktrees', 'index', 'agents', 'tasks', 'checkpoints'];

const PANEL_TITLES: Record<PanelId, string> = {
  worktrees: 'Worktrees',
  index: 'Project Index',
  agents: 'Agents',
  tasks: 'Scheduled Tasks',
  checkpoints: 'Undo History',
};

/** What each panel is for, shown when the host has nothing more specific. */
const PANEL_HINTS: Record<PanelId, string> = {
  worktrees: 'Each worktree is an isolated checkout on its own branch, so a task cannot disturb this one.',
  index: 'Ask the agent to use repo_search or repo_symbol for symbol and semantic search.',
  agents: 'Pick an agent to route the next message, or type @agent-id at the start of a message to route one.',
  tasks: 'Hook rules allow, block, or require approval for tool calls.',
  checkpoints: 'Restoring a checkpoint returns workspace files to the state captured before that response.',
};

/** True for a panel id the webview knows how to render. */
export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && (PANEL_IDS as readonly string[]).includes(value);
}

/** Human title. An unknown id is shown verbatim rather than as an empty heading. */
export function panelTitle(panel: string): string {
  return PANEL_TITLES[panel as PanelId] ?? panel;
}

/** Guidance for a panel, or '' when the panel is unknown. */
export function panelHintFor(panel: string): string {
  return PANEL_HINTS[panel as PanelId] ?? '';
}

export type PanelActionId = 'refresh' | 'reindex' | 'newWorktree';
export type PanelRowActionId = 'useAgent' | 'restore';

export interface PanelAction {
  id: PanelActionId;
  label: string;
}

export interface PanelRowAction {
  id: PanelRowActionId;
  label: string;
}

/** Panel-wide buttons. Refresh is the only one every panel can honour. */
export function panelActions(panel: string): PanelAction[] {
  if (!isPanelId(panel)) return [];
  const actions: PanelAction[] = [{ id: 'refresh', label: 'Refresh' }];
  if (panel === 'index') actions.push({ id: 'reindex', label: 'Reindex' });
  if (panel === 'worktrees') actions.push({ id: 'newWorktree', label: 'New worktree' });
  return actions;
}

/** The per-row button, or null when the panel's rows are informational. */
export function panelRowAction(panel: string): PanelRowAction | null {
  if (panel === 'agents') return { id: 'useAgent', label: 'Use' };
  if (panel === 'checkpoints') return { id: 'restore', label: 'Restore' };
  return null;
}

export interface PanelRow {
  id?: string;
  title: string;
  detail?: string;
}

export interface PanelContext {
  conversationId?: string;
  running?: boolean;
}

/** Stable React key: the row's own id, else its position. */
export function panelRowKey(row: PanelRow, index: number): string {
  return typeof row.id === 'string' && row.id ? row.id : String(index);
}

/** The host messages a panel-level button posts. */
export function panelActionMessages(panel: string, action: string): Record<string, unknown>[] {
  if (!isPanelId(panel)) return [];
  if (action === 'refresh') return [{ type: 'requestPanel', panel }];
  if (action === 'reindex' && panel === 'index') {
    // The index rebuild is asynchronous, so re-read the panel once it is asked
    // for; otherwise the screen keeps showing the pre-reindex counts.
    return [{ type: 'reindexProject' }, { type: 'requestPanel', panel }];
  }
  if (action === 'newWorktree' && panel === 'worktrees') return [{ type: 'createWorktreeConversation' }];
  return [];
}

/** The host messages a row-level button posts, or [] when there is no target. */
export function panelRowActionMessages(
  panel: string,
  action: string,
  row: PanelRow,
  ctx: PanelContext = {},
): Record<string, unknown>[] {
  if (!panelRowActionEnabled(action, row, ctx)) return [];
  if (action === 'useAgent' && panel === 'agents') return [{ type: 'selectAgent', agentId: row.id }];
  if (action === 'restore' && panel === 'checkpoints') {
    return [{ type: 'restoreCheckpoint', conversationId: ctx.conversationId, itemId: row.id }];
  }
  return [];
}

/**
 * Whether a row button can do anything. Kept next to the message builders so the
 * disabled state and the posted message cannot drift apart.
 */
export function panelRowActionEnabled(action: string, row: PanelRow, ctx: PanelContext = {}): boolean {
  const hasId = typeof row.id === 'string' && row.id.length > 0;
  if (!hasId) return false;
  if (action === 'useAgent') return true;
  // The host refuses a restore while a run is in flight, so the button is
  // disabled rather than posting a message that is silently dropped.
  if (action === 'restore') return Boolean(ctx.conversationId) && !ctx.running;
  return false;
}

// ---------------------------------------------------------------- drawer entry

/** What each panel is for, shown beside its menu entry. */
const PANEL_MENU_HINTS: Record<PanelId, string> = {
  worktrees: 'Isolated checkouts, each on its own branch.',
  index: 'What the agent knows about this repository.',
  agents: 'Switch which agent handles the next message.',
  tasks: 'Hook rules that allow, block or gate tool calls.',
  checkpoints: 'Restore the workspace to an earlier response.',
};

/**
 * The entries a menu offers for opening a panel.
 *
 * The drawer used to open only when a VS Code command pushed `showPanel`, so
 * nothing in it was reachable from the chat. Order matches the command list.
 */
export function panelMenuEntries(): { id: PanelId; label: string; hint: string }[] {
  return PANEL_IDS.map(id => ({ id, label: panelTitle(id), hint: PANEL_MENU_HINTS[id] }));
}

/**
 * The message that opens a panel, or null for an id that names none.
 *
 * Refusing here keeps an unknown id from reaching the host, which would build
 * rows for a panel that does not exist.
 */
export function openPanelMessage(panel: unknown): { type: 'openPanel'; panel: PanelId } | null {
  return isPanelId(panel) ? { type: 'openPanel', panel } : null;
}
