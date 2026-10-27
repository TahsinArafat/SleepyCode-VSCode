import test from 'node:test';
import assert from 'node:assert/strict';
import * as empty from '../src/empty-state.ts';

/*
 * The React empty state is three buttons and a title. The classic one had the
 * project's intelligence status with a reindex action, the conversations you were
 * last in, four starter prompts that fill the composer, and the keyboard hints
 * that teach `/`, `@` and Up.
 *
 * Everything here is presentation data derived from state the host already owns,
 * so it is pure and testable. The important rule is that nothing is invented: a
 * starter prompt must be a real prompt, and the recent list must be conversations
 * that actually exist.
 */

test('the four starters each carry a real prompt, not just a label', () => {
  const starters = empty.STARTERS;
  assert.equal(starters.length, 4);
  for (const starter of starters) {
    assert.ok(starter.title, 'a starter needs a title');
    assert.ok(starter.prompt.length > 20, `${starter.title} needs a prompt someone could actually send`);
    assert.ok(starter.description, `${starter.title} needs a description`);
  }
  // The prompts differ, or the grid is four copies of one thing.
  assert.equal(new Set(starters.map(s => s.prompt)).size, starters.length);
});

test('the keyboard hints name the three gestures the composer supports', () => {
  const hints = empty.COMPOSER_HINTS;
  assert.deepEqual(hints.map(h => h.key), ['/', '@', '↑']);
  for (const hint of hints) assert.ok(hint.label, `${hint.key} needs a label`);
});

test('the index card states what the index is doing', () => {
  // Each status gets its own copy, because "Learning this project…" and
  // "N files indexed" are different facts and one message cannot say both.
  assert.equal(empty.indexCard({ status: 'indexing', indexed: 3, total: 10 }).busy, true);
  assert.match(empty.indexCard({ status: 'indexing', indexed: 3, total: 10 }).text, /3\/10/);
  assert.match(empty.indexCard({ status: 'ready', indexed: 120, total: 120 }).text, /120/);
  assert.equal(empty.indexCard({ status: 'ready', indexed: 120, total: 120 }).busy, false);
  assert.match(empty.indexCard({ status: 'error' }).text, /could not|failed|error/i);
  // The action is always the same word, so the control does not rename itself.
  assert.equal(empty.indexCard({ status: 'ready' }).actionLabel, 'Reindex');
  // While indexing there is nothing to press.
  assert.equal(empty.indexCard({ status: 'indexing', indexed: 1, total: 4 }).actionLabel, '');
});

test('the index card falls back to a usable state rather than throwing', () => {
  // The status arrives over a message and can be absent on first paint.
  const card = empty.indexCard(undefined);
  assert.equal(card.visible, false);
  assert.equal(card.text, '');
  const unknown = empty.indexCard({ status: 'nonsense' });
  assert.equal(unknown.visible, false);
});

test('recent conversations exclude archived ones and cap the list', () => {
  const list = [
    { id: 'a', title: 'A', updatedAt: 5 },
    { id: 'b', title: 'B', updatedAt: 4, archivedAt: 9 },
    { id: 'c', title: 'C', updatedAt: 3 },
    { id: 'd', title: 'D', updatedAt: 2 },
    { id: 'e', title: 'E', updatedAt: 1 },
    { id: 'f', title: 'F', updatedAt: 0 },
  ];
  const recent = empty.recentConversations(list);
  // Five non-archived entries and a limit of five: all of them, minus the
  // archived one.
  assert.equal(recent.length, empty.RECENT_LIMIT);
  assert.deepEqual(recent.map(c => c.id), ['a', 'c', 'd', 'e', 'f']);
  // An archived conversation is not "recent"; it is in the archive.
  assert.equal(recent.some(c => c.id === 'b'), false);
});

test('recent conversations keep the order they were given', () => {
  // The host already sorts pinned threads first, so re-sorting here would undo
  // that and make the list disagree with the thread list.
  const list = [
    { id: 'pinned', title: 'P', updatedAt: 1, pinned: true },
    { id: 'newer', title: 'N', updatedAt: 9 },
  ];
  assert.deepEqual(empty.recentConversations(list).map(c => c.id), ['pinned', 'newer']);
});

test('recent conversations survive a missing or junk list', () => {
  assert.deepEqual(empty.recentConversations(undefined), []);
  assert.deepEqual(empty.recentConversations([]), []);
  assert.deepEqual(empty.recentConversations([null, {}, { id: '' }]), []);
});

test('a conversation with no title still has a row', () => {
  const [row] = empty.recentConversations([{ id: 'x', title: '', updatedAt: 1 }]);
  assert.equal(row.title, 'Untitled');
});

test('the empty state only shows the recent list when there is something to show', () => {
  assert.equal(empty.shouldShowRecent([]), false);
  assert.equal(empty.shouldShowRecent(undefined), false);
  assert.equal(empty.shouldShowRecent([{ id: 'a', title: 'A', updatedAt: 1 }]), true);
});