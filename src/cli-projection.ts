/**
 * Projection of CLI sessions (message/part rows) into the sidebar's transcript
 * items. The webview keeps rendering the same cards it already has; this module
 * only decides what those cards show.
 *
 * Deliberately import-free of `vscode` and of any transport: given the rows the
 * CLI returned, it is a pure function. That keeps the UI mapping unit-testable
 * without a server, and keeps SQLite out of the extension host.
 *
 * The CLI owns the run loop, so there is no second harness here: this maps
 * parts onto `TranscriptItem`/`WorkItem` and never builds model-visible history.
 */

import type { TranscriptItem, WorkItem } from './types';

/**
 * Maps a CLI tool name and its input to the sidebar's row label ("Reading
 * file"). The caller injects `toolTask` from ./util; keeping it injected means
 * this module stays import-free and unit-testable without a bundler resolving
 * extensionless imports.
 */
export type ToolLabel = (tool: string, input: unknown) => string;

const defaultLabel: ToolLabel = tool => tool;

/** A part row as the CLI returns it. Only the fields the sidebar renders. */
export type CliPart = {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  summary?: string;
  synthetic?: boolean;
  step?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    title?: string;
  };
  error?: { message?: string; name?: string; data?: unknown } | string;
};

export type CliMessageInfo = {
  id?: string;
  role?: string;
  sessionID?: string;
  providerID?: string;
  modelID?: string;
  finish?: string;
  error?: { message?: string; name?: string; data?: unknown } | string | null;
  time?: { created?: number; completed?: number };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
};

export type CliMessage = { info: CliMessageInfo; parts?: CliPart[] };

function errorText(error: CliPart['error']): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') return error;
  return error.message ?? (error.name ? String(error.name) : undefined);
}

function isDone(state: CliPart['state']): boolean {
  const status = state?.status;
  return status === 'completed';
}

function isFailed(state: CliPart['state']): boolean {
  const status = state?.status;
  return status === 'error' || status === 'aborted';
}

/** One tool part as an activity row on the assistant item. */
export function toolWorkItem(part: CliPart, label: ToolLabel = defaultLabel): WorkItem {
  const failed = isFailed(part.state);
  const item: WorkItem = {
    kind: 'task',
    text: label(part.tool ?? 'tool', part.state?.input),
    tool: part.tool,
    done: isDone(part.state),
  };
  // A tool that never completed stays visibly unfinished so the user can tell the
  // turn was cut short rather than finished.
  if (failed) item.interrupted = true;
  if (part.state?.title) item.title = part.state.title;
  return item;
}

/**
 * True when the CLI can still resume this assistant turn. The CLI resumes by
 * id, so an unfinished assistant is the only thing worth offering Continue for.
 */
export function recoverableAssistant(info: CliMessageInfo): boolean {
  if (!info) return false;
  if (info.role && info.role !== 'assistant') return false;
  if (info.error) return true;
  const finish = info.finish;
  // No terminal stop means the turn never finished, so the CLI can resume it.
  if (!finish) return true;
  return finish === 'tool-calls' || finish === 'length' || finish === 'error' || finish === 'aborted';
}

/**
 * Project one message's parts into transcript items. A user turn becomes a user
 * item; an assistant turn becomes one assistant item whose `work` carries
 * reasoning and tool rows, so the cards stay the ones the sidebar already draws.
 */
export function projectParts(parts: CliPart[], role: string, label: ToolLabel = defaultLabel): TranscriptItem[] {
  const stamp = Date.now();
  const reasoning: WorkItem[] = [];
  const tasks: WorkItem[] = [];
  const texts: string[] = [];
  const dividers: TranscriptItem[] = [];
  let errorMessage: string | undefined;

  for (const part of parts ?? []) {
    switch (part.type) {
      case 'text':
        if (part.text?.trim()) texts.push(part.text);
        break;
      case 'reasoning':
        if (part.text?.trim()) reasoning.push({ kind: 'reasoning', text: part.text });
        break;
      case 'tool':
        tasks.push(toolWorkItem(part, label));
        break;
      case 'compaction':
        dividers.push({
          id: part.id ?? `divider-${stamp}`,
          role: 'assistant',
          text: part.summary ?? 'Earlier context was compacted.',
          kind: 'divider',
          timestamp: stamp,
        });
        break;
      case 'error':
        errorMessage = errorText(part.error) ?? 'The turn failed.';
        break;
      default:
        // step-start/step-finish and unknown rows are progress, not transcript.
        break;
    }
  }

  const items: TranscriptItem[] = [...dividers];
  if (role === 'user') {
    if (texts.length) {
      items.push({ id: parts[0]?.id ?? `user-${stamp}`, role: 'user', text: texts.join('\n\n'), timestamp: stamp });
    }
    return items;
  }

  const work = [...reasoning, ...tasks];
  if (errorMessage) {
    items.push({
      id: parts[0]?.id ?? `error-${stamp}`,
      role: 'assistant',
      text: errorMessage,
      kind: 'error',
      timestamp: stamp,
      work: work.length ? work : undefined,
      errorInfo: { code: 'unknown', title: 'Turn failed', message: errorMessage, retryable: true },
    });
    return items;
  }

  if (texts.length || work.length) {
    items.push({
      id: parts[0]?.id ?? `assistant-${stamp}`,
      role: 'assistant',
      text: texts.join('\n\n'),
      timestamp: stamp,
      work: work.length ? work : undefined,
    });
  }
  return items;
}

/** Project one CLI message row into transcript items. */
export function projectMessage(message: CliMessage, label: ToolLabel = defaultLabel): TranscriptItem[] {
  const info = message?.info ?? {};
  const items = projectParts(message?.parts ?? [], info.role === 'user' ? 'user' : 'assistant', label);
  const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined;
  for (const item of items) {
    if (item.kind === 'divider') continue;
    if (model) item.model = model;
    if (info.time?.created) item.timestamp = info.time.created;
  }
  return items;
}
