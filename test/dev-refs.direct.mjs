import test from 'node:test';
import assert from 'node:assert/strict';
import * as refs from '../src/dev-refs.ts';

/*
 * The classic transcript turned developer references into links: a bare
 * `src/app.ts:42`, `src/app.ts:42:7` or `file:///abs/path.ts` in prose became
 * clickable and opened at that position. The React markdown renderer does none of
 * it, so a model's file references are inert text.
 *
 * The rules matter more than the feature. Linkifying inside code would corrupt
 * every example; matching bare `number:number` would linkify times, ratios and
 * version numbers; and an anchor that carries a path must not be able to open
 * something outside the workspace, which the host checks — this only has to hand it
 * an honest path.
 */

test('a path with a line becomes a reference to that line', () => {
  const out = refs.linkifyDevRefs('<p>See src/app.ts:42 for the parser.</p>');
  assert.match(out, /data-open-path="src\/app\.ts"/);
  assert.match(out, /data-line="42"/);
  assert.match(out, />src\/app\.ts:42</);
  // The surrounding prose survives.
  assert.match(out, /^<p>See /);
  assert.match(out, / for the parser\.<\/p>$/);
});

test('a path with line and column keeps both', () => {
  const out = refs.linkifyDevRefs('<p>src/app.ts:42:7</p>');
  assert.match(out, /data-line="42"/);
  assert.match(out, /data-col="7"/);
});

test('a file url is a reference too', () => {
  const out = refs.linkifyDevRefs('<p>file:///Users/me/proj/src/app.ts:10</p>');
  assert.match(out, /data-open-path="\/Users\/me\/proj\/src\/app\.ts"/);
  assert.match(out, /data-line="10"/);
});

test('a bare line:column is not a reference', () => {
  // "at 12:30", "a 3:1 ratio", "v1:2" — none of these are files.
  for (const text of ['<p>at 12:30</p>', '<p>a 3:1 ratio</p>', '<p>ratio 16:9</p>']) {
    assert.equal(refs.linkifyDevRefs(text), text, text);
  }
});

test('code is never linkified', () => {
  // A code block is full of examples that look like references; corrupting them
  // would change what the code says.
  const pre = '<pre><code>src/app.ts:42</code></pre>';
  assert.equal(refs.linkifyDevRefs(pre), pre);
  const inline = '<p>call <code>src/app.ts:42</code> now</p>';
  assert.equal(refs.linkifyDevRefs(inline), inline);
  // And outside the code, the same text still becomes a link.
  assert.match(refs.linkifyDevRefs('<p>see src/app.ts:42</p>'), /data-open-path/);
});

test('an existing link is left alone', () => {
  const html = '<p><a href="https://example.com">https://example.com/src.ts:1</a></p>';
  const out = refs.linkifyDevRefs(html);
  assert.doesNotMatch(out, /data-open-path/);
});

test('a web address is not turned into a file reference', () => {
  const html = '<p>see <a href="https://x.dev/a.ts">https://x.dev/a.ts</a></p>';
  assert.doesNotMatch(refs.linkifyDevRefs(html), /data-open-path/);
});

test('a reference does not swallow trailing punctuation', () => {
  // "see src/app.ts:42." — the full stop is the sentence's, not the path's.
  const out = refs.linkifyDevRefs('<p>see src/app.ts:42.</p>');
  assert.match(out, /data-open-path="src\/app\.ts"/);
  assert.match(out, />src\/app\.ts:42<\/a>\.<\/p>$/);
});

test('several references in one paragraph each become a link', () => {
  const out = refs.linkifyDevRefs('<p>src/a.ts:1 and src/b.ts:2</p>');
  assert.equal((out.match(/data-open-path/g) ?? []).length, 2);
});

test('a path with no line is still a reference', () => {
  // "look at src/app.ts" is as useful to click as one with a line.
  const out = refs.linkifyDevRefs('<p>look at src/app.ts</p>');
  assert.match(out, /data-open-path="src\/app\.ts"/);
  assert.doesNotMatch(out, /data-line/);
});

test('the link keeps the text the model wrote', () => {
  // Rewriting `src/app.ts:42` into something friendlier would make the prose
  // disagree with the transcript.
  const out = refs.linkifyDevRefs('<p>src/app.ts:42</p>');
  assert.match(out, />src\/app\.ts:42<\/a>/);
});

test('html in the surrounding prose is not disturbed', () => {
  const out = refs.linkifyDevRefs('<p><strong>Note</strong> src/app.ts:5</p>');
  assert.match(out, /<strong>Note<\/strong>/);
  assert.match(out, /data-open-path/);
});

test('an empty or non-string input is returned as-is', () => {
  assert.equal(refs.linkifyDevRefs(''), '');
  assert.equal(refs.linkifyDevRefs(undefined), '');
});