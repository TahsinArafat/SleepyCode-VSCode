import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_COMPACT_RATIO,
  CHARS_PER_TOKEN,
  COMPACTION_HISTORY_ITEMS,
  COMPACTION_OUTPUT_BUDGET,
  CONTEXT_SYSTEM_OVERHEAD_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  compactionOutputBudget,
  compactionPromptInput,
  contextOccupancy,
  estimateContextTokens,
  selectCarriedItems,
  shouldAutoCompact,
} from '../src/compaction-core.ts';

const user = (text, extra = {}) => ({ role: 'user', text, ...extra });
const assistant = (text, extra = {}) => ({ role: 'assistant', text, ...extra });

test('estimateContextTokens is overhead-only for an empty transcript', () => {
  assert.equal(estimateContextTokens([]), CONTEXT_SYSTEM_OVERHEAD_TOKENS);
});

test('estimateContextTokens scales with transcript text at chars-per-token', () => {
  const items = [user('x'.repeat(400))];
  assert.equal(estimateContextTokens(items), CONTEXT_SYSTEM_OVERHEAD_TOKENS + 400 / CHARS_PER_TOKEN);
});

test('estimateContextTokens only counts the recent history window', () => {
  const oldItems = Array.from({ length: 50 }, () => assistant('y'.repeat(4000)));
  const withOld = [...oldItems, user('z'.repeat(400))];
  // Only the last COMPACTION_HISTORY_ITEMS items count: 9 old assistants + 1 user.
  const expectedChars = (COMPACTION_HISTORY_ITEMS - 1) * 4000 + 400;
  assert.equal(estimateContextTokens(withOld), CONTEXT_SYSTEM_OVERHEAD_TOKENS + Math.ceil(expectedChars / CHARS_PER_TOKEN));
});

test('compaction shrinks the context estimate instead of preserving it (5.33M/1M regression)', () => {
  // A long session whose cumulative per-item token counters would read as millions.
  const longTranscript = Array.from({ length: COMPACTION_HISTORY_ITEMS }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: 'a'.repeat(40_000),
    inputTokens: 500_000,
    outputTokens: 30_000,
  }));
  const before = estimateContextTokens(longTranscript);
  // The compacted transcript: summary + carried last exchange + continue marker.
  const compacted = [
    assistant('Summary of prior work and current state.', { inputTokens: 12_000, outputTokens: 600 }),
    user('Continue from the compacted context above.'),
  ];
  const after = estimateContextTokens(compacted);
  assert.ok(before > 100_000, `expected large pre-compaction estimate, got ${before}`);
  assert.ok(after < 2_500, `expected small post-compaction estimate, got ${after}`);
  assert.ok(after < before);
  // The estimate must be text-based: stale cumulative counters carried on items
  // must not influence occupancy.
  assert.equal(estimateContextTokens([user('hello')]), estimateContextTokens([user('hello', { inputTokens: 5_300_000 })]));
});

test('shouldAutoCompact fires only at or beyond the threshold', () => {
  const window = 100_000;
  assert.equal(shouldAutoCompact(Math.floor(window * AUTO_COMPACT_RATIO) - 1, window), false);
  assert.equal(shouldAutoCompact(window * AUTO_COMPACT_RATIO, window), true);
  assert.equal(shouldAutoCompact(0, window), false);
  assert.equal(shouldAutoCompact(-5, window), false);
});

test('shouldAutoCompact falls back to the default window and rejects invalid windows', () => {
  assert.equal(shouldAutoCompact(DEFAULT_CONTEXT_WINDOW * AUTO_COMPACT_RATIO, undefined), true);
  assert.equal(shouldAutoCompact(DEFAULT_CONTEXT_WINDOW * AUTO_COMPACT_RATIO - 1, undefined), false);
  assert.equal(shouldAutoCompact(200_000, 0), true);
  assert.equal(shouldAutoCompact(200_000, -10), true);
});

