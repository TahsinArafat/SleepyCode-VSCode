import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_PRESSURE_RATIO, contextPressure } from '../src/context-guard.ts';

/*
 * When the loop stops starting steps.
 *
 * Nothing in here removes a message or replaces a tool result. A request that is
 * shrunk without a summary is context the model silently loses — it re-reads the
 * file it already read, or edits against a file it can no longer see. Compaction
 * is the only thing allowed to make a conversation smaller; the guard's job is to
 * stop BEFORE the provider rejects the request so compaction can run instead.
 */

test('pressure is measured against the window, not the send budget', () => {
  // A request that already used 90% of the window cannot take another tool result.
  assert.equal(CONTEXT_PRESSURE_RATIO, 0.9);
  assert.equal(contextPressure({ measuredPromptTokens: 120_000, contextWindow: 128_000 }), 'near');
  assert.equal(contextPressure({ measuredPromptTokens: 100_000, contextWindow: 128_000 }), 'ok');
  // No measurement yet: nothing to decide on.
  assert.equal(contextPressure({ measuredPromptTokens: 0, contextWindow: 128_000 }), 'ok');
});

test('an unknown window falls back to the send budget rather than guessing one', () => {
  // A guessed-too-large window is the dangerous value: it lets a request through
  // that the provider will then reject.
  assert.equal(contextPressure({ measuredPromptTokens: 900_000, contextWindow: null }), 'ok');
  assert.equal(contextPressure({ measuredPromptTokens: 55_000, contextWindow: undefined, budgetTokens: 60_000 }), 'near');
  assert.equal(contextPressure({ measuredPromptTokens: 40_000, contextWindow: undefined, budgetTokens: 60_000 }), 'ok');
});
