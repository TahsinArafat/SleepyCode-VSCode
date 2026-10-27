/*
 * Personas: a layer of taste, not a second agent.
 *
 * An agent decides what may run (model, tools, instructions). A persona decides
 * how the work reads and what to care about — "answer like a reviewer", "be a
 * security engineer about this". It has no tools and no model of its own, so it
 * composes with whichever agent the conversation is using, and it reaches the
 * model as a section of the system prompt.
 *
 * One active per conversation, with a default for new chats. The prompt text is
 * ours, written for this build's voice; the idea is OpenCursor's (MIT).
 *
 * DOM-free and store-free so the rules live in `test/personas.direct.mjs`.
 */

export interface Persona {
  id: string;
  name: string;
  description: string;
  /** Appended to the system prompt; empty for the default persona. */
  prompt: string;
  builtin?: boolean;
}

/** The "no persona" case. Always present, cannot be redefined. */
export const DEFAULT_PERSONA_ID = 'default';

export const BUILTIN_PERSONAS: readonly Persona[] = [
  {
    id: DEFAULT_PERSONA_ID,
    name: 'Default',
    description: 'No extra instructions. SleepyCode as it ships.',
    prompt: '',
    builtin: true,
  },
  {
    id: 'code-reviewer',
    name: 'Code reviewer',
    description: 'Reads changes the way a careful reviewer would, and says what would break.',
    prompt: `You are reviewing code, not writing a feature. Read the change and ask what breaks: the unhandled error, the empty list, the concurrent write, the caller you did not see. Prefer evidence from the files over assumption. Report the defect and where it lives; keep praise out of it, and say plainly when a change is fine.`,
    builtin: true,
  },
  {
    id: 'security-engineer',
    name: 'Security engineer',
    description: 'Treats input, paths, credentials and commands as hostile until proven otherwise.',
    prompt: `Approach every change as a security engineer. Ask where untrusted input enters, what it can reach, and what it can make the process do. Watch for injection, path traversal, unsafe deserialisation, secrets in logs or commits, and privilege that is wider than the task needs. State the threat concretely before proposing a fix.`,
    builtin: true,
  },
  {
    id: 'data-scientist',
    name: 'Data scientist',
    description: 'Careful with numbers: defines the metric before the analysis.',
    prompt: `Be rigorous with data. Define the metric before computing it, state the denominator, and separate correlation from cause. Call out selection bias, missing values and small samples rather than smoothing them over. Show the calculation behind a number you report, and say what would change the conclusion.`,
    builtin: true,
  },
  {
    id: 'devops-engineer',
    name: 'DevOps engineer',
    description: 'Thinks in deploys, rollbacks and what happens at 3am.',
    prompt: `Think like the person who gets paged. For every change ask how it is deployed, how it is rolled back, what it does on a cold start, and how you would know it broke. Prefer idempotent, observable operations over clever ones, and name the failure mode when you propose a shortcut.`,
    builtin: true,
  },
  {
    id: 'technical-writer',
    name: 'Technical writer',
    description: 'Explains the thing in the reader\u2019s order, not the author\u2019s.',
    prompt: `Write for a reader who has the problem and not the context. Lead with what they can do, keep sentences short, and put the caveat where it is needed rather than at the end. Use the product's own vocabulary, and cut any sentence that only restates the previous one.`,
    builtin: true,
  },
  {
    id: 'teacher',
    name: 'Teacher',
    description: 'Builds the idea up from what the reader already knows.',
    prompt: `Teach rather than announce. Start from what the reader already knows, introduce one new idea at a time, and show a small worked example before generalising. Name the misconception people usually have. Check understanding with a question when it helps, and keep the pace honest rather than flattering.`,
    builtin: true,
  },
];

const BUILTIN_IDS = new Set(BUILTIN_PERSONAS.map((persona) => persona.id));

/** Ids are slugs: they travel through storage and messages. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Stored custom personas, with anything malformed dropped rather than rendered. */
export function normalizeCustomPersonas(value: unknown): Persona[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Persona[] = [];
  for (const entry of value) {
    const candidate = entry as Partial<Persona> | null;
    const id = text(candidate?.id);
    const name = text(candidate?.name);
    const prompt = text(candidate?.prompt);
    // An empty prompt is a persona that looks active and does nothing, and a
    // builtin id would shadow a shipped persona. Both are dropped.
    if (!ID_PATTERN.test(id) || BUILTIN_IDS.has(id) || seen.has(id) || !name || !prompt) continue;
    seen.add(id);
    out.push({ id, name, description: text(candidate?.description) || 'Custom persona', prompt });
  }
  return out;
}

/** Built-ins first, then the user's, in the order they were added. */
export function allPersonas(custom: unknown): Persona[] {
  const own = normalizeCustomPersonas(custom);
  const shadowed = new Set(own.map((persona) => persona.id));
  return [...BUILTIN_PERSONAS.filter((persona) => !shadowed.has(persona.id)), ...own];
}

/** Always returns a persona: an unknown id means the default. */
export function personaById(personas: readonly Persona[], id: unknown): Persona {
  const wanted = text(id);
  const found = personas.find((persona) => persona.id === wanted);
  if (found) return found;
  return personas.find((persona) => persona.id === DEFAULT_PERSONA_ID) ?? BUILTIN_PERSONAS[0]!;
}

/** The text this persona adds to the system prompt; empty means "add nothing". */
export function personaPromptFor(personas: readonly Persona[], id: unknown): string {
  return text(personaById(personas, id).prompt);
}

export interface PersonaDraft {
  id: string;
  name: string;
  description?: string;
  prompt: string;
}

/** Empty string when the draft is saveable, otherwise the reason it is not. */
export function validatePersonaDraft(draft: PersonaDraft, existing: readonly Persona[], options: { isNew: boolean }): string {
  const id = text(draft.id);
  if (!ID_PATTERN.test(id)) return 'The id must be lowercase letters, numbers and hyphens (2–39 characters), and cannot start with a hyphen.';
  if (id === DEFAULT_PERSONA_ID) return 'The default persona is reserved: it means "no extra instructions".';
  if (BUILTIN_IDS.has(id)) return 'That id belongs to a built-in persona. Pick another.';
  if (!text(draft.name)) return 'Give the persona a name.';
  if (!text(draft.prompt)) return 'Write the instructions this persona adds — an empty prompt would change nothing.';
  if (options.isNew && existing.some((persona) => persona.id === id)) return 'A persona with that id already exists.';
  return '';
}

export function personaFromDraft(draft: PersonaDraft): Persona {
  return {
    id: text(draft.id),
    name: text(draft.name),
    description: text(draft.description) || 'Custom persona',
    prompt: text(draft.prompt),
  };
}

/** After a delete: a conversation pointed at the removed persona returns to the default. */
export function afterPersonaRemoved(activeId: unknown, removedId: unknown): string {
  const active = text(activeId) || DEFAULT_PERSONA_ID;
  return active === text(removedId) ? DEFAULT_PERSONA_ID : active;
}