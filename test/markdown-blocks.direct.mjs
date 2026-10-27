import test from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { splitMarkdownBlocks } from '../src/markdown-blocks.ts';

/*
 * The transcript re-renders a message on every streamed delta. Parsing and
 * sanitising the whole text each time is quadratic in message length, and
 * replacing the whole DOM each time throws away anything the reader had done
 * inside it (an expanded code block, a text selection).
 *
 * So the message is split into its top-level blocks and each is rendered on its
 * own. That is only correct if two things hold, and this file pins both:
 *
 *   1. Appending to a streaming message does not change the blocks before it —
 *      that is what makes the earlier blocks reusable at all.
 *   2. Blocks are only split when splitting cannot change the result: raw HTML
 *      can open an element in one block and close it in another, and a link
 *      reference definition changes how other blocks resolve, so both cases
 *      fall back to rendering the document whole.
 */

const marked = new Marked({ gfm: true, breaks: true });

const split = (src) => splitMarkdownBlocks(marked, src);
const keys = (src) => split(src).blocks.map((block) => block.key);

test('a growing message keeps every earlier block unchanged', () => {
  // The exact streaming shape: the model appends to the end. Every block but
  // the last must be reusable, or the cache never hits and nothing is gained.
  const first = split('One.\n\nTwo.\n\nThree').blocks;
  const next = split('One.\n\nTwo.\n\nThree and a bit').blocks;
  assert.equal(next.length, first.length);
  for (let index = 0; index < first.length - 1; index++) {
    assert.equal(next[index].key, first[index].key, `block ${index} changed while streaming`);
  }
  assert.notEqual(next[next.length - 1].key, first[first.length - 1].key);
});

test('appending a new block does not disturb the ones already rendered', () => {
  const before = split('Alpha.\n\nBeta.').blocks;
  const after = split('Alpha.\n\nBeta.\n\nGamma.').blocks;
  assert.equal(after.length, 3);
  assert.equal(after[0].key, before[0].key);
  assert.equal(after[1].key, before[1].key);
});

test('blocks are split in document order and lose nothing', () => {
  const src = '# Title\n\nSome *text*.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |';
  const blocks = split(src).blocks;
  assert.ok(blocks.length >= 5, `expected several blocks, got ${blocks.length}`);
  // Every block's raw text appears, in order, in the source.
  let cursor = 0;
  for (const block of blocks) {
    const at = src.indexOf(block.raw, cursor);
    assert.notEqual(at, -1, `block lost or reordered: ${JSON.stringify(block.raw)}`);
    cursor = at + block.raw.length;
  }
});

test('a fenced code block is one block even with blank lines and headings inside', () => {
  const src = 'before\n\n```md\n# not a heading\n\npara\n```\n\nafter';
  const blocks = split(src).blocks;
  assert.equal(blocks.length, 3);
  assert.match(blocks[1].raw, /^```md/);
});

test('raw HTML renders the document whole, because an element can span blocks', () => {
  // Block-level raw HTML.
  assert.equal(split('<div>open\n\nstill inside</div>').whole, true);
  // Inline raw HTML counts too: the parser carries formatting tags across
  // paragraphs, so the same fallback applies.
  assert.equal(split('text with <span class="x">inline</span> html').whole, true);
  // An HTML comment is markup as well.
  assert.equal(split('before <!-- note --> after').whole, true);
});

test('plain markdown is split rather than rendered whole', () => {
  assert.equal(split('one\n\ntwo').whole, false);
  assert.equal(split('```\ncode\n```').whole, false);
  // Escaped angle brackets are text, not markup.
  assert.equal(split('a &lt;div&gt; b').whole, false);
});

test('a link reference definition takes part in every block key', () => {
  const withRef = '[a][ref]\n\n[ref]: https://one.example';
  const otherRef = '[a][ref]\n\n[ref]: https://two.example';
  const a = split(withRef);
  const b = split(otherRef);
  assert.equal(a.whole, false);
  assert.equal(a.blocks.length, 1, 'the definition itself is not rendered');
  // Same paragraph text, different target: the keys must not collide, or the
  // second document would reuse the first one's rendered link.
  assert.notEqual(a.blocks[0].key, b.blocks[0].key);
});

test('an empty or whitespace-only message has no blocks', () => {
  assert.deepEqual(split('').blocks, []);
  assert.deepEqual(split('\n\n').blocks, []);
});

test('the key carries the block type, so the same text in another context re-renders', () => {
  // A paragraph "x" and an h1 "x" must not share a cache entry.
  assert.notEqual(split('x').blocks[0].key, split('# x').blocks[0].key);
});