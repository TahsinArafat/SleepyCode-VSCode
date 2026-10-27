import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_PRESSURE_RATIO,
  TOOL_RESULT_STUB,
  contextPressure,
  liveSliceBudget,
  trimToolResultsForRequest,
} from '../src/context-guard.ts';

/*
 * What the loop does when the turn in flight fills the context window.
 *
 * Stored history is budgeted before every request; the live slice — the tool
 * calls and results produced by THIS turn — was not. A long agentic turn could
 * therefore grow past the window with nothing measuring it, and the first thing
 * to notice was the provider rejecting the request. These are the two decisions
 * that fix that: when to stop starting steps, and what to drop from a request
 * (never from the saved transcript) to keep the next one inside the window.
 */

const msg = (role, content, extra = {}) => ({ role, content, ...extra });
const estimate = (message) => Math.ceil(JSON.stringify(message).length / 4);

test('pressure is measured against the window, not the send budget', () => {
  // A request that already used 90% of the window cannot take another tool result.
  assert.equal(CONTEXT_PRESSURE_RATIO, 0.9);
  assert.equal(contextPressure({ measuredPromptTokens: 120_000, contextWindow: 128_000 }), 'near');
  assert.equal(contextPressure({ measuredPromptTokens: 100_000, contextWindow: 128_000 }), 'ok');
  // No measurement yet: nothing to decide on.
  assert.equal(contextPressure({ measuredPromptTokens: 0, contextWindow: 128_000 }), 'ok');
});

test('an unknown window falls back to the send budget rather than guessing one', () => {
  // A guessed-too-large window is the dangerous value: it turns "trim the request"
  // into a hard provider failure.
  assert.equal(contextPressure({ measuredPromptTokens: 900_000, contextWindow: null }), 'ok');
  assert.equal(contextPressure({ measuredPromptTokens: 55_000, contextWindow: undefined, budgetTokens: 60_000 }), 'near');
  assert.equal(contextPressure({ measuredPromptTokens: 40_000, contextWindow: undefined, budgetTokens: 60_000 }), 'ok');
});

test('the live slice gets what the history and the prompt leave behind', () => {
  assert.equal(liveSliceBudget({ budgetTokens: 100_000, historyTokens: 40_000, promptTokens: 5_000 }), 55_000);
  // Never negative, even when the rest of the request already overflows.
  assert.equal(liveSliceBudget({ budgetTokens: 100_000, historyTokens: 90_000, promptTokens: 20_000 }), 0);
});

test('an over-budget live slice loses old tool results, not messages', () => {
  // Tool-call pairing is what strict providers reject on, so messages stay and
  // only the bulk inside the oldest results is replaced.
  const live = [
    msg('assistant', '', { toolCalls: [{ toolCallId: 't1', toolName: 'read_file' }] }),
    msg('tool', [{ type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: { type: 'text', value: 'x'.repeat(4_000) } }]),
    msg('assistant', '', { toolCalls: [{ toolCallId: 't2', toolName: 'read_file' }] }),
    msg('tool', [{ type: 'tool-result', toolCallId: 't2', toolName: 'read_file', output: { type: 'text', value: 'y'.repeat(4_000) } }]),
  ];
  // A budget one token under the total: exactly one result has to go.
  const total = live.reduce((sum, message) => sum + estimate(message), 0);
  const { messages, stubbed } = trimToolResultsForRequest(live, total - 1, estimate, TOOL_RESULT_STUB);
  assert.equal(messages.length, live.length, 'no message is removed');
  assert.ok(stubbed >= 1, 'something had to be replaced to fit');
  // The newest result is untouched…
  assert.equal(messages[3].content[0].output.value.startsWith('y'), true);
  // …and the dropped one keeps its identity so pairing still checks out.
  assert.equal(messages[1].content[0].toolCallId, 't1');
  assert.equal(messages[1].content[0].toolName, 'read_file');
  assert.equal(messages[1].content[0].output.value, TOOL_RESULT_STUB);
  // The caller's array is not mutated: this is a request-only view.
  assert.equal(live[1].content[0].output.value.length, 4_000);
});

test('a live slice that fits is returned untouched', () => {
  const live = [
    msg('assistant', '', { toolCalls: [{ toolCallId: 't1', toolName: 'read_file' }] }),
    msg('tool', [{ type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: { type: 'text', value: 'short' } }]),
  ];
  const { messages, stubbed } = trimToolResultsForRequest(live, 10_000, estimate, TOOL_RESULT_STUB);
  assert.equal(stubbed, 0);
  assert.equal(messages, live, 'the same array comes back when nothing is over budget');
});

test('trimming stops as soon as the slice fits, newest results first', () => {
  const live = [];
  for (let index = 0; index < 6; index++) {
    live.push(msg('assistant', '', { toolCalls: [{ toolCallId: `t${index}` }] }));
    live.push(msg('tool', [{ type: 'tool-result', toolCallId: `t${index}`, output: { type: 'text', value: 'z'.repeat(2_000) } }]));
  }
  // A budget that only the stubbed slice can meet.
  const { messages, stubbed } = trimToolResultsForRequest(live, 900, estimate, TOOL_RESULT_STUB);
  assert.ok(stubbed >= 4, `expected most old results to go, stubbed ${stubbed}`);
  assert.ok(messages.reduce((sum, message) => sum + estimate(message), 0) <= 900, 'the result fits the budget');
});

test('a result with an unexpected shape is left alone rather than mangled', () => {
  // Guessing at a provider-specific payload is how a request becomes invalid.
  const live = [msg('tool', 'plain string content'), msg('tool', [{ type: 'other', value: 'x'.repeat(5_000) }])];
  const { messages, stubbed } = trimToolResultsForRequest(live, 10, estimate, TOOL_RESULT_STUB);
  assert.equal(stubbed, 0);
  assert.deepEqual(messages, live);
});