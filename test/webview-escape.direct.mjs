import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ESCAPE_HTML_SOURCE, escapeAttribute, escapeHtml } from '../src/webview/runtime-core.ts';

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

test('the injected template sanitizer is the same implementation', () => {
  // A hand-written second copy in the template is how sanitizers drift.
  assert.match(ESCAPE_HTML_SOURCE, /const esc=s=>String\(s\)\.replace/);
  assert.match(ESCAPE_HTML_SOURCE, /escAttr=esc/);
  for (const pair of ["'&':'&amp;'", "'<':'&lt;'", "'>':'&gt;'", "'\"':'&quot;'", "\"'\":'&#39;'"]) {
    assert.ok(ESCAPE_HTML_SOURCE.includes(pair), `missing escape ${pair}`);
  }
});

test('the runtime no longer keeps its own copy of the escape table', () => {
  const runtime = readFileSync(new URL('../src/webview/runtime.ts', import.meta.url), 'utf8');
  assert.ok(runtime.includes('${ESCAPE_HTML_SOURCE}'), 'runtime must inject the shared source');
  assert.equal(runtime.includes("{'&':'&amp;','<':'&lt;'"), false, 'no duplicate table in the template');
});
