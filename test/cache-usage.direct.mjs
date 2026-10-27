import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheSplit } from '../src/cache-usage.ts';

/*
 * The usage readout splits a model's prompt tokens into what the provider
 * charged the cache rate for and what it did not.
 *
 * Providers do not all report cache coverage, and older records have none. A
 * third bucket ("input with cache status unknown") was honest about that but
 * useless in practice: it made the one number a user compares against a bill —
 * how much input was NOT cached — depend on two other numbers they cannot see.
 * Input whose cache status is unknown is input that was billed normally, so it
 * counts as non-cached; the cached figure is still only what was reported.
 */

const split = (usage) => cacheSplit({ promptTokens: 0, ...usage });

test('reported cache reads leave the rest as non-cached', () => {
  assert.deepEqual(split({ promptTokens: 100, cachedReadTokens: 30, cacheReadInputTokens: 100 }), { cached: 30, nonCached: 70, reported: true });
});

test('input with no cache status counts as non-cached, not as a third bucket', () => {
  // The case that prompted this: a model reporting 55M cached of 60.8M prompt
  // tokens, with the remaining 5.8M never given a cache status. The readout said
  // "0 non-cached input · 5,782,865 input with cache status unknown".
  const usage = { promptTokens: 60_824_840, cachedReadTokens: 55_041_975, cacheReadInputTokens: 55_041_975 };
  assert.deepEqual(cacheSplit(usage), { cached: 55_041_975, nonCached: 5_782_865, reported: true });
});

test('a provider that reports nothing leaves everything non-cached and says so', () => {
  assert.deepEqual(split({ promptTokens: 4_200 }), { cached: 0, nonCached: 4_200, reported: false });
});

test('a cached total without a coverage denominator is still a cache read', () => {
  // `cacheReadInputTokens` is the historical total, `cachedReadTokens` the latest
  // count. Either being positive is evidence that caching happened.
  const fromHistory = cacheSplit({ promptTokens: 100, cacheReadInputTokens: 40 });
  assert.deepEqual(fromHistory, { cached: 0, nonCached: 100, reported: true });
  const fromLatest = cacheSplit({ promptTokens: 100, cachedReadTokens: 40 });
  assert.deepEqual(fromLatest, { cached: 40, nonCached: 60, reported: true });
});

test('cache reads larger than the prompt are clamped, never negative', () => {
  assert.deepEqual(split({ promptTokens: 10, cachedReadTokens: 99 }), { cached: 10, nonCached: 0, reported: true });
  assert.deepEqual(split({ promptTokens: 0, cachedReadTokens: 99 }), { cached: 0, nonCached: 0, reported: true });
});

test('the two halves always add up to the prompt', () => {
  for (const usage of [
    { promptTokens: 1 },
    { promptTokens: 1_000, cachedReadTokens: 1 },
    { promptTokens: 1_000, cachedReadTokens: 999 },
    { promptTokens: 1_000, cachedReadTokens: -5 },
  ]) {
    const { cached, nonCached } = cacheSplit(usage);
    assert.equal(cached + nonCached, usage.promptTokens, JSON.stringify(usage));
    assert.ok(cached >= 0 && nonCached >= 0);
  }
});