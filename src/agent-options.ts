/*
 * The agent picker's option model.
 *
 * The host stores an agent as `{ id, name }` where a built-in's name carries its
 * role in parentheses — `Apex (Builder)`. That is a storage name, not a label: the
 * menu the user reads says `Apex` with `Build` beside it. Both sides of that
 * mapping live here so the picker, the Agents panel and the host cannot drift.
 *
 * A custom agent is passed through with the role `Custom` rather than forced into
 * the built-in vocabulary, because inventing a role for someone else's agent would
 * be a lie the UI then has to maintain.
 *
 * Pure: no `vscode`, no DOM. Loaded by the host and by the direct test runner.
 */

/** How a built-in agent presents in the picker. */
/**
 * How a built-in agent presents in the picker.
 *
 * Only `default` is left. The other five — Apex, Phantom, Pivot, Forge, Stack —
 * were id + name + a paragraph about how to work: no model, no tool policy. That
 * is a persona, and they live in `src/personas.ts` now. Keeping them here meant
 * two dropdowns in the composer listing the same idea.
 *
 * An agent answers a different question: what may run. `default` is "nothing
 * special", and everything else is a custom agent, which really does carry a
 * model and a tool allow/deny list.
 *
 * Their ids stay reserved below: a conversation saved while they were agents may
 * still name one, and a custom agent must not take that name back.
 */
export const BUILT_IN_AGENT_META: Record<string, { name: string; role: string; description: string }> = {
  default: {
    name: 'SleepyCode',
    role: 'Auto',
    description: 'General coding agent that adapts to the task.',
  },
};

/** Ids that once named a built-in agent, now personas. Reserved for agents. */
export const LEGACY_AGENT_PERSONA_IDS = ['apex', 'phantom', 'pivot', 'forge', 'stack'] as const;

/** True when an agent id is really a persona the user chose before the merge. */
export function isLegacyPersonaAgent(id: unknown): boolean {
  return typeof id === 'string' && (LEGACY_AGENT_PERSONA_IDS as readonly string[]).includes(id);
}

export interface AgentOption {
  id: string;
  name: string;
  role: string;
  description: string;
  builtIn: boolean;
}

/**
 * Build the picker's rows from what the host reports.
 *
 * Order is preserved: the host sends built-ins first, then custom agents, and the
 * picker should match the Agents panel rather than re-sorting. Entries without an
 * id or a name are dropped — the list comes from global state, which an older
 * version or a hand edit can have left malformed, and a blank row is worse than a
 * missing one.
 */
export function agentOptions(agents: readonly unknown[] | undefined): AgentOption[] {
  const out: AgentOption[] = [];
  for (const entry of agents ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const agent = entry as { id?: unknown; name?: unknown; description?: unknown };
    if (typeof agent.id !== 'string' || !agent.id) continue;
    if (typeof agent.name !== 'string' || !agent.name) continue;
    const meta = BUILT_IN_AGENT_META[agent.id];
    out.push({
      id: agent.id,
      // A built-in's stored name is `Apex (Builder)`; the menu wants `Apex`.
      name: meta ? meta.name : agent.name,
      role: meta ? meta.role : 'Custom',
      description: meta ? meta.description : (typeof agent.description === 'string' ? agent.description : ''),
      builtIn: Boolean(meta),
    });
  }
  return out;
}

/** The row to show as selected, falling back to the first agent. */
export function selectedAgent(options: readonly AgentOption[], id: string | undefined): AgentOption | undefined {
  if (id) {
    const match = options.find(option => option.id === id);
    if (match) return match;
  }
  return options[0];
}