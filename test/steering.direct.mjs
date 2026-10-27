import test from 'node:test';
import assert from 'node:assert/strict';
import { steeringGuidance, steeringEntries, takeSteering } from '../src/steering.ts';

/*
 * Mid-run steering is guidance for the task already in progress, not a new
 * request. Two things follow, and both are cheap to get wrong:
 *
 *   - the model has to be told that, or it treats the update as a fresh ask and
 *     starts over from an empty head;
 *   - a steering entry must be consumable WITHOUT restarting the run, or the
 *     user watches their own words arrive twice (once inline, once as a new
 *     message) and loses the timer and the work already done.
 */

const queue = [
  { id: 'q1', text: 'first follow-up', conversationId: 'A' },
  { id: 'q2', text: 'steer this', conversationId: 'A', steering: true },
  { id: 'q3', text: 'other chat', conversationId: 'B' },
  { id: 'q4', text: 'another steer', conversationId: 'A', steering: true },
];

test('guidance is framed as an update to the current task', () => {
  const text = steeringGuidance('use the existing helper');
  assert.match(text, /use the existing helper/);
  assert.match(text, /<user_update>/);
  assert.match(text, /<\/user_update>/);
  // The instruction the model must not miss: continue, do not restart.
  assert.match(text, /not a new request/i);
  assert.match(text, /continue/i);
});

test('guidance keeps the user text verbatim, including newlines and markup', () => {
  const raw = 'line one\nline two <b>keep</b>';
  assert.ok(steeringGuidance(raw).includes(raw));
});

test('only this conversation\'s steering entries are listed', () => {
  assert.deepEqual(steeringEntries(queue, 'A').map((entry) => entry.id), ['q2', 'q4']);
  // A plain queued follow-up is never steering, whatever the conversation.
  assert.deepEqual(steeringEntries(queue, 'B').map((entry) => entry.id), []);
  assert.deepEqual(steeringEntries(queue, 'missing').map((entry) => entry.id), []);
});

test('taking steering leaves every other entry where it was', () => {
  const { taken, rest } = takeSteering(queue, 'A');
  assert.deepEqual(taken.map((entry) => entry.id), ['q2', 'q4']);
  assert.deepEqual(rest.map((entry) => entry.id), ['q1', 'q3']);
  // Order is the order they arrived: two updates must reach the model in turn.
  assert.deepEqual(taken.map((entry) => entry.text), ['steer this', 'another steer']);
});

test('taking from a conversation with nothing to take changes nothing', () => {
  const { taken, rest } = takeSteering(queue, 'B');
  assert.deepEqual(taken, []);
  assert.equal(rest.length, queue.length);
  assert.equal(takeSteering([], 'A').rest.length, 0);
});

test('consuming twice does not deliver the same update twice', () => {
  const first = takeSteering(queue, 'A');
  const second = takeSteering(first.rest, 'A');
  assert.equal(first.taken.length, 2);
  assert.deepEqual(second.taken, []);
});