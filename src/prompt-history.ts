/*
 * Up/Down recall of previously sent prompts.
 *
 * The classic composer had this and the React one did not: Up walked back through
 * what you had sent, Down walked forward, and the first Down past the newest
 * returned the half-typed draft the first Up had stowed.
 *
 * All of it is state transitions — an index, the stowed draft, the duplicate and
 * cap rules — so it lives here as pure functions rather than as closures over a
 * textarea. The one piece that needs the composer's selection is a predicate over
 * three numbers, which the caller can supply from either a textarea or the rich
 * editor.
 */

export const PROMPT_HISTORY_LIMIT = 100;

export interface RecallState {
  /** -1 means "not walking"; otherwise the index currently shown. */
  index: number;
  /** What was in the composer when the walk started. */
  draft: string | null;
}

export const IDLE: RecallState = { index: -1, draft: null };

export interface Recall {
  text: string;
  state: RecallState;
}

/**
 * Append a sent prompt. Blank input is not a prompt, and the text just sent is
 * not stored twice in a row — resending unchanged is common, and two identical
 * entries would need two Up presses to get past.
 */
export function recordPrompt(entries: readonly string[], text: unknown): string[] {
  const value = typeof text === 'string' ? text.trim() : '';
  const next = [...entries];
  if (!value) return next;
  if (next[next.length - 1] === value) return next;
  next.push(value);
  // Drop from the front so the most recent prompts survive the cap.
  while (next.length > PROMPT_HISTORY_LIMIT) next.shift();
  return next;
}

/** Walk one entry newer→older. Null when there is nothing to show. */
export function recallOlder(entries: readonly string[], state: RecallState, currentValue: unknown): Recall | null {
  if (!entries.length) return null;
  const draft = state.index === -1 ? (typeof currentValue === 'string' ? currentValue : '') : state.draft;
  // The first press lands on the newest; after that it walks back, and stops at
  // the oldest rather than wrapping (a wrap reads as losing your place).
  const index = state.index === -1 ? entries.length - 1 : Math.max(0, state.index - 1);
  return { text: entries[index] ?? '', state: { index, draft } };
}

/** Walk one entry older→newer, and hand the stowed draft back at the end. */
export function recallNewer(entries: readonly string[], state: RecallState): Recall | null {
  if (!entries.length || state.index === -1) return null;
  if (state.index < entries.length - 1) {
    const index = state.index + 1;
    return { text: entries[index] ?? '', state: { index, draft: state.draft } };
  }
  return { text: state.draft ?? '', state: { ...IDLE } };
}

/**
 * Whether the arrow key should recall rather than move the caret.
 *
 * Recall must never steal a caret the user is aiming: a single-line draft has no
 * vertical movement to make, so the arrow is free; a multi-line one only yields at
 * the edge the arrow would otherwise leave the text at.
 */
export function canRecall(value: unknown, selectionStart: number, selectionEnd: number, older: boolean): boolean {
  const text = typeof value === 'string' ? value : '';
  return canRecallAtEdge(
    text,
    selectionStart === 0 && selectionEnd === 0,
    selectionStart === text.length && selectionEnd === text.length,
    older,
  );
}

/**
 * The same rule stated in edges rather than offsets.
 *
 * The composer's text box is a rich editor, which knows whether the caret is at
 * the start or the end of the document but not as a character offset.
 */
export function canRecallAtEdge(value: unknown, atStart: boolean, atEnd: boolean, older: boolean): boolean {
  const text = typeof value === 'string' ? value : '';
  if (!text.includes('\n')) return true;
  return older ? atStart : atEnd;
}

/**
 * The prompts a conversation already contains, oldest first.
 *
 * Read from the transcript rather than a separate store: those turns are already
 * persisted, so recall works after a reload and there is no second copy to keep
 * in step.
 */
export function promptsFromTurns(turns: readonly any[] | undefined): string[] {
  const out: string[] = [];
  for (const turn of turns ?? []) {
    if (!turn || typeof turn !== 'object' || turn.role !== 'user') continue;
    const text = typeof turn.text === 'string' ? turn.text.trim() : '';
    if (!text) continue;
    // Blank-adjacent duplicates are already handled by recordPrompt; a transcript
    // can still contain the same text twice legitimately, and both are kept.
    out.push(text);
  }
  return out.slice(-PROMPT_HISTORY_LIMIT);
}