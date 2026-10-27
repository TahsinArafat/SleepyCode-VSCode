import { test } from 'node:test';
import assert from 'node:assert/strict';

const turns = await import('../src/shared/turns.ts');

/*
 * The transcript joins every response block's text on each render just to put a
 * Copy button's payload together. On a long reply that is O(transcript) string
 * building per streamed frame, so the joined text is remembered against the
 * blocks array itself.
 *
 * A cache keyed on an array is only sound while the reducer hands out a NEW
 * array whenever the content changes. That is the whole contract, and it is not
 * obvious from reading the reducer — it clones the trailing turn and spreads its
 * blocks. If a future change edits the array it already published, the rendered
 * text and the button's payload would silently freeze at an old revision, so the
 * property is asserted here rather than assumed.
 */

function assistantWith(blocks) {
  return [{ role: 'user', text: 'go' }, { role: 'assistant', blocks, startedAt: Date.now() }];
}

function blocksOf(transcript) {
  const last = transcript[transcript.length - 1];
  return last.role === 'assistant' ? last.blocks : undefined;
}

test('a change to the answer publishes a new blocks array', () => {
  let transcript = assistantWith([{ kind: 'text', text: 'a' }]);
  let previous = blocksOf(transcript);
  for (const event of [
    { type: 'text-delta', text: 'b' },
    { type: 'thinking-delta', text: 'hmm' },
    { type: 'text-delta', text: 'c' },
    { type: 'tool-call-started', callId: 't1', name: 'Read', input: {} },
    { type: 'tool-call-completed', callId: 't1', name: 'Read', status: 'completed', result: 'ok' },
    { type: 'text-delta', text: 'd' },
  ]) {
    const next = turns.applyEvent(transcript, event);
    const blocks = blocksOf(next);
    assert.ok(blocks, `${event.type} must keep an assistant turn`);
    assert.notEqual(blocks, previous, `${event.type} reused the array it had already published`);
    previous = blocks;
    transcript = next;
  }
});

test('the published array is never mutated afterwards', () => {
  const before = assistantWith([{ kind: 'text', text: 'a' }]);
  const published = blocksOf(before);
  const revision = JSON.stringify(published);
  turns.applyEvent(before, { type: 'text-delta', text: 'b' });
  turns.applyEvent(before, { type: 'thinking-delta', text: 'hmm' });
  turns.applyEvent(before, { type: 'tool-call-started', callId: 't9', name: 'Read', input: {} });
  assert.equal(JSON.stringify(published), revision, 'an earlier transcript revision was edited in place');
});

test('an event that changes nothing keeps the array it was given', () => {
  // Identity is the cache key, so a no-op must not churn it either: a new array
  // per frame would throw the joined text away on every frame instead.
  const before = assistantWith([{ kind: 'text', text: 'a' }]);
  const published = blocksOf(before);
  const after = turns.applyEvent(before, { type: 'usage', promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  assert.equal(blocksOf(after), published);
});