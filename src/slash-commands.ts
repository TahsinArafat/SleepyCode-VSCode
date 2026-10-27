/*
 * The slash-command palette.
 *
 * The classic composer had one: thirteen direct actions, five prompt rewrites and
 * `/skill <name> <task>`. The React composer inserts plain text, so a reflex that
 * existed before is gone.
 *
 * Every command declares an OUTCOME rather than a callback, which is what makes it
 * testable without a DOM:
 *   - `messages` — the composer posts these, and each is a message the host
 *     already handles;
 *   - `prompt`   — the composer fills its editor, so the user still sends it;
 *   - `control`  — names a control inside the composer to open, because those have
 *     no host message at all.
 * Nothing here claims to do something it cannot, and a command whose target is
 * missing resolves to null instead of posting a message that cannot work.
 */

export type SlashGroup = 'Ask' | 'Session' | 'Workspace';

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  group: SlashGroup;
}

export interface SlashContext {
  conversationId?: string;
  /** Whether a run is in flight, which compaction and rewinds refuse. */
  running?: boolean;
}

export interface SlashOutcome {
  kind: 'messages' | 'prompt' | 'control';
  messages?: Record<string, unknown>[];
  text?: string;
  control?: 'context' | 'model' | 'agent' | 'approval';
}

/**
 * The commands, in palette order.
 *
 * Groups match the classic palette: what the agent does with the message, what
 * happens to this conversation, and what happens to the workspace.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  // Ask — rewrites of the message you are writing.
  { id: '/plan', label: 'Plan a change', description: 'Ask for a plan before anything is edited.', group: 'Ask' },
  { id: '/fix', label: 'Fix a bug', description: 'Reproduce, find the cause, then fix it.', group: 'Ask' },
  { id: '/review', label: 'Review changes', description: 'Review the workspace changes for defects.', group: 'Ask' },
  { id: '/test', label: 'Write tests', description: 'Add tests for the work that was just done.', group: 'Ask' },
  { id: '/explain', label: 'Explain code', description: 'Explain how something works, with references.', group: 'Ask' },
  { id: '/skill', label: 'Use a skill', description: 'Run an installed skill: /skill <name> <task>.', group: 'Ask' },

  // Session — what happens to this conversation.
  { id: '/new', label: 'New conversation', description: 'Start a fresh conversation in this workspace.', group: 'Session' },
  { id: '/compact', label: 'Compact conversation', description: 'Summarize earlier messages to free context.', group: 'Session' },
  { id: '/context', label: 'Request context', description: 'Choose what the next message includes.', group: 'Session' },
  { id: '/model', label: 'Choose model', description: 'Pick the model for this conversation.', group: 'Session' },
  { id: '/agent', label: 'Choose agent', description: 'Pick which agent handles the next message.', group: 'Session' },
  { id: '/permissions', label: 'Approval mode', description: 'Choose when the agent may act without asking.', group: 'Session' },

  // Workspace — surfaces outside the conversation.
  { id: '/settings', label: 'Settings', description: 'Open SleepyCode settings.', group: 'Workspace' },
  { id: '/usage', label: 'Usage & quota', description: 'See token usage and account quota.', group: 'Workspace' },
  { id: '/marketplace', label: 'Skill marketplace', description: 'Browse and install skills.', group: 'Workspace' },
  { id: '/skills', label: 'Installed skills', description: 'See the skills already installed.', group: 'Workspace' },
  { id: '/memory', label: 'Project memory', description: 'Open what the agent remembers about this project.', group: 'Workspace' },
  { id: '/reindex', label: 'Reindex project', description: 'Rebuild what the agent knows about this repository.', group: 'Workspace' },
];

/** A context for the commands that need only a conversation. */
export function directContext(conversationId: string | undefined, running = false): SlashContext {
  return { conversationId, running };
}

/**
 * Prompt rewrites.
 *
 * Written as instructions rather than as labels: `/plan x` has to produce a prompt
 * the agent can act on, and the subject has to survive it. `{subject}` is replaced
 * with what the user typed, or with the fallback when they typed nothing.
 */
