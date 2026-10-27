import test from 'node:test';
import assert from 'node:assert/strict';
import * as history from '../src/prompt-history.ts';

/*
 * The classic composer let Up walk back through what you had already sent, with
 * one Down to get your half-typed draft back. The React composer has no recall at
 * all, so the classic one had a reflex the new one lost.
 *
 * The model is extracted here because it is all state transitions — index, stowed
 * draft, the duplicate and cap rules — and none of it needs a DOM. The part that
 * does need one (does the caret have anywhere to go?) is a predicate taking three
 * numbers.
 */

const state = (index, draft = null) => ({ index, draft });

test('a sent prompt is appended, blank ones are ignored', () => {
  assert.deepEqual(history.recordPrompt([], 'hello'), ['hello']);
  assert.deepEqual(history.recordPrompt(['a'], '  spaced  '), ['a', 'spaced'], 'trimmed before storing');
  assert.deepEqual(history.recordPrompt(['a'], '   '), ['a'], 'whitespace is not a prompt');
  assert.deepEqual(history.recordPrompt(['a'], ''), ['a']);
  assert.deepEqual(history.recordPrompt(['a'], undefined), ['a']);
});

test('the same prompt twice in a row is stored once', () => {
  // Resending unchanged is common; two identical entries would need two Up
  // presses to escape.
  assert.deepEqual(history.recordPrompt(['a'], 'a'), ['a']);
  // But the same text later is a real second use and is kept.
  assert.deepEqual(history.recordPrompt(['a', 'b'], 'a'), ['a', 'b', 'a']);
});

test('history is capped, dropping the oldest', () => {
  const entries = Array.from({ length: history.PROMPT_HISTORY_LIMIT }, (_, i) => `p${i}`);
  const next = history.recordPrompt(entries, 'newest');
  assert.equal(next.length, history.PROMPT_HISTORY_LIMIT);
  assert.equal(next[next.length - 1], 'newest');
  assert.equal(next[0], 'p1', 'the oldest fell off');
});

test('recordPrompt never mutates the list it is given', () => {
  const entries = ['a'];
  history.recordPrompt(entries, 'b');
  assert.deepEqual(entries, ['a']);
});

test('the first Up stows the draft and shows the newest entry', () => {
  const entries = ['oldest', 'middle', 'newest'];
  const first = history.recallOlder(entries, state(-1), 'half typed');
  assert.equal(first?.text, 'newest');
  assert.equal(first?.state.index, 2);
  assert.equal(first?.state.draft, 'half typed', 'the draft is kept so Down can bring it back');
  // Then it walks back one at a time.
  assert.equal(history.recallOlder(entries, first.state, 'ignored')?.text, 'middle');
  const oldest = history.recallOlder(entries, history.recallOlder(entries, first.state, '')?.state, '');
  assert.equal(oldest?.text, 'oldest');
  assert.equal(oldest?.state.index, 0);
});

test('Up at the oldest entry stays there rather than wrapping', () => {
  // Wrapping would silently jump to the newest prompt, which reads as data loss.
  const atOldest = history.recallOlder(['only'], state(0), '');
  assert.equal(atOldest?.text, 'only');
  assert.equal(atOldest?.state.index, 0);
});

test('Down walks forward and finally restores the draft', () => {
  const entries = ['oldest', 'newest'];
  const back = history.recallOlder(entries, state(-1), 'my draft');
  const down = history.recallNewer(entries, back.state);
  assert.equal(down.text, 'my draft');
  assert.equal(down.state.index, -1, 'back to typing');
  assert.equal(down.state.draft, null, 'the draft is handed back only once');
});

test('Down before any Up does nothing', () => {
  // Otherwise it would clear the composer or insert an empty history entry.
  assert.equal(history.recallNewer(['a'], state(-1)), null);
  assert.equal(history.recallOlder([], state(-1)), null);
});

test('recall with no history does nothing at all', () => {
  assert.equal(history.recallOlder([], state(-1), 'draft'), null);
  assert.equal(history.recallNewer([], state(0)), null);
});

test('a single-line draft always yields the arrow keys', () => {
  // There is no vertical movement to make, so recall is the only meaning Up has.
  assert.equal(history.canRecall('one line', 0, 0, true), true);
  assert.equal(history.canRecall('one line', 4, 4, false), true);
  assert.equal(history.canRecall('', 0, 0, true), true);
});

test('a multi-line draft keeps the caret where it is aiming', () => {
  // Up inside a multi-line draft must move the caret to the previous line
  // first; recall only takes over at the edge the arrow would leave the text at.
  const value = 'first line\nsecond line';
  assert.equal(history.canRecall(value, 0, 0, true), true, 'at the very start, Up recalls');
  assert.equal(history.canRecall(value, 5, 5, true), false, 'mid-text, Up moves the caret');
  assert.equal(history.canRecall(value, value.length, value.length, false), true, 'at the very end, Down restores');
  assert.equal(history.canRecall(value, 5, 5, false), false, 'mid-text, Down moves the caret');
  // A selection inside the text is not the edge either.
  assert.equal(history.canRecall(value, 2, 6, true), false);
});

test('recording resets the walk, so the next Up starts from the newest', () => {
  // After sending, the composer is empty and there is nothing stowed.
  const entries = history.recordPrompt(['a'], 'b');
  assert.deepEqual(entries, ['a', 'b']);
  const first = history.recallOlder(entries, state(-1), '');
  assert.equal(first?.text, 'b');
});
test('the edge form states the same rule the offset form does', () => {
  // The rich editor knows edges, not offsets; both must agree or the arrow key
  // would behave differently in the two composers.
  const value = 'a\nb';
  for (const older of [true, false]) {
    assert.equal(
      history.canRecallAtEdge(value, true, false, older),
      history.canRecall(value, 0, 0, older),
      `start edge, older=${older}`,
    );
    assert.equal(
      history.canRecallAtEdge(value, false, true, older),
      history.canRecall(value, value.length, value.length, older),
      `end edge, older=${older}`,
    );
    assert.equal(
      history.canRecallAtEdge(value, false, false, older),
      history.canRecall(value, 1, 1, older),
      `middle, older=${older}`,
    );
  }
  // Single line: the arrow is free regardless of where the caret is.
  assert.equal(history.canRecallAtEdge('one line', false, false, true), true);
});

test('history is read from the transcript, so it survives a reload', () => {
  const turns = [
    { role: 'user', text: 'first prompt' },
    { role: 'assistant', text: 'a reply' },
    { role: 'user', text: '  second prompt  ' },
    { role: 'user', text: '   ' },
    null,
    { role: 'user' },
  ];
  assert.deepEqual(history.promptsFromTurns(turns), ['first prompt', 'second prompt']);
  assert.deepEqual(history.promptsFromTurns(undefined), []);
  assert.deepEqual(history.promptsFromTurns([]), []);
  // Non-user turns are never recall candidates.
  assert.deepEqual(history.promptsFromTurns([{ role: 'assistant', text: 'nope' }]), []);
});
