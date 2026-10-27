import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoContinue } from '../src/util.ts';

/*
 * Whether the loop asks the model to carry on. Continuing costs a whole request
 * with the whole context in it, so the rule has to be worth it.
 */

test('a truncated answer is continued', () => {
  assert.equal(shouldAutoContinue('half a sen', 'length', 0), true);
});

test('an answer that stops mid-sentence with stated intent is continued', () => {
  // The intent has to start its own line: mid-sentence prose is not a promise.
  assert.equal(shouldAutoContinue('Done so far:\nI will update the parser', 'stop', 0), true);
  assert.equal(shouldAutoContinue('Done so far. I will update the parser', 'stop', 0), false);
});

test('a finished answer stops the loop', () => {
  assert.equal(shouldAutoContinue('All done: three files changed and tests pass.', 'stop', 0), false);
});

test('the loop never continues more than twice', () => {
  assert.equal(shouldAutoContinue('', 'stop', 2), false);
  assert.equal(shouldAutoContinue('', 'length', 2), false);
});

test('an empty answer is usually worth one more try', () => {
  assert.equal(shouldAutoContinue('', 'stop', 0), true);
});

test('but not when the context is already nearly full', () => {
  // An empty reply is how some gateways report "too large". Re-sending the same
  // context two more times is two more full-size requests that cannot succeed.
  assert.equal(shouldAutoContinue('', 'stop', 0, { nearLimit: true }), false);
  // A truncated answer still gets its continuation: that is the recovery path.
  assert.equal(shouldAutoContinue('some text', 'length', 0, { nearLimit: true }), true);
});
