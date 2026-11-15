import test from 'node:test';
import assert from 'node:assert/strict';
import { ESCAPE_HTML_SOURCE, HTML_ESCAPES_SOURCE, escapeAttribute, escapeHtml } from '../src/html-escape-core.ts';

/*
 * Escaping is the boundary between untrusted text -- model output, file names, conversation
 * titles, paths derived from them -- and `innerHTML`. One missed metacharacter is an injection
 * point, so it is tested directly rather than trusted to review.
 *
 * It is also the code most at risk during a UI rewrite, because a rewrite is exactly when
 * hand-rolled local copies multiply. `dev-refs.ts` and `ComposerEditor.ts` each had their own
 * four-character version, omitting the apostrophe -- not exploitable while every attribute is
 * double-quoted, but a live hazard the moment one is not. Both now import this module.
 */

test('escapeHtml neutralises every HTML metacharacter', () => {
  // Model output, file names and titles all reach innerHTML. One missed character
  // is an injection point.
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});

test('escaping is safe against attribute-context breakouts', () => {
  assert.equal(escapeAttribute('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(escapeAttribute("' onfocus='alert(1)"), '&#39; onfocus=&#39;alert(1)');
});

test('escapeHtml handles non-string input without throwing', () => {
  assert.equal(escapeHtml(undefined), 'undefined');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(42), '42');
});

test('escaping is idempotent-safe and does not double-encode the entities it emits', () => {
  // & must be escaped first or "&lt;" becomes "&amp;lt;".
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml(escapeHtml('<')), '&amp;lt;');
});

test('the exported template sources carry all five escapes', () => {
  // `ESCAPE_HTML_SOURCE` is still injected into the one remaining `String.raw` template
  // consumer. A hand-written second copy in that template is how sanitizers drift, so the
  // table it injects is asserted here rather than trusted.
  assert.match(ESCAPE_HTML_SOURCE, /const esc=s=>String\(s\)\.replace/);
  assert.match(ESCAPE_HTML_SOURCE, /escAttr=esc/);
  for (const pair of ["'&':'&amp;'", "'<':'&lt;'", "'>':'&gt;'", "'\"':'&quot;'", "\"'\":'&#39;'"]) {
    assert.ok(ESCAPE_HTML_SOURCE.includes(pair), `missing escape ${pair}`);
    assert.ok(HTML_ESCAPES_SOURCE.includes(pair), `missing escape ${pair}`);
  }
});
