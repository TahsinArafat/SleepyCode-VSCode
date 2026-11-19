import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/object-census-core.ts';

/*
 * The object census.
 *
 * The memory report can say "226 MB is live JS objects" but not what holds them. This
 * counts instances of the constructors a leak would accumulate, which is enough to name a
 * holder without a several-hundred-MB heap snapshot.
 *
 * These pin the honesty of the thing: it must report unavailability rather than zeros,
 * because "not measured" and "measured, none found" are different answers.
 */

test('the census counts the constructors a leak would accumulate', async () => {
  const counts = new Map([[Array, 12], [Object, 3400], [Map, 40], [Set, 2]]);
  const census = await c.objectCensus(async ctor => counts.get(ctor) ?? 0);
  assert.equal(census.available, true);
  const byName = Object.fromEntries(census.entries.map(e => [e.constructor, e.count]));
  assert.equal(byName.Array, 12);
  assert.equal(byName.Object, 3400);
  assert.equal(byName.Map, 40);
});

test('a constructor the engine will not answer for is skipped, not reported as zero', async () => {
  // Zero would be a lie: it would read as "measured, and there are none".
  const census = await c.objectCensus(async ctor => {
    if (ctor === Map) throw new Error('not available');
    return 7;
  });
  assert.equal(census.available, true, 'other entries still make the census usable');
  assert.equal(census.entries.some(e => e.constructor === 'Map'), false, 'the failed probe is omitted');
  assert.ok(census.entries.every(e => e.count > 0 || e.constructor !== 'Map'));
});

test('an entirely unavailable census says so rather than reporting empty', async () => {
  // The extension host has no --expose-gc, so this is the NORMAL production case.
  const census = await c.objectCensus(async () => { throw new Error('requires --expose-gc'); });
  assert.equal(census.available, false);
  assert.equal(census.entries.length, 0);
  const text = c.formatObjectCensus(census);
  assert.match(text, /unavailable/, 'says it was not measured');
  assert.match(text, /--expose-gc/, 'and says what would make it possible');
  assert.doesNotMatch(text, /0\s*$/m, 'does not imply a zero count');
});

test('only counts above a per-constructor baseline are flagged', async () => {
  // Absolute numbers are meaningless alone: a healthy process holds thousands of small
  // objects. The flag is how far a count sits above what that constructor normally holds.
  const quiet = await c.objectCensus(async ctor => (ctor === Array ? 100 : ctor === Map ? 10 : 5));
  assert.deepEqual(c.suspiciousCensusEntries(quiet), [], 'ordinary counts are not flagged');

  const leaky = await c.objectCensus(async ctor => {
    if (ctor === (globalThis.Buffer ?? Object)) return 50_000;
    if (ctor === Map) return 9_000;
    return 10;
  });
  const flagged = c.suspiciousCensusEntries(leaky).map(e => e.constructor);
  assert.ok(flagged.includes('Map'), 'a map that never shrinks is flagged');
});

test('the formatted census marks elevated rows and ranks by count', async () => {
  const census = await c.objectCensus(async ctor => {
    if (ctor === Map) return 9_000;
    if (ctor === Array) return 50;
    return 3;
  });
  const text = c.formatObjectCensus(census);
  const mapLine = text.split('\n').find(line => line.includes('Map'));
  assert.match(mapLine, /9,000/, 'counts are grouped for readability');
  assert.match(mapLine, /elevated/, 'an elevated row says so');
  const arrayLine = text.split('\n').find(line => line.trim().startsWith('Array'));
  assert.doesNotMatch(arrayLine, /elevated/, 'an ordinary row is not marked');
});

test('a probe that cannot resolve a constructor at all is skipped', async () => {
  // `Buffer` does not exist in every host; that is not an error.
  const census = await c.objectCensus(async ctor => (ctor === Array ? 5 : 0));
  assert.equal(census.available, true);
  assert.ok(census.entries.every(entry => typeof entry.count === 'number'));
});
