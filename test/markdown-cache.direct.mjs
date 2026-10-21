import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKDOWN_CACHE_SOURCE } from '../src/webview/markdown-cache.ts';

// The source is browser code, injected into the webview template at runtime. Evaluate it the same
// way the template does, so these assertions exercise the real implementation rather than a copy.
const createMarkdownCache = new Function(`${MARKDOWN_CACHE_SOURCE}\nreturn createMarkdownCache;`)();

function countingRender() {
  const calls = [];
  const render = (text, allowMath) => {
    calls.push({ text, allowMath });
    return `<${allowMath ? 'm' : 't'}>${text}`;
  };
  return { render, calls };
}

test('repeated renders of the same text parse once', () => {
  const { render, calls } = countingRender();
  const markdown = createMarkdownCache(render, 10, 10000, 1000);
  const first = markdown('hello **world**');
  const second = markdown('hello **world**');
  assert.equal(first, second);
  assert.equal(calls.length, 1, 'the second render is served from the cache');
});

test('allowMath is part of the cache key', () => {
  const { render, calls } = countingRender();
  const markdown = createMarkdownCache(render, 10, 10000, 1000);
  assert.notEqual(markdown('$x$', true), markdown('$x$', false));
  assert.equal(calls.length, 2);
});

test('null and empty inputs render once and share one entry', () => {
  const { render, calls } = countingRender();
  const markdown = createMarkdownCache(render, 10, 10000, 1000);
  markdown(null);
  markdown('');
  assert.equal(calls.length, 1);
});

test('the entry cap evicts the least recently used text', () => {
  const { render, calls } = countingRender();
  const markdown = createMarkdownCache(render, 2, 10000, 1000);
  markdown('a');
  markdown('b');
  markdown('a');
  markdown('c');
  assert.equal(calls.length, 3, 'a and b are cached, a is refreshed, c is a miss');
  markdown('b');
  assert.equal(calls.length, 4, 'b was the least recently used and is gone');
});

test('hits refresh recency so a hot entry survives the cap', () => {
  const { render, calls } = countingRender();
  const markdown = createMarkdownCache(render, 2, 10000, 1000);
  markdown('a');
  markdown('b');
  markdown('a');
  markdown('c');
  markdown('a');
  assert.equal(calls.length, 3, 'a stayed cached because the hit refreshed it');
});

test('the character budget evicts even when the entry cap is not reached', () => {
  const { render, calls } = countingRender();
  // Each four-character entry costs 12 held characters (5 for the key, 7 for the html).
  const markdown = createMarkdownCache(render, 100, 24, 1000);
  markdown('aaaa');
  markdown('bbbb');
  markdown('cccc');
  const before = calls.length;
  markdown('aaaa');
  assert.equal(calls.length, before + 1, 'aaaa was evicted to stay inside the character budget');
});

test('inputs above maxInput are rendered but never cached', () => {
  const { render, calls } = countingRender();
  const markdown = createMarkdownCache(render, 100, 1e9, 4);
  markdown('12345');
  markdown('12345');
  assert.equal(calls.length, 2, 'oversized input re-renders every time');
});
