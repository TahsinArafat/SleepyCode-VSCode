import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../src/shared/turns.ts';

/*
 * A steering update belongs to the task it corrects. It used to be appended as a
 * user turn, which split the answer in two: the running response lost its work
 * section and its timer, and the reader saw their own update as if they had sent
 * a brand-new message partway through.
 */

const running = () => [
  { role: 'user', text: 'build the parser' },
  { role: 'assistant', blocks: [{ kind: 'text', text: 'Starting.' }], startedAt: 1_000 },
];

test('steering joins the running response instead of opening a new turn', () => {
  const before = running();
  const after = applyEvent(before, { type: 'user-steering', text: 'use the existing tokenizer' });
  assert.equal(after.length, 2, 'no new turn is created');
  assert.equal(after[1].role, 'assistant');
  const blocks = after[1].blocks;
  const note = blocks.find((block) => block.kind === 'steering');
  assert.ok(note, 'the update is recorded as a steering block');
  assert.equal(note.text, 'use the existing tokenizer');
  assert.equal(typeof note.at, 'number');
});

test('the running response keeps its start time, so the timer does not restart', () => {
  const after = applyEvent(running(), { type: 'user-steering', text: 'x' });
  assert.equal(after[1].startedAt, 1_000);
});

test('an update that arrives before any assistant block still lands in the work stream', () => {
  const after = applyEvent([{ role: 'user', text: 'go' }], { type: 'user-steering', text: 'wait, also do y' });
  assert.equal(after.length, 2);
  assert.equal(after[1].role, 'assistant');
  assert.equal(after[1].blocks.at(-1).kind, 'steering');
});

test('two updates both survive, in the order they arrived', () => {
  let turns = running();
  turns = applyEvent(turns, { type: 'user-steering', text: 'first' });
  turns = applyEvent(turns, { type: 'user-steering', text: 'second' });
  const notes = turns[1].blocks.filter((block) => block.kind === 'steering').map((block) => block.text);
  assert.deepEqual(notes, ['first', 'second']);
});

test('a transcript saved before steering became a block still renders its updates', () => {
  // Old items carry `steering: true` on a user turn. Reading one must not throw
  // and must keep the turn list intact.
  const legacy = [
    { role: 'user', text: 'build the parser' },
    { role: 'assistant', blocks: [{ kind: 'text', text: 'Starting.' }], startedAt: 1_000 },
    { role: 'user', text: 'use the existing tokenizer', steering: true },
    { role: 'assistant', blocks: [{ kind: 'text', text: 'Done.' }], startedAt: 2_000 },
  ];
  const after = applyEvent(legacy, { type: 'text-delta', text: 'more' });
  assert.equal(after.length, 4);
  assert.equal(after.at(-1).blocks.at(-1).text, 'Done.more');
});
