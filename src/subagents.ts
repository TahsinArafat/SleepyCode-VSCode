/*
 * Subagents, named and grouped.
 *
 * A delegation has three shapes — research, critique, bounded implementation —
 * and those are the built-in roles. What a real project needs is a *name* for a
 * job ("threat modeler", "migration planner") carrying its own instructions and,
 * optionally, its own cheaper model. A team is a roster of those names, so a
 * project lead delegates to a defined group instead of to whatever it invents.
 *
 * The rules that bite are quiet ones, and they live here rather than in the
 * settings page:
 *
 *   - the model addresses a subagent by name, so the match is normalized;
 *   - a read-only definition must keep its capability, whatever role it runs on;
 *   - deleting a subagent may not leave a team pointing at a ghost;
 *   - assigning no team must mean "everyone", or the feature changes behaviour
 *     for every existing user by existing.
 *
 * Pure: no `vscode`, no DOM. The role/model machinery it builds on stays in
 * `subagent-roles.ts`.
 */

import type { SubagentRole } from './subagent-roles';

/** A delegatable job: instructions, a capability, and optionally its own model. */
export interface SubagentDef {
  /** Slug the model addresses it by. */
  id: string;
  name: string;
  /** One line the parent model reads when choosing — and the user reads in the list. */
  description: string;
  prompt: string;
  role: SubagentRole;
  /** Read-only cannot be gained back: a worker definition may still be read-only. */
  readonly: boolean;
  /** Model override; empty means the role's model, then the conversation's. */
  model?: string;
  builtin?: boolean;
}

