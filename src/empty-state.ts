/*
 * The chat's empty state.
 *
 * The React one is a title and three buttons. The classic had the project's
 * intelligence status with a reindex action, the conversations you were last in,
 * four starter prompts that fill the composer, and the keyboard hints that teach
 * `/`, `@` and Up.
 *
 * All of it is presentation derived from state the host already owns, so it lives
 * here as pure functions. Two rules: nothing is invented (a starter prompt must be
 * a prompt someone could send, and the recent list must be conversations that
 * exist), and nothing reorders what the host sorted — pinned threads stay first
 * because that is where the host put them.
 */

export interface Starter {
  title: string;
  description: string;
  prompt: string;
}

/** Prompts that fill the composer. Real prompts, not labels. */
export const STARTERS: readonly Starter[] = [
  {
    title: 'Explore the code',
    description: 'Get oriented in an unfamiliar repository.',
    prompt: 'Give me a tour of this repository: what it does, how it is structured, and where the main entry points are.',
  },
  {
    title: 'Fix a bug',
    description: 'Reproduce it, find the cause, prove the fix.',
    prompt: 'Help me fix a bug. Ask me what happens, reproduce it, find the root cause, then make the smallest fix and add a regression test.',
  },
  {
    title: 'Make a plan',
    description: 'Design before editing anything.',
    prompt: 'Make a plan for a change I want to make. Ask what I am trying to achieve, then write the plan to a file with ordered steps and the files each one touches.',
  },
  {
    title: 'Review my changes',
    description: 'Look for correctness and regressions.',
    prompt: 'Review the changes in this workspace for correctness, security, regressions and missing tests. Report findings by severity with file and line references.',
  },
];

/** The gestures the composer supports, shown under the starter grid. */
export const COMPOSER_HINTS: readonly { key: string; label: string }[] = [
  { key: '/', label: 'commands' },
  { key: '@', label: 'files and context' },
  { key: '↑', label: 'recall a prompt' },
];

export interface IndexStatus {
  status?: string;
  indexed?: number;
  total?: number;
  text?: string;
}

export interface IndexCard {
  visible: boolean;
  busy: boolean;
  text: string;
  actionLabel: string;
}

/**
 * The project-intelligence row.
 *
 * The status arrives over a message and can be absent on first paint, so an
 * unrecognised or missing status hides the row rather than rendering an empty
 * card. While indexing there is nothing to press, so the action label is empty
 * instead of a disabled "Reindex".
 */
export function indexCard(status: IndexStatus | undefined): IndexCard {
  const state = typeof status?.status === 'string' ? status.status : '';
  if (state === 'indexing') {
    const indexed = Number(status?.indexed ?? 0);
    const total = Number(status?.total ?? 0);
    return {
      visible: true,
      busy: true,
      text: status?.text || (total > 0 ? `Indexing ${indexed}/${total} files…` : 'Learning this project…'),
      actionLabel: '',
    };
  }
  if (state === 'ready') {
    const indexed = Number(status?.indexed ?? 0);
    return {
      visible: true,
      busy: false,
      text: status?.text || `${indexed} file${indexed === 1 ? '' : 's'} indexed`,
      actionLabel: 'Reindex',
    };
  }
  if (state === 'error') {
    return {
      visible: true,
      busy: false,
      text: status?.text || 'The project could not be indexed. Reindexing will try again.',
      actionLabel: 'Reindex',
    };
  }
  return { visible: false, busy: false, text: '', actionLabel: '' };
}

export interface RecentConversation {
  id: string;
  title: string;
  updatedAt: number;
  archivedAt?: number;
  pinned?: boolean;
}

/** How many conversations the empty state lists. */
export const RECENT_LIMIT = 5;

/**
 * The conversations to list, in the order the host gave them.
 *
 * Archived threads are excluded — they are in the archive, which is what
 * archiving means — and entries without an id are dropped, because a row that
 * cannot be opened is worse than one that is not shown.
 */
export function recentConversations(list: readonly unknown[] | undefined): RecentConversation[] {
  const out: RecentConversation[] = [];
  for (const entry of list ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const conversation = entry as { id?: unknown; title?: unknown; updatedAt?: unknown; archivedAt?: unknown; pinned?: unknown };
    if (typeof conversation.id !== 'string' || !conversation.id) continue;
    if (conversation.archivedAt) continue;
    out.push({
      id: conversation.id,
      title: typeof conversation.title === 'string' && conversation.title ? conversation.title : 'Untitled',
      updatedAt: typeof conversation.updatedAt === 'number' ? conversation.updatedAt : 0,
      pinned: conversation.pinned === true,
    });
    if (out.length >= RECENT_LIMIT) break;
  }
  return out;
}

/** Whether the empty state has a recent list to show at all. */
export function shouldShowRecent(list: readonly unknown[] | undefined): boolean {
  return recentConversations(list).length > 0;
}