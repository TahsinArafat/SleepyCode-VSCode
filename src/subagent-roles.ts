/*
 * Subagents: the three roles a run may delegate to, and the model each one uses.
 *
 * SleepyCode delegates through one tool with three fixed roles — explorer,
 * reviewer, worker — and each has real, different semantics:
 *
 *   explorer  read-only research; returns findings with file and line references
 *   reviewer  read-only critique; returns actionable findings or says there are none
 *   worker    bounded implementation or verification; the only role with write tools
 *
 * The model per role is already stored (`sleepycode.subagentModels`) and already
 * used when a subagent starts. What never existed was a page to set it: the
 * settings section was called "Subagents & Teams" and edited a feature store that
 * was not persisted and that the host never read.
 *
 * Teams are not modelled here because they are not a thing this build has. The
 * section is named for what it can actually change.
 *
 * Pure: no `vscode`, no DOM.
 */

export type SubagentRole = 'explorer' | 'reviewer' | 'worker';

export const SUBAGENT_ROLES: readonly SubagentRole[] = ['explorer', 'reviewer', 'worker'];

export const ROLE_META: Record<SubagentRole, { label: string; description: string; writes: boolean }> = {
  explorer: {
    label: 'Explorer',
    description: 'Read-only research. Finds the files and symbols that matter and reports them with references.',
    writes: false,
  },
  reviewer: {
    label: 'Reviewer',
    description: 'Independent read-only critique. Reports actionable findings, or says there were none.',
    writes: false,
  },
  worker: {
    label: 'Worker',
    description: 'Bounded implementation or verification. The only role that may edit files.',
    writes: true,
  },
};

export type SubagentModels = Partial<Record<SubagentRole, string>>;

/**
 * Read the stored map, keeping only known roles and non-empty model ids.
 *
 * `globalState` is a trust boundary: an unknown role would never be consulted, and
 * a blank id must mean "inherit" rather than "the empty model".
 */
export function normalizeSubagentModels(stored: unknown): SubagentModels {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out: SubagentModels = {};
  for (const role of SUBAGENT_ROLES) {
    const value = (stored as Record<string, unknown>)[role];
    const model = typeof value === 'string' ? value.trim() : '';
    if (model) out[role] = model;
  }
  return out;
}

/**
 * What a role will actually run on.
 *
 * An unset role inherits the conversation's model — that is what the host does at
 * delegate time, so the page has to say the same thing rather than show blank.
 */
export function effectiveModel(models: SubagentModels, role: SubagentRole, conversationModel: string): { model: string; inherited: boolean } {
  const chosen = models[role];
  if (chosen) return { model: chosen, inherited: false };
  return { model: conversationModel, inherited: true };
}

/**
 * Whether a role can use a model this build knows about.
 *
 * A stored id that no longer exists in the catalog would fail at delegate time,
 * where the failure is a subagent that produces nothing. The page says so instead.
 */
export function roleModelProblem(models: SubagentModels, role: SubagentRole, catalog: readonly string[]): string | null {
  const chosen = models[role];
  if (!chosen) return null;
  if (catalog.length === 0) return null; // catalog not loaded yet: nothing to judge
  return catalog.includes(chosen) ? null : `"${chosen}" is not in the current model list. This ${role} would fail when it starts.`;
}

/** The options for a role's picker: inherit, then the catalog. */
export function roleOptions(catalog: readonly string[]): { id: string; label: string }[] {
  return [
    { id: '', label: "Same as the conversation's model" },
    ...catalog.map(id => ({ id, label: id })),
  ];
}