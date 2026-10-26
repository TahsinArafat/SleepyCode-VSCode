import test from 'node:test';
import assert from 'node:assert/strict';
import * as q from '../src/queue-core.ts';

/*
 * The host's follow-up queue is one global FIFO array (`AgentViewProvider.queue`),
 * but the UI shows it per conversation. Draining prefers the first entry for the
 * conversation that just finished, falling back to the head of the array.
 *
 * React offers three per-row actions the host had no way to express: "Send now",
 * "Move earlier", and "Edit message". The ordering half of those is pure — which
 * entry ends up first for its conversation — so it lives here rather than inside
 * the vscode-bound provider, and it is tested directly.
 */

const entry = (id, conversationId) => ({ id, conversationId });

// Two conversations interleaved, so "front" and "up" cannot be confused with
// "index 0" and "index - 1" of the whole array.
const mixed = () => [
  entry('a1', 'A'),
  entry('b1', 'B'),
  entry('a2', 'A'),
  entry('a3', 'A'),
  entry('b2', 'B'),
];

test('removeEntry drops only the named entry', () => {
  const out = q.removeEntry(mixed(), 'a2');
  assert.deepEqual(out.map(e => e.id), ['a1', 'b1', 'a3', 'b2']);
  // Unknown ids and empty queues are left exactly as they were.
  assert.deepEqual(q.removeEntry(mixed(), 'nope').map(e => e.id), mixed().map(e => e.id));
  assert.deepEqual(q.removeEntry([], 'a1'), []);
});

test('removeEntry never mutates its input', () => {
  const input = mixed();
  q.removeEntry(input, 'a1');
  q.promoteToFront(input, 'a3');
  q.moveUp(input, 'b2');
  assert.deepEqual(input.map(e => e.id), ['a1', 'b1', 'a2', 'a3', 'b2']);
});

test('promoteToFront puts an entry first for ITS conversation only', () => {
  // a3 is third among A but last in the array; after promoting it must run
  // before a1 and a2, while B's own order is untouched.
  assert.deepEqual(q.promoteToFront(mixed(), 'a3').map(e => e.id), ['a3', 'b1', 'a1', 'a2', 'b2']);
  // The same for B, to prove it is not an "index 0" coincidence.
  assert.deepEqual(q.promoteToFront(mixed(), 'b2').map(e => e.id), ['a1', 'b2', 'a2', 'a3', 'b1']);
});

test('promoteToFront is a no-op for the entry already first', () => {
  assert.deepEqual(q.promoteToFront(mixed(), 'a1').map(e => e.id), mixed().map(e => e.id));
  assert.deepEqual(q.promoteToFront([entry('a1', 'A')], 'a1').map(e => e.id), ['a1']);
});

test('promoteToFront ignores an unknown id', () => {
  assert.deepEqual(q.promoteToFront(mixed(), 'nope').map(e => e.id), mixed().map(e => e.id));
});

test('moveUp swaps with the previous entry of the SAME conversation', () => {
  // a3 moves above a2 but must not jump over b1.
  assert.deepEqual(q.moveUp(mixed(), 'a3').map(e => e.id), ['a1', 'b1', 'a3', 'a2', 'b2']);
  // b2 is B's second entry; it takes b1's slot at index 1, crossing a2 and a3 on
  // the way — those belong to another conversation and must not shift.
  assert.deepEqual(q.moveUp(mixed(), 'b2').map(e => e.id), ['a1', 'b2', 'a2', 'a3', 'b1']);
  // a2 is A's second entry, so it takes a1's slot at index 0.
  assert.deepEqual(q.moveUp(mixed(), 'a2').map(e => e.id), ['a2', 'b1', 'a1', 'a3', 'b2']);
});

test('moveUp is a no-op only for the first entry of a conversation', () => {
  assert.deepEqual(q.moveUp(mixed(), 'a1').map(e => e.id), mixed().map(e => e.id));
  assert.deepEqual(q.moveUp(mixed(), 'b1').map(e => e.id), mixed().map(e => e.id));
  assert.deepEqual(q.moveUp(mixed(), 'nope').map(e => e.id), mixed().map(e => e.id));
  assert.deepEqual(q.moveUp([], 'a1'), []);
});

test('canMoveUp agrees with moveUp about which rows have somewhere to go', () => {
  // The row only offers "Move earlier" when this is true, so the predicate and
  // the operation must not disagree — a visible control that does nothing is
  // the failure mode these exist to prevent.
  for (const id of ['a1', 'a2', 'a3', 'b1', 'b2']) {
    const before = mixed().map(e => e.id).join(',');
    const after = q.moveUp(mixed(), id).map(e => e.id).join(',');
    assert.equal(q.canMoveUp(mixed(), id), before !== after, `${id}: predicate and operation disagree`);
  }
  assert.equal(q.canMoveUp(mixed(), 'nope'), false);
});

test('repeated moveUp walks an entry to the top and then stops', () => {
  let queue = mixed();
  const seen = [];
  for (let i = 0; i < 5; i++) {
    queue = q.moveUp(queue, 'a3');
    seen.push(queue.map(e => e.id).join(','));
  }
  assert.deepEqual(seen, [
    'a1,b1,a3,a2,b2',
    'a3,b1,a1,a2,b2',
    'a3,b1,a1,a2,b2', // already first for A — further presses do nothing
    'a3,b1,a1,a2,b2',
    'a3,b1,a1,a2,b2',
  ]);
});

test('the entry a drain would pick is the first for that conversation', () => {
  // Mirrors the host's drain rule (`own ?? queue[0]`) so the tests above are
  // about the thing that actually runs, not an abstract order.
  assert.equal(q.nextFor(mixed(), 'A')?.id, 'a1');
  assert.equal(q.promoteToFront(mixed(), 'a3').find(e => e.conversationId === 'A')?.id, 'a3');
  assert.equal(q.moveUp(mixed(), 'a3').find(e => e.conversationId === 'A')?.id, 'a1');
  // A conversation with nothing queued falls back to the global head, which is
  // how the host drains another conversation's work when this one is empty.
  assert.equal(q.nextFor(mixed(), 'C')?.id, 'a1');
  assert.equal(q.nextFor([], 'A'), undefined);
});

test('promoteToFront and moveUp agree on the drain outcome for the same entry', () => {
  // "Send now" promotes; the very first "Move earlier" from last place reaches
  // the same first position one step at a time.
  const promoted = q.promoteToFront(mixed(), 'a3');
  const stepped = q.moveUp(q.moveUp(mixed(), 'a3'), 'a3');
  assert.equal(
    q.nextFor(promoted, 'A')?.id,
    q.nextFor(stepped, 'A')?.id,
    'both routes must make the same entry next to run',
  );
});