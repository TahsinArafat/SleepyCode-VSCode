/*
 * Editing hook rules from a window.
 *
 * The host runs hooks as in-process RULES: an event, an optional matcher, and an
 * action of allow / block / warn / log / requireApproval. The ported settings page
 * edits a different thing entirely — `{ event, command }` shell commands — and
 * nothing ever ran them: the host has no command runner for hooks, and the values
 * were not even persisted. So the page offered controls that wrote nowhere.
 *
 * What is edited here is exactly what `evaluateHooks` reads, so a rule saved in
 * the window is a rule that fires on the next request.
 */

import type { HookAction, HookEventName, HookMatcher, HookRule } from './hooks.ts';

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  'beforeTool',
  'afterTool',
  'onEdit',
  'onCommand',
  'onMessage',
  'onAgentStart',
  'onAgentEnd',
];

export const HOOK_EVENT_LABELS: Record<HookEventName, string> = {
  beforeTool: 'Before a tool runs',
  afterTool: 'After a tool runs',
  onEdit: 'Before a file edit',
  onCommand: 'Before a command',
  onMessage: 'When you send a message',
  onAgentStart: 'When a run starts',
  onAgentEnd: 'When a run ends',
};

export const HOOK_ACTIONS: readonly HookAction[] = ['warn', 'log', 'block', 'requireApproval', 'allow'];

export const HOOK_ACTION_LABELS: Record<HookAction, string> = {
  allow: 'Allow',
  block: 'Block',
  warn: 'Warn',
  log: 'Log',
  requireApproval: 'Require approval',
};

export const HOOK_ACTION_HINTS: Record<HookAction, string> = {
  allow: 'Do nothing. Recorded so a rule can be parked without deleting it.',
  block: 'Stop the action and report the message. A blocked edit or command never runs.',
  warn: 'Let the action continue and raise the message as a warning.',
  log: 'Let the action continue and record the message.',
  requireApproval: 'Ask before continuing. Declining stops the action.',
};

/** Events whose context carries a tool name, a path, or message text. */
export function matcherFields(event: HookEventName): readonly ('tool' | 'pathGlob' | 'contains')[] {
  if (event === 'beforeTool' || event === 'afterTool') return ['tool', 'pathGlob'];
  if (event === 'onEdit') return ['pathGlob'];
  if (event === 'onCommand') return ['contains'];
  if (event === 'onMessage') return ['contains'];
  return [];
}

/** A rule to add to a list, with an id that cannot collide with the ones there. */
export function newHookRule(existing: readonly HookRule[], event: HookEventName = 'beforeTool'): HookRule {
  let n = existing.length + 1;
  while (existing.some(rule => rule.id === `hook-${n}`)) n++;
  return { id: `hook-${n}`, name: `${HOOK_EVENT_LABELS[event]} rule`, event, action: 'warn', message: '', enabled: true };
}

/**
 * Read a list of rules back from untrusted input.
 *
 * Anything unrecognised is dropped rather than coerced into a rule that would
 * then silently block edits: a typo in an action must not become "allow everything
 * through" or "block everything".
 */
export function normalizeHookRules(input: unknown): HookRule[] {
  if (!Array.isArray(input)) return [];
  const rules: HookRule[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const event = HOOK_EVENT_NAMES.includes(raw.event as HookEventName) ? (raw.event as HookEventName) : undefined;
    if (!event) continue;
    const action = HOOK_ACTIONS.includes(raw.action as HookAction) ? (raw.action as HookAction) : 'warn';
    const matcher: HookMatcher = {};
    if (typeof raw.matcher === 'object' && raw.matcher) {
      const source = raw.matcher as Record<string, unknown>;
      if (typeof source.tool === 'string' && source.tool.trim()) matcher.tool = source.tool.trim();
      if (typeof source.pathGlob === 'string' && source.pathGlob.trim()) matcher.pathGlob = source.pathGlob.trim();
      if (typeof source.contains === 'string' && source.contains.trim()) matcher.contains = source.contains.trim();
    }
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `hook-${rules.length + 1}`;
    if (rules.some(rule => rule.id === id)) continue;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : HOOK_EVENT_LABELS[event];
    rules.push({
      id,
      name,
      event,
      ...(Object.keys(matcher).length ? { matcher } : {}),
      action,
      ...(typeof raw.message === 'string' && raw.message.trim() ? { message: raw.message.trim() } : {}),
      enabled: raw.enabled !== false,
    });
  }
  return rules;
}

/** Why a rule cannot be saved, or null when it can. */
export function hookRuleProblem(rule: HookRule): string | null {
  // A block or an approval prompt with nothing to say is a dialog with no reason.
  if ((rule.action === 'block' || rule.action === 'requireApproval') && !rule.message?.trim()) {
    return 'Say why. Blocking or asking for approval without a message leaves the user with nothing to act on.';
  }
  return null;
}

/** One line describing what a rule does, for the list. */
export function hookRuleSummary(rule: HookRule): string {
  const parts = [HOOK_EVENT_LABELS[rule.event]];
  const matcher = rule.matcher;
  if (matcher?.tool) parts.push(`tool ${matcher.tool}`);
  if (matcher?.pathGlob) parts.push(`path ${matcher.pathGlob}`);
  if (matcher?.contains) parts.push(`contains "${matcher.contains}"`);
  parts.push(HOOK_ACTION_LABELS[rule.action].toLowerCase());
  return parts.join(' · ');
}