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
 * Pull a human-readable reason out of a CLI error value.
 *
 * The wire shape is a union of `{ name, data: { message } }` variants
 * (`UnknownError`, `ProviderAuthError`, `APIError`, ...) plus the optional bare
 * string, verified against sleepy 0.1.19. Reading `error.message` is wrong --
 * there is no top-level `message`, only `data.message` -- so a failed turn
 * rendered the bare name ("UnknownError") and hid the actual cause, which is
 * the one thing the reader needed ("Model not found: sleepy/auto-best-coding").
 *
 * `name` is a deliberate last resort, never the first: a category name tells
 * the reader nothing about what went wrong.
 */
export function cliErrorText(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error.trim() || undefined;
  if (typeof error !== 'object') return String(error);
  const { data, message, name } = error as { data?: { message?: unknown }; message?: unknown; name?: unknown };
  if (data && typeof data.message === 'string' && data.message.trim()) return data.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (typeof name === 'string' && name.trim()) return name;
  return undefined;
}

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
  return cliErrorText(error);
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

/**
 * A projected CLI assistant item whose turn never finished. `recoverableAssistant`
 * decides which message rows the CLI can resume; the sidebar shows its paused
 * card for exactly those, so Continue is offered and handled by the same engine
 * that owns the transcript. Local paused items keep their own flags, which this
 * never sets.
 */
export function projectPausedAssistant(info: CliMessageInfo): { paused: true; pauseLimit?: number } | undefined {
  if (!recoverableAssistant(info)) return undefined;
  return { paused: true, pauseLimit: undefined };
}

/**
 * Keep the paused card on exactly one row: the newest assistant item, and only
 * while the session is idle.
 *
 * `projectMessage` flags every recoverable assistant row, because it sees one
 * message at a time. Two of those flags are wrong in the full transcript: an
 * older aborted turn stays recoverable forever but resuming it would fork the
 * newest history, and a turn that is streaming right now has no `finish` yet so
 * it looks recoverable while it is actually running. The projection consumer
 * calls this after flattening, so only a genuinely idle, newest unfinished turn
 * offers Continue.
 */
export function applyPausedProjection(items: TranscriptItem[], busy: boolean): void {
  let lastAssistant = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role === 'assistant' && item.kind !== 'divider') {
      lastAssistant = index;
      break;
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item?.paused) continue;
    if (busy || index !== lastAssistant) {
      item.paused = undefined;
      item.pauseLimit = undefined;
    }
  }
}

/** Project one CLI message row into transcript items. */
export function projectMessage(message: CliMessage, label: ToolLabel = defaultLabel): TranscriptItem[] {
  const info = message?.info ?? {};
  const items = projectParts(message?.parts ?? [], info.role === 'user' ? 'user' : 'assistant', label);
  const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined;
  // An unfinished assistant turn gets the paused card so Continue is offered;
  // the continueIteration handler routes that back to the CLI engine.
  const paused = info.role !== 'user' ? projectPausedAssistant(info) : undefined;
  for (const item of items) {
    if (item.kind === 'divider') continue;
    if (model) item.model = model;
    if (info.time?.created) item.timestamp = info.time.created;
    if (paused) {
      item.paused = true;
      item.pauseLimit = paused.pauseLimit;
    }
  }
  return items;
}
