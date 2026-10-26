/**
 * Agent modes and the permission ceiling they impose.
 *
 * One module owns three things that must never disagree:
 *
 *   1. which tools a mode may use (`isToolAllowedInMode`),
 *   2. whether approval is meaningful there (`approvalAppliesInMode`),
 *   3. what the model is told about its own limits (`modeGuidance`).
 *
 * It is deliberately dependency-free: the extension host, the React webview and
 * the direct test runner all load it, so a change lands everywhere at once.
 *
 * The central rule is that permissions only ever flow **down**: a subagent's
 * tool set is intersected with its parent's (`applyCeiling`), so delegating
 * cannot grant anything the delegating agent did not already have.
 */

export type AgentMode = 'agent' | 'ask' | 'plan';

const MODES: readonly AgentMode[] = ['agent', 'ask', 'plan'];

/** Narrow an unknown value to a mode, or `undefined` when it is not one. */
export function knownMode(value: unknown): AgentMode | undefined {
  return MODES.includes(value as AgentMode) ? (value as AgentMode) : undefined;
}

/**
 * Decide which mode a run uses.
 *
 * Order: the mode carried by this message, then the conversation's stored mode,
 * then the last mode the user chose. `agent` is only the final fallback, because
 * it is the one mode that can write — defaulting to it early silently grants
 * write access while the UI still says Ask. An unrecognised value falls through
 * to the next source for the same reason.
 */
export function resolveRunMode(input: {
  messageMode?: unknown;
  conversationMode?: unknown;
  lastMode?: unknown;
} | undefined): AgentMode {
  return knownMode(input?.messageMode)
    ?? knownMode(input?.conversationMode)
    ?? knownMode(input?.lastMode)
    ?? 'agent';
}

// ---------------------------------------------------------------- tool policy

/** Tools that change the workspace or run commands. */
const MUTATING_TOOLS = [
  'write_file',
  'replace_text',
  'delete_file',
  'run_command',
  // Starting, writing to, or stopping a terminal runs commands by proxy. The
  // `terminal_` prefix cannot carry this because terminal_read/list only observe.
  'terminal_start',
  'terminal_write',
  'terminal_stop',
  // Writing the project memory file is a workspace edit like any other.
  'memory_update',
  'skillsmp_install_skill',
  // Opening a PR, commenting on one, or branching from an issue all change
  // something on a remote the user has not approved. Reading an issue, listing
  // issues, PR status and review comments are observations and stay available.
  'github_commit',
  'github_open_pr',
  'github_pr_comment',
  'github_start_from_issue',
  // Saving a plan writes a file, but plan mode is granted this one narrow tool
  // (see MODE_GRANTS) because planning has to leave an artefact behind.
  'write_plan',
];

/** Prefixes whose tools mutate, so a newly added tool in the family is covered. */
const MUTATING_PREFIXES = ['worktree_', 'skillsmp_install'];

/**
 * Tools whose family contains both reads and writes, so a prefix would be wrong.
 * `terminal_read` and `terminal_list` only observe; `terminal_start`/`write`/`stop`
 * change state. `worktree_list`/`status`/`compare` likewise only report.
 */
const NON_MUTATING_FAMILY_TOOLS = new Set([
  'terminal_read',
  'terminal_list',
  'worktree_list',
  'worktree_status',
  'worktree_compare',
]);

/**
 * Browser tools that act on a page rather than observe it. Reading a page is an
 * observation; navigating, clicking, typing and evaluating change external state
 * the user has not approved, so they are gated like a command.
 */
const BROWSER_ACTION_TOOLS = [
  'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload',
  'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_evaluate',
  'browser_new_tab', 'browser_close_tab', 'browser_switch_tab', 'browser_close', 'browser_wait',
];

/**
 * Tools a specific mode may use *even though* they change state.
 *
 * `plan` mode is read-only except that it must be able to save the plan it
 * produced. That is one narrow, purpose-built tool whose path the tool itself
 * chooses — not `write_file`, which can write anywhere.
 */
const MODE_GRANTS: Record<AgentMode, readonly string[]> = {
  agent: [],
  ask: [],
  plan: ['write_plan'],
};

/**
 * Grants that belong to the run alone and are never handed to a subagent.
 *
 * A subagent has no plan of its own to save, and letting one write plan files
 * would widen the parent's permission through delegation.
 */
const RUN_ONLY_GRANTS = new Set<string>(['write_plan']);

/** True when a tool changes state anywhere — workspace, remote, or a web page. */
export function isMutatingTool(tool: string): boolean {
  if (NON_MUTATING_FAMILY_TOOLS.has(tool)) return false;
  if (MUTATING_TOOLS.includes(tool)) return true;
  if (BROWSER_ACTION_TOOLS.includes(tool)) return true;
  return MUTATING_PREFIXES.some(prefix => tool.startsWith(prefix));
}

