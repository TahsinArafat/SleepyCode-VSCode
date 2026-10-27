/*
 * What goes into a request.
 *
 * `ComposerContext` has supported project intelligence, the active file and the
 * current selection since the classic composer, and the React composer has never
 * set any of them — it sends attachments and nothing else. This module owns the
 * switches and the count the composer's Context button shows.
 *
 * The default is ON for every source, and the host treats an absent field as on.
 * So a source that is on emits nothing: sending `true` for each default would make
 * every request carry a context block the user never asked for, which is both
 * slower and less predictable than the thing it is trying to describe.
 */

export interface ContextToggles {
  project: boolean;
  activeFile: boolean;
  selection: boolean;
}

export interface ContextState extends ContextToggles {
  /** How many files or images are attached to the next message. */
  attachments: number;
}

export const DEFAULT_CONTEXT: ContextState = {
  project: true,
  activeFile: true,
  selection: true,
  attachments: 0,
};

export interface ContextToggle {
  id: keyof ContextToggles;
  /** The `ComposerContext` field this switch drives. */
  field: 'includeProjectIndex' | 'includeActiveFile' | 'includeSelection';
  label: string;
  hint: string;
}

export const CONTEXT_TOGGLES: readonly ContextToggle[] = [
  {
    id: 'project',
    field: 'includeProjectIndex',
    label: 'Project intelligence',
    hint: 'Include what the agent has learned about this repository.',
  },
  {
    id: 'activeFile',
    field: 'includeActiveFile',
    label: 'Active file',
    hint: 'Include the file open in the editor.',
  },
  {
    id: 'selection',
    field: 'includeSelection',
    label: 'Selection',
    hint: 'Include the code selected in the editor right now.',
  },
];

/** Read stored switches, replacing anything that is not a boolean. */
export function normalizeContext(value: unknown): ContextState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CONTEXT };
  const input = value as Record<string, unknown>;
  const read = (key: keyof ContextToggles) =>
    typeof input[key] === 'boolean' ? (input[key] as boolean) : DEFAULT_CONTEXT[key];
  const attachments = input.attachments;
  return {
    project: read('project'),
    activeFile: read('activeFile'),
    selection: read('selection'),
    attachments: typeof attachments === 'number' && Number.isFinite(attachments) && attachments > 0
      ? Math.floor(attachments)
      : 0,
  };
}

/**
 * The `ComposerContext` to send: only the switches that are OFF.
 *
 * A field is omitted when the source is on, because the host reads an absent
 * field as on — so emitting `true` would send a context block on every request.
 */
export function contextFor(state: ContextState): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const toggle of CONTEXT_TOGGLES) {
    if (!state[toggle.id]) out[toggle.field] = false;
  }
  return out;
}

/** Flip one switch by id, leaving an unknown id alone. */
export function toggleContext(state: ContextState, id: string, value: boolean): ContextState {
  const match = CONTEXT_TOGGLES.find(toggle => toggle.id === id);
  if (!match) return state;
  return { ...state, [match.id]: value };
}

/**
 * How many things will go into the next request.
 *
 * A promise about the request, so it counts only what is actually sent: a source
 * that is switched off and an attachment that was removed both drop out.
 */
export function contextCount(state: ContextState): number {
  return CONTEXT_TOGGLES.filter(toggle => state[toggle.id]).length + state.attachments;
}

/** The button's label. Zero is stated, not hidden. */
export function contextCountLabel(count: number): string {
  return `Context ${count}`;
}

/** True when nothing at all is going in, which is the panel's empty state. */
export function contextIsEmpty(state: ContextState): boolean {
  return contextCount(state) === 0;
}