const REWRITES: Record<string, { template: string; fallback: string }> = {
  '/plan': {
    template: 'Make a plan for this, and do not edit anything yet: {subject}\n\nWrite the plan to a file with ordered steps, and name the files each step touches.',
    fallback: 'Make a plan for the change I describe next, and do not edit anything yet. Write it to a file with ordered steps, and name the files each step touches.',
  },
  '/fix': {
    template: 'Fix this bug: {subject}\n\nReproduce it first, find the root cause, then make the smallest fix and add a regression test.',
    fallback: 'Fix a bug in this workspace. Ask me what happens, reproduce it, find the root cause, then make the smallest fix and add a regression test.',
  },
  '/review': {
    template: 'Review this for correctness, security, regressions and missing tests: {subject}\n\nReport findings by severity with file and line references.',
    fallback: 'Review the changes in this workspace for correctness, security, regressions and missing tests. Report findings by severity with file and line references.',
  },
  '/test': {
    template: 'Add tests for this: {subject}\n\nCover the behaviour that matters and the edge cases that could break it; run them and report the result.',
    fallback: 'Add tests for the work that was just done. Cover the behaviour that matters and the edge cases that could break it; run them and report the result.',
  },
  '/explain': {
    template: 'Explain how this works, with file and line references: {subject}',
    fallback: 'Explain how the main parts of this project work, with file and line references.',
  },
};

/** Fill one rewrite, keeping the subject when there is one. */
function expand(name: string, args: string): SlashOutcome {
  const rewrite = REWRITES[name]!;
  const subject = args.trim();
  const text = subject
    ? rewrite.template.replace('{subject}', subject)
    : rewrite.fallback;
  return { kind: 'prompt', text };
}

/**
 * What a command does, or null when it cannot run.
 *
 * Returning null rather than a message that names an empty conversation is the
 * point: the host resolves a conversation from the id, so posting one without it is
 * a request that quietly does nothing.
 */
export function runSlashCommand(name: string, args: string, context: SlashContext): SlashOutcome | null {
  const conversationId = typeof context.conversationId === 'string' ? context.conversationId : '';

  if (REWRITES[name]) return expand(name, args);

  if (name === '/skill') {
    // Parsed by the host's skill loader, which reads the name from the prompt.
    // With no name there is nothing to run, so ask rather than invent one.
    const trimmed = args.trim();
    if (!trimmed) {
      return {
        kind: 'prompt',
        text: 'Use an installed skill for the task I describe next. Ask me which skill if it is ambiguous.',
      };
    }
    const [skill, ...rest] = trimmed.split(/\s+/);
    const task = rest.join(' ').trim();
    return {
      kind: 'prompt',
      text: task
        ? `Use the "${skill}" skill for this task: ${task}`
        : `Use the "${skill}" skill for the task I describe next.`,
    };
  }

  switch (name) {
    case '/new':
      return { kind: 'messages', messages: [{ type: 'newConversation' }] };
    case '/compact':
      if (!conversationId || context.running) return null;
      return { kind: 'messages', messages: [{ type: 'compact', conversationId }] };
    case '/reindex':
      return { kind: 'messages', messages: [{ type: 'reindexProject' }] };
    case '/memory':
      return { kind: 'messages', messages: [{ type: 'openMemory' }] };
    case '/settings':
      return { kind: 'messages', messages: [{ type: 'openSettings' }] };
    case '/usage':
      return { kind: 'messages', messages: [{ type: 'openSettings', section: 'usage' }] };
    case '/marketplace':
      return { kind: 'messages', messages: [{ type: 'openSettings', section: 'marketplace' }] };
    case '/skills':
      return { kind: 'messages', messages: [{ type: 'openSettings', section: 'marketplace' }] };
    // These have no host message; they open a control in the composer.
    case '/context':
      return { kind: 'control', control: 'context' };
    case '/model':
      return { kind: 'control', control: 'model' };
    case '/agent':
      return { kind: 'control', control: 'agent' };
    case '/permissions':
      return { kind: 'control', control: 'approval' };
    default:
      return null;
  }
}

/**
 * The command at the start of a string, split from its argument.
 *
 * Only a slash at the very start counts, so a path or a URL typed as prose does
 * not become a command.
 */
export function parseSlash(value: unknown): { name: string; args: string } | null {
  const text = typeof value === 'string' ? value : '';
  const match = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  return { name: match[1]!, args: (match[2] ?? '').trim() };
}

/** Whether the palette should be open for what is in the composer. */
export function slashOpen(value: unknown): boolean {
  const text = typeof value === 'string' ? value : '';
  return /^\/\S*$/.test(text);
}

/**
 * Commands matching what has been typed.
 *
 * Matched on the command name only — matching descriptions makes `/settings`
 * surface unrelated commands whose text happens to mention settings. A command is
 * still offered once arguments follow, because the menu vanishing the moment the
 * user starts describing what they want is the thing that makes a palette useless.
 */
export function matchSlashCommands(value: unknown): SlashCommand[] {
  const text = typeof value === 'string' ? value : '';
  const parsed = parseSlash(text);
  const query = parsed ? parsed.name : (text.trim().split(/\s+/)[0] ?? '');
  if (!query.startsWith('/')) return [];
  const prefix = query.toLowerCase();
  return SLASH_COMMANDS.filter(command => command.id.startsWith(prefix));
}