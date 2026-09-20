import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERSISTED_REASONING,
  MAX_PERSISTED_REASONING_LIMIT,
  MIN_PERSISTED_REASONING,
  attachReasoningToLatestAssistant,
  backfillAssistantReasoning,
  clipPersistedReasoning,
  collectReasoningText,
  extractThinkBlocks,
  messageHasReasoning,
  normalizePersistedReasoningLimit,
  persistedReasoningBody,
  reasoningTextsFromItems,
  rememberReasoningText,
  withReasoningPart,
} from '../src/reasoning-core.ts';

const T = '<' + 'think' + '>';
const TC = '<' + '/' + 'think' + '>';

test('normalizePersistedReasoningLimit raises the old 3000 default and clamps the range', () => {
  assert.equal(DEFAULT_PERSISTED_REASONING, 32_000);
  assert.ok(DEFAULT_PERSISTED_REASONING > 3_000);
  assert.equal(normalizePersistedReasoningLimit(undefined), 32_000);
  assert.equal(normalizePersistedReasoningLimit('64000'), 64_000);
  assert.equal(normalizePersistedReasoningLimit(100), MIN_PERSISTED_REASONING);
  assert.equal(normalizePersistedReasoningLimit(999_999), MAX_PERSISTED_REASONING_LIMIT);
  assert.equal(normalizePersistedReasoningLimit('nope', 12_000), 12_000);
});

test('clipPersistedReasoning keeps thinking up to the configured budget', () => {
  const kept = clipPersistedReasoning('short plan', 32_000);
  assert.equal(kept.truncated, false);
  assert.equal(kept.text, 'short plan');

  const long = `old-head-${'x'.repeat(MIN_PERSISTED_REASONING)}-new-tail`;
  const clipped = clipPersistedReasoning(long, MIN_PERSISTED_REASONING);
  assert.equal(clipped.truncated, true);
  assert.match(clipped.text, /earlier thinking omitted/);
  assert.match(clipped.text, /new-tail$/);
  assert.doesNotMatch(clipped.text, /^old-head-/);
  assert.ok(persistedReasoningBody(clipped.text).endsWith('new-tail'));
});

test('rememberReasoningText appends XML and native thinking into one persist buffer', () => {
  const first = rememberReasoningText('', 'native first. ', 32_000);
  const second = rememberReasoningText(first.text, 'xml second.', 32_000);
  assert.equal(second.text, 'native first. xml second.');
  assert.equal(second.truncated, false);
});

test('collectReasoningText and reasoningTextsFromItems ignore non-reasoning work', () => {
  const work = [
    { kind: 'task', text: 'read src/agent.ts' },
    { kind: 'reasoning', text: ' check the persist path ' },
    { kind: 'reasoning', text: 'then attach it' },
  ];
  assert.equal(collectReasoningText(work), 'check the persist path\n\nthen attach it');
  assert.deepEqual(
    reasoningTextsFromItems([
      { role: 'user', work: [{ kind: 'reasoning', text: 'ignore' }] },
      { role: 'assistant', work },
      { role: 'assistant', work: [{ kind: 'task', text: 'edit' }] },
    ]),
    ['check the persist path\n\nthen attach it'],
  );
});

test('extractThinkBlocks returns inner thinking without the XML tags', () => {
  assert.equal(extractThinkBlocks(`${T} prior plan ${TC} visible`), 'prior plan');
  assert.equal(extractThinkBlocks('no think here'), '');
});

test('withReasoningPart persists thinking and strips leftover XML think from visible text', () => {
  const parts = withReasoningPart(`${T} hidden ${TC}Visible answer`, 'hidden');
  assert.deepEqual(parts, [
    { type: 'reasoning', text: 'hidden' },
    { type: 'text', text: 'Visible answer' },
  ]);
  const already = [{ type: 'reasoning', text: 'kept' }, { type: 'text', text: 'ok' }];
  const merged = withReasoningPart(already, 'and more');
  assert.deepEqual(merged[0], { type: 'reasoning', text: 'kept\n\nand more' });
  assert.deepEqual(merged[1], { type: 'text', text: 'ok' });
  assert.deepEqual(withReasoningPart(already, 'kept'), already);
});

test('attachReasoningToLatestAssistant does not drop earlier thinking on the next step', () => {
  const messages = [
    { role: 'user', content: 'fix persist' },
    { role: 'assistant', content: 'I will inspect the loop' },
    { role: 'tool', content: 'file contents' },
  ];
  attachReasoningToLatestAssistant(messages, 'must reread this thinking');
  assert.equal(messageHasReasoning(messages[1]), true);
  assert.deepEqual(messages[1].content[0], { type: 'reasoning', text: 'must reread this thinking' });
  attachReasoningToLatestAssistant(messages, 'and then merge the next segment');
  assert.deepEqual(messages[1].content[0], {
    type: 'reasoning',
    text: 'must reread this thinking\n\nand then merge the next segment',
  });
});

test('backfillAssistantReasoning restores work-item thinking onto stored assistant messages', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'did work' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'more work' },
  ];
  backfillAssistantReasoning(messages, ['thinking one', 'thinking two']);
  assert.deepEqual(messages[1].content[0], { type: 'reasoning', text: 'thinking one' });
  assert.deepEqual(messages[3].content[0], { type: 'reasoning', text: 'thinking two' });
});
