/*
 * Editing agents from a window.
 *
 * The settings rail has always had an "Agents" section, and it has never been an
 * agent manager: it rendered text-size and appearance controls. The real list
 * existed all along — built-ins from the host, plus whatever the user created —
 * and the only place to create one was a panel outside settings.
 *
 * An agent is an id, a name, an instruction prompt, and optionally a model and a
 * tool allow/deny list. The host already validates a save; this owns the rules the
 * PAGE validates with, so a mistake is reported where it was made instead of as a
 * notification after the dialog closed.
 *
 * Pure: no `vscode`, no DOM.
 */

import { BUILT_IN_AGENT_META } from './agent-options.ts';

/** Ids are used in storage keys and in prompts, so they stay boring. */
const ID_RULE = /^[A-Za-z0-9_-]+$/;

export interface AgentDraft {
  id: string;
  name: string;
  prompt: string;
  model: string;
  /** Comma- or space-separated tool names. */
  allow: string;
  deny: string;
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  description: string;
  builtIn: boolean;
  prompt: string;
  model: string;
  allow: string[];
  deny: string[];
}

/** Tools are typed as a list; accept commas, spaces and newlines alike. */
export function parseToolList(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

export function formatToolList(values: readonly string[] | undefined): string {
  return Array.isArray(values) ? values.join(', ') : '';
}

export function emptyAgentDraft(): AgentDraft {
  return { id: '', name: '', prompt: '', model: '', allow: '', deny: '' };
}

/** The editable form of an existing custom agent. */
export function draftFromRow(row: AgentRow): AgentDraft {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    allow: formatToolList(row.allow),
    deny: formatToolList(row.deny),
  };
}

/**
 * What is wrong with a draft, or null when it can be saved.
 *
 * `existing` is the list already stored, so a new agent cannot take an id that is
 * in use — saving over one silently replaced it, because the host upserts by id.
 */
export function validateAgentDraft(
  draft: AgentDraft,
  existing: readonly { id: string; builtIn?: boolean }[] = [],
  options: { isNew?: boolean } = {},
): string | null {
  const name = draft.name.trim();
  if (!name) return 'Give the agent a name.';
  const id = draft.id.trim();
  if (!id) return 'Give the agent an id. It is how the agent is stored, and it cannot be changed later.';
  if (!ID_RULE.test(id)) return 'The id may contain only letters, numbers, hyphens and underscores.';
  // A new agent may not take an id that is in use — the host upserts by id, so the
  // save would silently replace the other agent. Editing keeps its own id.
  const taken = existing.find(entry => entry.id === id && (entry.builtIn || options.isNew === true));
  if (taken) return taken.builtIn ? `"${id}" is a built-in agent. Choose another id.` : `"${id}" is already used by another agent.`;
  if (parseToolList(draft.allow).length && parseToolList(draft.deny).length) {
    return 'Allow and deny cannot both list tools: that rule would contradict itself.';
  }
  return null;
}

/** The agent record to save. Empty optional fields are omitted, not stored blank. */
export function agentFromDraft(draft: AgentDraft): {
  id: string;
  name: string;
  prompt?: string;
  model?: string;
  tools?: { allow?: string[]; deny?: string[] };
} {
  const allow = parseToolList(draft.allow);
  const deny = parseToolList(draft.deny);
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    ...(draft.prompt.trim() ? { prompt: draft.prompt.trim() } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(allow.length || deny.length ? { tools: { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) } } : {}),
  };
}

/**
 * The rows to render: built-ins first and read-only, then the user's own.
 *
 * A custom agent whose id collides with a built-in is left out, which is what the
 * host does when it resolves an agent — showing it would offer a row that can
 * never run.
 */
export function agentRows(builtIns: readonly any[], custom: readonly any[]): AgentRow[] {
  const rows: AgentRow[] = [];
  const builtInIds = new Set<string>();
  for (const entry of builtIns) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!id || !name || builtInIds.has(id)) continue;
    builtInIds.add(id);
    const meta = BUILT_IN_AGENT_META[id];
    rows.push({
      id,
      // The host stores built-in names as `Apex (Builder)`; the label the user
      // reads is the name and the role, separately.
      name: meta?.name ?? name.replace(/\s*\([^)]*\)\s*$/, ''),
      role: meta?.role ?? 'Built-in',
      description: meta?.description ?? '',
      builtIn: true,
      prompt: '',
      model: '',
      allow: [],
      deny: [],
    });
  }
  for (const entry of custom) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!id || !name || builtInIds.has(id) || rows.some(row => row.id === id)) continue;
    rows.push({
      id,
      name,
      role: 'Custom',
      description: '',
      builtIn: false,
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      model: typeof entry.model === 'string' ? entry.model : '',
      allow: Array.isArray(entry.tools?.allow) ? entry.tools.allow.filter((value: unknown) => typeof value === 'string') : [],
      deny: Array.isArray(entry.tools?.deny) ? entry.tools.deny.filter((value: unknown) => typeof value === 'string') : [],
    });
  }
  return rows;
}