test('compactionPromptInput strips think traces and clamps per-item length', () => {
  const items = [
    user('hello <think>secret chain of thought</think>world'),
    assistant('x'.repeat(10_000)),
  ];
  const input = compactionPromptInput(items);
  assert.ok(!/<think>/i.test(input), 'think blocks must be stripped');
  assert.ok(input.includes('[User] hello world'));
  const assistantLine = input.split('\n\n')[1] ?? '';
  assert.ok(assistantLine.length <= '[Assistant] '.length + 4_000);
});

test('compactionPromptInput tolerates missing text', () => {
  assert.equal(compactionPromptInput([{ role: 'user' }]), '[User] ');
});

test('selectCarriedItems returns the latest user and latest non-error assistant', () => {
  const items = [
    user('first'),
    assistant('old reply'),
    user('latest question'),
    assistant('latest reply'),
  ];
  const { lastUser, lastAssistant } = selectCarriedItems(items);
  assert.equal(lastUser?.text, 'latest question');
  assert.equal(lastAssistant?.text, 'latest reply');
});

test('selectCarriedItems never carries error items forward', () => {
  const items = [user('q'), assistant('good'), assistant('provider exploded', { kind: 'error' })];
  const { lastAssistant } = selectCarriedItems(items);
  assert.equal(lastAssistant?.text, 'good');
});

test('selectCarriedItems tolerates empty and user-only transcripts', () => {
  assert.deepEqual(selectCarriedItems([]), { lastUser: undefined, lastAssistant: undefined });
  const { lastUser, lastAssistant } = selectCarriedItems([user('only')]);
  assert.equal(lastUser?.text, 'only');
  assert.equal(lastAssistant, undefined);
});

test('compactionOutputBudget leaves headroom for reasoning models by default', () => {
  // Regression: a 1024 cap made reasoning models return empty text (dashboard
  // shows a "valid" completion; the extension saw nothing and hopped models).
  assert.ok(COMPACTION_OUTPUT_BUDGET >= 4096);
  assert.equal(compactionOutputBudget(undefined), COMPACTION_OUTPUT_BUDGET);
  assert.equal(compactionOutputBudget(null), COMPACTION_OUTPUT_BUDGET);
  assert.equal(compactionOutputBudget(0), COMPACTION_OUTPUT_BUDGET);
});

test('contextOccupancy prefers the measured provider prompt_tokens from the latest item', () => {
  const items = [
    assistant('old reply', { contextTokens: 9_700 }),
    user('latest question'),
    assistant('latest reply', { contextTokens: 42_000 }),
  ];
  assert.deepEqual(contextOccupancy(items), { tokens: 42_000, measured: true });
});

test('contextOccupancy falls back to the text estimate when no measurement exists', () => {
  const items = [user('x'.repeat(400))];
  assert.deepEqual(contextOccupancy(items), { tokens: estimateContextTokens(items), measured: false });
});

test('contextOccupancy ignores stale measurements on older items', () => {
  // The measured prompt_tokens lives on the most recent assistant item; an older
  // measurement must not win just because it appears later in the array order.
  const items = [
    assistant('first', { contextTokens: 99_000 }),
    user('second'),
    assistant('second', { contextTokens: 12_000 }),
  ];
  assert.equal(contextOccupancy(items).tokens, 12_000);
  assert.equal(contextOccupancy(items).measured, true);
});

test('compactionOutputBudget clamps to the provider advertised limit', () => {
  // Exceeding a provider's maxOutputLimit makes strict providers 400 the request,
  // which also looks like "the model does not answer".
  assert.equal(compactionOutputBudget(2048), 2048);
  assert.equal(compactionOutputBudget(1_000_000), COMPACTION_OUTPUT_BUDGET);
  assert.equal(compactionOutputBudget(COMPACTION_OUTPUT_BUDGET), COMPACTION_OUTPUT_BUDGET);
});
