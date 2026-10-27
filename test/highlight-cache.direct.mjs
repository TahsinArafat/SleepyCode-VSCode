import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightCacheKey, rememberTokens } from '../src/highlight-cache.ts';

/*
 * Highlighting the composer re-tokenises EVERY code block in the draft, because
 * the decoration pass walks the whole document. Typing in one block therefore
 * pays for all of them, and the result has to be parsed back out of HTML each
 * time. A cache fixes that — but only if its key actually distinguishes the
 * inputs, since a collision shows the reader one block's colours on another's
 * text.
 */

const range = (from, to, className) => ({ from, to, className });

test('the same text in the same language maps to the same key', () => {
  assert.equal(highlightCacheKey('const a = 1;', 'ts'), highlightCacheKey('const a = 1;', 'ts'));
});

test('a different language or a different text is a different key', () => {
  assert.notEqual(highlightCacheKey('const a = 1;', 'ts'), highlightCacheKey('const a = 1;', 'js'));
  assert.notEqual(highlightCacheKey('const a = 1;', 'ts'), highlightCacheKey('const a = 2;', 'ts'));
  assert.notEqual(highlightCacheKey('', 'ts'), highlightCacheKey('', 'js'));
});

test('a key cannot be forged by moving text across the separator', () => {
  // Two adjacent fields joined with a cheap separator collide: ("a\u0000b", "ts")
  // and ("a", "ts\u0000b") are the same string. The key must not be built that way.
  assert.notEqual(highlightCacheKey('a\u0000b', 'ts'), highlightCacheKey('a', 'ts\u0000b'));
  assert.notEqual(highlightCacheKey('a', 'b'), highlightCacheKey('ab', ''));
});

test('a hit does not recompute', () => {
  const cache = new Map();
  let computed = 0;
  const compute = () => (computed++, [range(0, 5, 'hl-keyword')]);
  const first = rememberTokens(cache, 'k', compute, 16);
  const second = rememberTokens(cache, 'k', compute, 16);
  assert.equal(computed, 1);
  assert.equal(second, first, 'the cached array is reused, not rebuilt');
});

test('the oldest entry is evicted once the limit is reached', () => {
  const cache = new Map();
  for (const key of ['a', 'b', 'c']) rememberTokens(cache, key, () => [range(0, 1, key)], 2);
  assert.equal(cache.size, 2);
  assert.equal(cache.has('a'), false, 'the least recently added entry goes');
  assert.equal(cache.has('c'), true);
  // …and asking for it again recomputes rather than returning nothing.
  let computed = 0;
  const recovered = rememberTokens(cache, 'a', () => (computed++, [range(0, 1, 'a')]), 2);
  assert.equal(computed, 1);
  assert.equal(recovered.length, 1);
});

test('a limit of one keeps only the newest entry', () => {
  const cache = new Map();
  rememberTokens(cache, 'a', () => [range(0, 1, 'a')], 1);
  rememberTokens(cache, 'b', () => [range(0, 1, 'b')], 1);
  assert.deepEqual([...cache.keys()], ['b']);
});