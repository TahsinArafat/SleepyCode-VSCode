/**
 * Tool-payload shaping for the transcript's tool cards.
 *
 * ## Why this exists
 *
 * A tool row used to carry nothing but a display label — `humanToolName(name) · summarizeInput(...)`
 * — squashed onto one line. For a developer audience that is the worst possible summary of a shell
 * command: you cannot see the arguments, the output, or how long it took, so you have to open the
 * extension output channel and re-derive what the agent actually did.
 *
 * This module turns the raw tool input/output into two short, safe display strings. It is pure and
 * dependency-free so it can be unit-tested directly (`test/tool-payload-core.direct.mjs`) and shared
 * by every producer of `type: 'tool'` messages — the local agent loop, subagent tool calls, and the
 * CLI projection.
 *
 * ## The one non-obvious decision: head vs. tail
 *
 * Arguments are truncated from the **head**: they are short and the leading keys identify the call.
 *
 * Results are truncated from the **tail**: output is long and the *end* is where the failure is. A
 * head-truncated `stderr` shows you the command banner and throws away the error, which is precisely
 * the information the user opened the card to find. The marker always states how much was dropped so
 * the truncation is never silent.
 */

/** Arguments are short; 4 KB is far beyond any real tool call and keeps the card cheap to render. */
export const TOOL_ARGS_MAX = 4 * 1024;
/** Output is unbounded; 16 KB tail-biased keeps the error visible without bloating the DOM. */
export const TOOL_RESULT_MAX = 16 * 1024;

/** Keeps the first `max` characters and says how much was cut. */
export function truncateHead(text: string, max: number, marker = '…'): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return text.slice(0, max).replace(/\s+$/, '') + `\n${marker} ${dropped} more character${dropped === 1 ? '' : 's'} hidden`;
}

/**
 * Keeps the last `max` characters and says how much was cut.
 *
 * Lines are dropped from the front rather than sliced mid-line where possible, so the block stays
 * aligned and the final line — the one that actually failed — is always intact.
 */
export function truncateTail(text: string, max: number, marker = '…'): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  let tail = text.slice(text.length - max);
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl + 1 < tail.length) tail = tail.slice(nl + 1);
  return `${marker} ${dropped} earlier character${dropped === 1 ? '' : 's'} hidden\n` + tail;
}

/**
 * Best-effort JSON for an arbitrary tool input.
 *
 * Tool inputs arrive from the model as JSON objects, but the same field is fed strings by the CLI
 * bridge, so both are handled. Cycles and over-deep nesting are tolerated: a transcript that
 * renders is worth far more than one that throws while formatting a payload.
 */
function safeStringify(value: unknown, depth = 0): string {
  if (depth > 6) return '"…"';
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'function') return undefined;
        if (typeof val === 'bigint') return String(val);
        if (val && typeof val === 'object') {
          if (seen.has(val as object)) return '"[circular]"';
          seen.add(val as object);
        }
        return val;
      },
      2,
    ) ?? '';
  } catch {
    return '';
  }
}

/** Display string for a tool call's arguments. Never throws; always returns a string. */
export function toolArgsText(input: unknown, max = TOOL_ARGS_MAX): string {
  if (input == null) return '';
  let text: string;
  if (typeof input === 'string') text = input;
  else text = safeStringify(input);
  return text ? truncateHead(text, max) : '';
}

/**
 * Display string for a tool call's output.
 *
 * Understands the AI SDK's result envelope so the card shows the payload rather than the wrapper:
 * `{type:'text', value}` unwraps to the text, `{type:'tool-error', error}` surfaces the message, and
 * anything else falls back to pretty JSON. Tail-biased — see the module comment.
 */
export function toolResultText(output: unknown, max = TOOL_RESULT_MAX): string {
  if (output == null) return '';
  let text = '';
  if (typeof output === 'string') text = output;
  else if (typeof output === 'object') {
    const out = output as { type?: string; value?: unknown; error?: unknown };
    if (out.type === 'text' && typeof out.value === 'string') text = out.value;
    else if (out.type === 'json') text = safeStringify(out.value);
    else if (out.type === 'tool-error') {
      const err = out.error as { message?: unknown } | string | undefined;
      if (typeof err === 'string') text = err;
      else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
        text = (err as { message: string }).message;
      } else text = safeStringify(out.error);
    } else text = safeStringify(output);
  } else text = String(output);
  return text ? truncateTail(text, max) : '';
}

/** Elapsed milliseconds, clamped to a non-negative whole number, or undefined when unknown. */
export function durationMs(startedAt: number | undefined, endedAt: number = Date.now()): number | undefined {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  return Math.max(0, Math.round(endedAt - startedAt));
}
