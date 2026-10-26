/**
 * Turning pasted code into a mention.
 *
 * When code is pasted into the composer, the webview asks the host to locate its
 * source so the message can reference `@file` instead of pasting a wall of text.
 * These are the pure decisions involved: which line to search for, and what a
 * match looks like as a mention.
 *
 * Dependency-free so the direct test runner can exercise it.
 */

/** A mention the composer understands. */
export interface CodeMention {
  kind: 'code';
  path: string;
  name: string;
  detail?: string;
}

/** Below this a line matches too many places to identify a file. */
const MIN_LINE_LENGTH = 12;

/**
 * Lines that appear in almost every file, or carry no identifier to match on.
 * Searching for one of these would either match nothing useful or everything.
 */
const NOISE = new Set([
  '}', '{', '});', ');', ']', '};', 'end', 'return', 'else {', 'break;', 'continue;',
]);

/**
 * Pick the line worth searching for.
 *
 * The longest non-noise line is chosen because it carries the most identifiers,
 * which is what makes a match specific. Returns `undefined` when nothing is
 * distinctive enough — the caller then treats the paste as plain text rather
 * than guessing a file.
 */
export function pastedCodeSearchLine(text: string | undefined): string | undefined {
  const candidates = (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_LINE_LENGTH && !NOISE.has(line.toLowerCase()))
    // A line with no letters or digits cannot identify anything.
    .filter((line) => /[\p{L}\p{N}]/u.test(line));

  if (!candidates.length) return undefined;
  // Longest wins; ties keep the earliest line so the reported line number is the
  // first occurrence in the paste.
  return candidates.reduce((best, line) => (line.length > best.length ? line : best), candidates[0]!);
}

/** A located match as a mention, or `undefined` when nothing was found. */
export function toCodeMention(match: { path: string; line: number } | undefined | null): CodeMention | undefined {
  if (!match || !match.path) return undefined;
  const name = match.path.split(/[/\\]/).pop() || match.path;
  return {
    kind: 'code',
    path: match.path,
    name,
    detail: `line ${match.line}`,
  };
}