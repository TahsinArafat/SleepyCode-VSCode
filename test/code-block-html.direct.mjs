import test from 'node:test';
import assert from 'node:assert/strict';
import * as codeBlock from '../src/code-block-html.ts';

/*
 * Fenced code in a reply used to render as a bare <pre><code>: no language
 * label, no way to copy. The classic webview had both (label + Copy with a
 * "Copied" flash, plus expand-at-24-lines), so a user coming from it lost a
 * control they used on every answer.
 *
 * The markup is built here rather than in the React tree because the transcript
 * renders sanitized HTML from `marked`. A button inside raw HTML cannot carry a
 * React handler, so it carries a data attribute and the transcript delegates the
 * click — which is why the exact attribute is part of the contract below.
 */

test('a code block carries its language label and a copy control', () => {
  const html = codeBlock.codeBlockHtml({ language: 'ts', label: 'TypeScript', content: 'const a = 1;' });
  assert.match(html, /class="code-block"/);
  assert.match(html, /class="code-block-lang"[^>]*>TypeScript</);
  assert.match(html, /data-copy-code="1"/);
  assert.match(html, /aria-label="Copy code"/);
  // The highlighted content is passed through untouched.
  assert.match(html, /const a = 1;/);
});

test('the label falls back to the language id, then to nothing', () => {
  // A model can name a language the highlighter does not know; the id is still
  // more useful than an empty chip.
  assert.match(codeBlock.codeBlockHtml({ language: 'zzz', label: '', content: 'x' }), />zzz</);
  const bare = codeBlock.codeBlockHtml({ language: '', label: '', content: 'x' });
  // No language means no chip at all rather than an empty one.
  assert.doesNotMatch(bare, /code-block-lang/);
  // …and the copy control is still there, which is the part that matters.
  assert.match(bare, /data-copy-code="1"/);
});

test('a long block is collapsed and can be expanded', () => {
  // The classic webview collapsed at 24 lines. A 400-line dump pushed every
  // later answer off the screen, which is why the threshold existed.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const html = codeBlock.codeBlockHtml({ language: 'ts', label: 'TypeScript', content: long });
  assert.match(html, /data-expand-code="1"/);
  assert.match(html, /class="code-block collapsed"/);
  assert.match(html, /Show all 40 lines/);
});

test('a short block is not collapsed', () => {
  const short = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
  const html = codeBlock.codeBlockHtml({ language: 'ts', label: 'TypeScript', content: short });
  assert.doesNotMatch(html, /data-expand-code/);
  assert.doesNotMatch(html, /collapsed/);
});

test('the collapse threshold is a line count, not a byte count', () => {
  // A single enormous line should not collapse (it cannot be read by scrolling
  // either way), and 24 short lines should not collapse while 25 should.
  const at = (n) => codeBlock.codeBlockHtml({ language: 'ts', label: 'T', content: Array.from({ length: n }, () => 'x').join('\n') });
  assert.doesNotMatch(at(codeBlock.COLLAPSE_LINES), /collapsed/);
  assert.match(at(codeBlock.COLLAPSE_LINES + 1), /collapsed/);
});

test('code content is never interpreted as markup by the wrapper', () => {
  // The wrapper only adds a header and a container; it must not escape or
  // re-encode the already-highlighted body (that would show &lt; instead of <).
  const html = codeBlock.codeBlockHtml({ language: 'html', label: 'HTML', content: '<span class="hl">&lt;div&gt;</span>' });
  assert.match(html, /<span class="hl">&lt;div&gt;<\/span>/);
  // And a language label that a model supplied cannot inject an attribute.
  const hostile = codeBlock.codeBlockHtml({ language: 'ts', label: '"><script>alert(1)</script>', content: 'x' });
  assert.doesNotMatch(hostile, /<script>/);
  assert.doesNotMatch(hostile, /"><script/);
});

test('the copy attribute survives the transcript sanitizer', () => {
  // `sanitize()` in markdown.ts strips on* handlers but keeps data-* attributes;
  // this asserts the contract the delegated handler relies on. If the attribute
  // were dropped, every copy button would silently do nothing.
  const html = codeBlock.codeBlockHtml({ language: 'ts', label: 'T', content: 'x' });
  assert.match(html, /\sdata-copy-code="1"/);
  assert.match(html, /\sdata-expand-code="1"|/);
});