/** A named roster of subagents. */
export interface TeamDef {
  id: string;
  name: string;
  description: string;
  subagentIds: string[];
  builtin?: boolean;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const ROLES = new Set<SubagentRole>(['explorer', 'reviewer', 'worker']);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Name matching ignores case and punctuation, because the model writes both. */
const normalizeName = (value: unknown): string => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');

export const BUILTIN_SUBAGENTS: readonly SubagentDef[] = [
  {
    id: 'explorer',
    name: 'Explorer',
    description: 'Read-only research: finds the files and symbols that matter and reports them with references.',
    prompt: 'Research the repository read-only. Return findings with precise workspace-relative file paths and line references.',
    role: 'explorer',
    readonly: true,
    builtin: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Independent read-only critique: reports actionable findings, or says there were none.',
    prompt: 'Review independently and read-only. Look for correctness, regressions, security issues, and missing verification. Return only actionable findings or state that none were found.',
    role: 'reviewer',
    readonly: true,
    builtin: true,
  },
  {
    id: 'worker',
    name: 'Worker',
    description: 'Bounded implementation or verification. The only built-in that may edit files.',
    prompt: 'Complete the bounded implementation or verification task. Inspect before editing, preserve unrelated changes, and verify the result.',
    role: 'worker',
    readonly: false,
    builtin: true,
  },
];

const BUILTIN_IDS = new Set(BUILTIN_SUBAGENTS.map((def) => def.id));

/** Custom definitions, with anything malformed dropped rather than offered. */
export function normalizeCustomSubagents(value: unknown): SubagentDef[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>(BUILTIN_SUBAGENTS.map((def) => normalizeName(def.name)));
  const out: SubagentDef[] = [];
  for (const entry of value) {
    const candidate = entry as Partial<SubagentDef> | null;
    const id = text(candidate?.id);
    const name = text(candidate?.name);
    const description = text(candidate?.description);
    const prompt = text(candidate?.prompt);
    const role = text(candidate?.role) as SubagentRole;
    if (!ID_PATTERN.test(id) || BUILTIN_IDS.has(id) || seenIds.has(id)) continue;
    if (!ROLES.has(role) || !name || !description || !prompt) continue;
    const key = normalizeName(name);
    // Two subagents the model cannot tell apart are one subagent with a bug.
    if (seenNames.has(key)) continue;
    seenIds.add(id);
    seenNames.add(key);
    out.push({ id, name, description, prompt, role, readonly: candidate?.readonly === true, ...(text(candidate?.model) ? { model: text(candidate?.model) } : {}) });
  }
  return out;
}

export function allSubagents(custom: unknown): SubagentDef[] {
  const own = normalizeCustomSubagents(custom);
  const shadowed = new Set(own.map((def) => def.id));
  return [...BUILTIN_SUBAGENTS.filter((def) => !shadowed.has(def.id)), ...own];
}

/** The definition a `subagent` argument names, or undefined for "use the role". */
export function findSubagent(defs: readonly SubagentDef[], query: unknown): SubagentDef | undefined {
  const wanted = normalizeName(query);
  if (!wanted) return undefined;
  return defs.find((def) => normalizeName(def.id) === wanted)
    ?? defs.find((def) => normalizeName(def.name) === wanted);
}

/** The roster the parent model reads before delegating. */
export function subagentRosterBlock(defs: readonly SubagentDef[]): string {
  const lines = defs.map((def) => `- ${def.name}${def.readonly ? ' (read-only)' : ' (may edit files)'}: ${def.description}`);
  return `<subagents>\nDelegate with delegate_task: pass the name as \`subagent\`, plus the task and only the context it needs.\n${lines.join('\n')}\n</subagents>`;
}

export interface SubagentDraft {
  id: string;
  name: string;
  description: string;
  prompt: string;
  role: SubagentRole;
  readonly: boolean;
  model?: string;
}

/** Empty string when saveable, otherwise the reason it is not. */
export function validateSubagentDraft(draft: SubagentDraft, existing: readonly SubagentDef[], options: { isNew: boolean }): string {
  const id = text(draft.id);
  if (!ID_PATTERN.test(id)) return 'The id must be lowercase letters, numbers and hyphens (2–39 characters).';
  if (BUILTIN_IDS.has(id)) return 'That id belongs to a built-in subagent. Pick another.';
  if (!text(draft.name)) return 'Give the subagent a name.';
  const key = normalizeName(draft.name);
  const sameId = existing.find((def) => def.id === id);
  const sameName = existing.find((def) => normalizeName(def.name) === key);
  // The model addresses a subagent by name, so two with the same name are one
  // subagent with a bug. Editing your own row does not count as a clash.
  if (sameName && sameName.id !== sameId?.id) return 'Another subagent already uses that name. The model picks by name, so they must be unique.';
  if (options.isNew && sameId) return 'A subagent with that id already exists.';
  if (!text(draft.description)) return 'Write the description: the one line the parent model uses to choose this subagent.';
  if (!text(draft.prompt)) return 'Write the instructions this subagent runs on.';
  if (!ROLES.has(draft.role)) return 'Pick which capability it runs with.';
  return '';
}

export function subagentFromDraft(draft: SubagentDraft): SubagentDef {
  return {
    id: text(draft.id),
    name: text(draft.name),
    description: text(draft.description),
    prompt: text(draft.prompt),
    role: draft.role,
    readonly: draft.readonly === true,
    ...(text(draft.model) ? { model: text(draft.model) } : {}),
  };
}

/** Teams, with members that no longer exist dropped and empty teams removed. */
export function normalizeTeams(value: unknown, knownIds: readonly string[]): TeamDef[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(knownIds);
  const seen = new Set<string>();
  const out: TeamDef[] = [];
  for (const entry of value) {
    const candidate = entry as Partial<TeamDef> | null;
    const id = text(candidate?.id);
    const name = text(candidate?.name);
    if (!ID_PATTERN.test(id) || seen.has(id) || !name) continue;
    const members = Array.isArray(candidate?.subagentIds)
      ? [...new Set(candidate.subagentIds.map(text).filter((member) => known.has(member)))]
      : [];
    // A team with no members cannot narrow anything; keeping it would arm a
    // roster that silently delegates to nobody.
    if (!members.length) continue;
    seen.add(id);
    out.push({ id, name, description: text(candidate?.description) || 'Custom team', subagentIds: members });
  }
  return out;
}

/**
 * Who may be delegated to.
 *
 * No assigned team means every subagent — the behaviour that existed before
 * teams, preserved on purpose. An assigned team whose members were all deleted
 * also falls back to everyone, because a lead with nobody to delegate to is a
 * worse answer than a wider roster.
 */
export function resolveTeamSubagents(all: readonly SubagentDef[], teams: readonly TeamDef[], activeTeamIds: readonly string[]): SubagentDef[] {
  const active = teams.filter((team) => activeTeamIds.includes(team.id));
  if (!active.length) return [...all];
  const members = new Set(active.flatMap((team) => team.subagentIds));
  const picked = all.filter((def) => members.has(def.id));
  return picked.length ? picked : [...all];
}

/** Tells the parent it is a project lead, and over which roster. */
export function teamRosterNote(teams: readonly TeamDef[], activeTeamIds: readonly string[]): string {
  const active = teams.filter((team) => activeTeamIds.includes(team.id));
  if (!active.length) return '';
  const lines = active.map((team) => `- ${team.name}: ${team.description}`);
  return `<assigned_teams>\nYou are the project lead for these teams: delegate the work to their members rather than doing all of it yourself.\n${lines.join('\n')}\n</assigned_teams>`;
}

export interface TeamDraft {
  id: string;
  name: string;
  description: string;
  subagentIds: string[];
}

export function validateTeamDraft(draft: TeamDraft, existing: readonly TeamDef[], options: { isNew: boolean }): string {
  const id = text(draft.id);
  if (!ID_PATTERN.test(id)) return 'The id must be lowercase letters, numbers and hyphens (2–39 characters).';
  if (!text(draft.name)) return 'Give the team a name.';
  if (options.isNew && existing.some((team) => team.id === id)) return 'A team with that id already exists.';
  if (!Array.isArray(draft.subagentIds) || draft.subagentIds.length === 0) return 'Pick at least one member; a team with nobody in it delegates nothing.';
  return '';
}

export function teamFromDraft(draft: TeamDraft): TeamDef {
  return {
    id: text(draft.id),
    name: text(draft.name),
    description: text(draft.description) || 'Custom team',
    subagentIds: [...new Set((draft.subagentIds ?? []).map(text).filter(Boolean))],
  };
}