/**
 * Whether a tool may be offered in this mode.
 *
 * An unrecognised mode is treated as read-only: assuming `agent` would grant
 * write access on the strength of a typo.
 */
export function isToolAllowedInMode(mode: unknown, tool: string): boolean {
  if (mode === 'agent') return true;
  if (knownMode(mode) && MODE_GRANTS[knownMode(mode)! as AgentMode].includes(tool)) return true;
  return !isMutatingTool(tool);
}

/**
 * Whether a tool may be handed to a subagent.
 *
 * Equal to `isToolAllowedInMode` minus the run-only grants, so permissions still
 * only ever flow down.
 */
export function isToolAllowedForSubagent(mode: unknown, tool: string): boolean {
  if (RUN_ONLY_GRANTS.has(tool)) return false;
  return isToolAllowedInMode(mode, tool);
}

/** Keep only the tools a subagent may use. */
export function applySubagentCeiling<T extends Record<string, unknown>>(tools: T, mode: unknown): Partial<T> {
  const allowed: Partial<T> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isToolAllowedForSubagent(mode, name)) (allowed as Record<string, unknown>)[name] = tool;
  }
  return allowed;
}

/**
 * Approval governs edits and commands, which only `agent` can perform. In `ask`
 * and `plan` there is nothing to approve, so the control is meaningless.
 */
export function approvalAppliesInMode(mode: unknown): boolean {
  return mode === 'agent';
}

/**
 * Keep only the tools this mode permits.
 *
 * Used for the main run and, crucially, for every subagent: permissions flow
 * down, never up.
 */
export function applyCeiling<T extends Record<string, unknown>>(tools: T, mode: unknown): Partial<T> {
  const allowed: Partial<T> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isToolAllowedInMode(mode, name)) (allowed as Record<string, unknown>)[name] = tool;
  }
  return allowed;
}

/**
 * Names present in `tools` that the ceiling forbids.
 *
 * Returned so a caller can log *what* was withheld instead of only a count —
 * "delegating could not escalate" is a claim worth being able to verify.
 */
export function withheldByCeiling(tools: Record<string, unknown>, mode: unknown): string[] {
  return Object.keys(tools).filter(name => !isToolAllowedInMode(mode, name)).sort();
}

/** Names a subagent loses that the parent itself may use. */
export function withheldFromSubagent(tools: Record<string, unknown>, mode: unknown): string[] {
  return Object.keys(tools)
    .filter(name => isToolAllowedInMode(mode, name) && !isToolAllowedForSubagent(mode, name))
    .sort();
}

// ---------------------------------------------------------------- prompting

/**
 * What the model is told about its own limits in a mode.
 *
 * Stated plainly and early: without it, a model that finds a tool missing spends
 * turns retrying it and looking for a way around — including delegating to a
 * subagent, which reads as a legitimate workaround unless it is ruled out.
 */
export function modeGuidance(mode: unknown): string {
  if (mode === 'ask') {
    return [
      'Mode: Ask (read-only).',
      'Do NOT try to change any file. There is no write, replace, delete, or command tool, and no browser action tool — you cannot create, edit, move or remove anything, including files you have already read.',
      'You can read, search, inspect, ask the user questions, and delegate read-only research.',
      'Do not look for a workaround. Delegating does not help: a subagent inherits your limits, so it cannot write either. If the task needs a change, say what you would change and ask the user to switch to Agent mode.',
    ].join(' ');
  }
  if (mode === 'plan') {
    return [
      'Mode: Plan (read-only).',
      'Investigate and produce a plan. Do NOT try to change project files: there is no write, replace, delete, or command tool, and no browser action tool.',
      'Your one way to leave an artefact is write_plan, which saves the plan you produced as a Markdown file under .sleepycode/plans/. Use it for the plan itself, not for project changes.',
      'Do not look for a workaround. Delegating does not help: a subagent inherits your limits, so it cannot write either.',
      'Save the finished plan with write_plan, then give the same plan as your answer — goal, the files it would touch, ordered steps, and how each step would be verified. Ask the user to switch to Agent mode to carry it out.',
    ].join(' ');
  }
  return [
    'Mode: Agent.',
    'You may change the workspace and run commands, subject to the approval policy. Subagents you delegate to inherit these limits and can never exceed them.',
  ].join(' ');
}

/**
 * What a subagent is told about the limits it inherited.
 *
 * A subagent cannot see its parent's mode, so it is told the ceiling directly
 * rather than left to discover a missing tool and improvise.
 */
export function subagentGuidance(mode: unknown): string {
  if (mode === 'agent') return '';
  return `Inherited limits: your parent runs in a read-only mode, so you have no write, delete or command tools. Do not attempt workarounds; report what would need to change instead.`;
}
