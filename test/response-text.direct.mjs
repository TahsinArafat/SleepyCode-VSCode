import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responseText } from '../src/response-text.ts';

/*
 * The Copy button on a response needs the answer as one string. Building it
 * walks every block of a reply that may be hundreds of blocks long, and the
 * transcript renders on every streamed frame — so the joined text is remembered
 * against the blocks array, which the reducer replaces whenever the answer
 * changes (see test/turns-blocks-identity.direct.mjs).
 */

/** Blocks whose reads are counted, so a cache hit is observable. */
function counted(blocks) {
  const reads = { count: 0 };
  const wrapped = blocks.map((block) => {
    const out = { kind: block.kind };
    for (const field of ['text', 'message']) {
      if (!(field in block)) continue;
      Object.defineProperty(out, field, { enumerable: true, get() { reads.count++; return block[field]; } });
    }
    return out;
  });
  return { blocks: wrapped, reads };
}

test('the answer is every response block, in order, separated by a blank line', () => {
  assert.equal(responseText([{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }]), 'one\n\ntwo');
});

test('an error block contributes its message, and other blocks contribute nothing', () => {
  assert.equal(
    responseText([
      { kind: 'thinking', text: 'private' },
      { kind: 'text', text: 'answer' },
      { kind: 'tool', name: 'Read' },
      { kind: 'error', message: 'failed' },
      { kind: 'compaction', status: 'running' },
    ]),
    'answer\n\nfailed',
  );
});

test('a reply with no response blocks has no text', () => {
  assert.equal(responseText([]), '');
  assert.equal(responseText([{ kind: 'tool', name: 'Read' }]), '');
});

test('the same blocks are joined once', () => {
  const { blocks, reads } = counted([{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }]);
  assert.equal(responseText(blocks), 'one\n\ntwo');
  const afterFirst = reads.count;
  assert.ok(afterFirst > 0, 'the first call must read the blocks');
  assert.equal(responseText(blocks), 'one\n\ntwo');
  assert.equal(reads.count, afterFirst, 'the second call re-read the blocks instead of using the cache');
});

test('a new array is joined afresh, so a changed answer is never stale', () => {
  const first = [{ kind: 'text', text: 'one' }];
  assert.equal(responseText(first), 'one');
  assert.equal(responseText([{ kind: 'text', text: 'one and more' }]), 'one and more');
});