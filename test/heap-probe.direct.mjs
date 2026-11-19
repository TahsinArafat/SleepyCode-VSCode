import test from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import * as v8 from 'node:v8';
import * as p from '../src/heap-probe-core.ts';

/*
 * Forcing a collection without restarting the process.
 *
 * Every report until now had to say "this includes unreclaimed space, compare repeated
 * reports instead". The user's own numbers showed why that is not good enough: 406 MB
 * fell to 151 MB on its own between two reports while old_space stayed at 126 MB. Only
 * the post-collection figure separates a leak from a pending GC.
 */

test('a collector is acquired through the runtime flag and the vm context', () => {
  const gc = p.acquireGc({
    setFlagsFromString: flags => v8.setFlagsFromString(flags),
    runInNewContext: code => vm.runInNewContext(code),
  });
  assert.ok(gc, 'a collector is available');
  assert.equal(gc.collect(), true, 'and it reports success');
});

test('the collector really collects: garbage made before it is reclaimed', () => {
  // The load-bearing claim. A no-op that merely returns true would make every report
  // claim 0 MB is reclaimable, which is worse than saying nothing.
  const gc = p.acquireGc({
    setFlagsFromString: flags => v8.setFlagsFromString(flags),
    runInNewContext: code => vm.runInNewContext(code),
  });
  const MB = 1048576;
  const before = process.memoryUsage().heapUsed;
  // Allocated in a function so no reference survives the call.
  (() => { const junk = Array.from({ length: 300_000 }, (_, i) => ({ i, s: 'x'.repeat(40) })); return junk.length; })();
  const dirty = process.memoryUsage().heapUsed;
  const after = p.heapAfterCollection(gc, () => process.memoryUsage().heapUsed);
  assert.ok(dirty - before > 20 * MB, `the fixture allocates real garbage (${((dirty - before) / MB).toFixed(0)}MB)`);
  assert.ok(after < dirty, 'the collection reduced the heap');
  assert.ok(dirty - after > 20 * MB, `and reclaimed the garbage (${((dirty - after) / MB).toFixed(0)}MB)`);
});

test('an engine that refuses the flag yields no collector rather than throwing', () => {
  // A diagnostic that cannot run must not be a diagnostic that breaks the caller.
  assert.equal(p.acquireGc({
    setFlagsFromString: () => { throw new Error('flags are frozen'); },
    runInNewContext: () => undefined,
  }), undefined);

  assert.equal(p.acquireGc({}), undefined, 'missing dependencies are not an error');
  assert.equal(p.acquireGc({
    setFlagsFromString: () => undefined,
    runInNewContext: () => undefined, // no gc in this context
  }), undefined, 'a context without a collector is reported as unavailable');
});

test('a collection that throws is reported as not having happened', () => {
  // "collected nothing" and "could not collect" must not look the same.
  const broken = { collect: () => false };
  assert.equal(p.heapAfterCollection(broken, () => 123), undefined);
  assert.equal(p.heapAfterCollection(undefined, () => 123), undefined);
});

test('the post-collection heap is read after the collection, not before', () => {
  let reads = 0;
  const gc = { collect: () => { reads += 1; return true; } };
  const value = p.heapAfterCollection(gc, () => { reads += 1; return 42; });
  assert.equal(value, 42);
  assert.equal(reads, 2, 'collect, then measure');
});
