import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_COMPACT_BUDGET_RATIO,
  AUTO_COMPACT_RATIO,
  CONTEXT_SYSTEM_OVERHEAD_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_RESPONSE_RESERVE_TOKENS,
  MIN_STRUCTURED_HISTORY_BUDGET,
  STRUCTURED_HISTORY_BUDGET_TOKENS,
  estimateHistoryTokens,
  shouldAutoCompact,
  structuredHistoryBudget,
} from '../src/compaction-core.ts';

test('the send budget follows the model window instead of being fixed at 60k', () => {
  // A fixed 60k budget either overflows a small window or strands a large one.
  const small = structuredHistoryBudget(32_000);
  const large = structuredHistoryBudget(200_000);
  assert.ok(small < STRUCTURED_HISTORY_BUDGET_TOKENS, `small window budget ${small}`);
  assert.ok(large > STRUCTURED_HISTORY_BUDGET_TOKENS, `large window budget ${large}`);
});

test('the budget leaves room for the system prompt and the answer', () => {
  const window = 128_000;
  const budget = structuredHistoryBudget(window);
  assert.ok(window - budget >= CONTEXT_SYSTEM_OVERHEAD_TOKENS + DEFAULT_RESPONSE_RESERVE_TOKENS,
    'history + prompt + answer must fit the window');
});

test('the budget honours a reported output limit', () => {
  const big = structuredHistoryBudget(200_000, 64_000);
  const small = structuredHistoryBudget(200_000, 4_000);
  assert.ok(big < small, 'a larger required answer leaves less room for history');
});

test('the budget never falls below the floor, and falls back when the window is unknown', () => {
  assert.equal(structuredHistoryBudget(4_000), MIN_STRUCTURED_HISTORY_BUDGET);
  assert.equal(structuredHistoryBudget(undefined), STRUCTURED_HISTORY_BUDGET_TOKENS);
  assert.equal(structuredHistoryBudget(0), STRUCTURED_HISTORY_BUDGET_TOKENS);
  assert.equal(structuredHistoryBudget(-1), STRUCTURED_HISTORY_BUDGET_TOKENS);
});

test('compaction fires before the send budget drops anything', () => {
  // The original bug: history was cut at the 60k budget while compaction waited for
  // 75% of the *window* (96k), so ~36k of conversation vanished with no summary.
  const budget = 60_000;
  const atBudget = budget * AUTO_COMPACT_BUDGET_RATIO;
  assert.equal(shouldAutoCompact(10_000, 128_000, atBudget - 1, budget), false);
  assert.equal(shouldAutoCompact(10_000, 128_000, atBudget, budget), true,
    'hitting 90% of the send budget must trigger compaction');
});

test('compaction waits until the window is actually full', () => {
  // Compacting at 75% of a 1M window threw away 250k tokens of usable conversation for
  // no reason: the send budget already reserves the system prompt and the answer.
  assert.ok(AUTO_COMPACT_RATIO >= 0.9, `compaction ratio ${AUTO_COMPACT_RATIO}`);
  assert.equal(shouldAutoCompact(750_000, 1_000_000), false, 'most of a large window must stay usable');
  assert.equal(shouldAutoCompact(900_000, 1_000_000), true);
});

test('the window trigger still fires on its own', () => {
  assert.equal(shouldAutoCompact(DEFAULT_CONTEXT_WINDOW * AUTO_COMPACT_RATIO, DEFAULT_CONTEXT_WINDOW), true);
  assert.equal(shouldAutoCompact(0, DEFAULT_CONTEXT_WINDOW, 0, 60_000), false);
});

test('estimateHistoryTokens sums every message including tool payloads', () => {
  const estimate = (m) => (typeof m.content === 'string' ? m.content.length : 0) + (m.toolCalls ? 100 : 0);
  const messages = [
    { role: 'user', content: 'abcd' },
    { role: 'assistant', content: 'ef', toolCalls: [{}] },
  ];
  assert.equal(estimateHistoryTokens(messages, estimate), 4 + 102);
  assert.equal(estimateHistoryTokens(undefined, estimate), 0);
  assert.equal(estimateHistoryTokens([], estimate), 0);
});
