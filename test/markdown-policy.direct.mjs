import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../src/markdown-policy.ts';
import { codeBlockHtml } from '../src/code-block-html.ts';
import { linkifyDevRefs } from '../src/dev-refs.ts';

/*
 * Sanitising model output is an allowlist, not a denylist. The old regex
 * removed `script`/`iframe` and `on*` attributes, which leaves everything the
 * author of the reply invents — `<svg onload>`, `<form action>`, an inline
 * `style` — depending on whether the denylist happened to name it.
 *
 * The risk of an allowlist in THIS codebase is the opposite one: our own markup
 * (the fenced-code chrome and the developer-reference anchors) is emitted as
 * raw HTML and would be quietly stripped, breaking Copy, collapse and
 * click-to-open. That is the contract these tests pin.
 */

/** Every `tag` plus its attributes, in document order, from a known fragment. */
function tagsIn(html) {
  const out = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const attrs = [...match[2].matchAll(/([a-z0-9:-]+)(?:="([^"]*)")?/gi)]
      .map(([, name, value]) => ({ name: name.toLowerCase(), value: value ?? '' }));
    out.push({ tag: match[1].toLowerCase(), attrs });
  }
  return out;
}

test('the fenced-code chrome we emit is entirely allowed', () => {
  // A long block: carries the language chip, Copy, and the expand control.
  const long = codeBlockHtml({ language: 'ts', label: 'TypeScript', content: 'const a = 1;\n'.repeat(40) });
  const short = codeBlockHtml({ language: '', label: '', content: 'x' });
  for (const html of [long, short]) {
    for (const { tag, attrs } of tagsIn(html)) {
      assert.ok(policy.tagAllowed(tag), `code-block markup uses a tag the allowlist would drop: <${tag}>`);
      for (const attr of attrs) {
        assert.ok(
          policy.attributeAllowed(tag, attr.name, attr.value),
          `code-block markup uses an attribute the allowlist would strip: <${tag} ${attr.name}>`,
        );
      }
    }
  }
});

test('a developer reference anchor keeps the attributes the transcript reads', () => {
  const html = linkifyDevRefs('open src/app.ts:42:7 to see it');
  const anchor = tagsIn(html).find(({ tag }) => tag === 'a');
  assert.ok(anchor, 'the reference must still be an anchor');
  for (const attr of anchor.attrs) {
    assert.ok(policy.attributeAllowed('a', attr.name, attr.value), `dev-ref anchor loses ${attr.name}`);
  }
  // Named explicitly: the delegated handler looks these up by exact name.
  assert.ok(anchor.attrs.some((a) => a.name === 'data-open-path' && a.value === 'src/app.ts'));
  assert.ok(anchor.attrs.some((a) => a.name === 'data-line' && a.value === '42'));
  assert.ok(anchor.attrs.some((a) => a.name === 'data-col' && a.value === '7'));
});

test('scriptable URLs never survive as live URLs', () => {
  for (const value of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    '\u0000javascript:alert(1)',
    ' javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml,<svg onload=alert(1)>',
    '//evil.example',
    '\\\\evil.example/x',
  ]) {
    assert.equal(policy.hrefAllowed(value), false, `href must not survive: ${JSON.stringify(value)}`);
  }
  for (const value of ['https://example.com/a', 'http://example.com', 'mailto:a@b.c', '#anchor', '/local/path', 'a/b.ts']) {
    assert.equal(policy.hrefAllowed(value), true, `href must survive: ${JSON.stringify(value)}`);
  }
});

test('only https and raster data-URLs may be loaded as an image', () => {
  for (const value of [
    'javascript:alert(1)',
    'http://insecure.example/x.png',
    'file:///etc/passwd',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png',
  ]) {
    assert.equal(policy.srcAllowed(value), false, `src must not survive: ${JSON.stringify(value)}`);
  }
  for (const value of ['https://example.com/x.png', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,/9j/4AAQ']) {
    assert.equal(policy.srcAllowed(value), true, `src must survive: ${JSON.stringify(value)}`);
  }
});

test('markup that can run or frame code is removed with its contents', () => {
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'noscript', 'template', 'svg']) {
    if (tag === 'svg') continue; // inline icons are allowed
    assert.ok(policy.tagDropped(tag), `<${tag}> must be removed rather than unwrapped`);
    assert.equal(policy.tagAllowed(tag), false);
  }
});

test('inline icons and the control markup the transcript owns are allowed', () => {
  for (const tag of ['svg', 'path', 'circle', 'rect', 'g', 'span', 'div', 'button', 'input', 'pre', 'code', 'table', 'details']) {
    assert.ok(policy.tagAllowed(tag), `<${tag}> must be kept`);
  }
});

test('a checkbox is the only form control that survives, and it is display only', () => {
  assert.equal(policy.attributeAllowed('input', 'type', 'checkbox'), true);
  // The walker deletes any input that is not a checkbox; the policy agrees.
  assert.equal(policy.tagAllowed('input'), true);
  assert.equal(policy.attributeAllowed('input', 'value', 'go'), false);
  assert.equal(policy.attributeAllowed('input', 'onclick', 'x()'), false);
});

test('event handlers and inline styles are never allowed, on any tag', () => {
  for (const tag of ['a', 'div', 'span', 'svg', 'path', 'img', 'button', 'p', 'code']) {
    for (const name of ['onclick', 'onerror', 'onload', 'onmouseover', 'style']) {
      assert.equal(policy.attributeAllowed(tag, name, 'alert(1)'), false, `<${tag} ${name}> must be stripped`);
    }
  }
});

test('an unknown tag keeps its text but loses its own attributes', () => {
  // Unwrapped: the walker replaces it with its children, so only the attributes
  // question is the policy's to answer.
  assert.equal(policy.tagAllowed('marquee'), false);
  assert.equal(policy.tagDropped('marquee'), false);
  assert.equal(policy.attributeAllowed('marquee', 'behavior', 'alternate'), false);
});