import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enqueuePersist, loadEach, splitProjectIndex } from '../src/persist-core.ts';

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');

test('a failed write does not poison the persist chain', async () => {
  const written = [];
  let chain = Promise.resolve();
  const failures = [];

  chain = enqueuePersist(chain, async () => { written.push('a'); }, error => failures.push(error));
  await chain;

  // A write that rejects is the failure that used to kill all later saving.
  chain = enqueuePersist(chain, async () => { throw new Error('globalState full'); }, error => failures.push(error));
  await chain;

  chain = enqueuePersist(chain, async () => { written.push('c'); }, error => failures.push(error));
  await chain;

  assert.deepEqual(written, ['a', 'c'], 'writes after a rejection must still run');
  assert.equal(failures.length, 1, 'the failure is reported once');
  assert.match(String(failures[0]), /globalState full/);
});

test('the persist chain resolves even when the write fails', async () => {
  const chain = enqueuePersist(Promise.resolve(), async () => { throw new Error('boom'); }, () => undefined);
  await assert.doesNotReject(() => chain);
});

test('a poisoned chain is recovered rather than skipping the next write', async () => {
  // Starting from an ALREADY rejected chain is the worst case: without the second
  // handler passed to .then, every later write is skipped forever.
  let ran = false;
  const chain = enqueuePersist(Promise.reject(new Error('earlier failure')), async () => { ran = true; }, () => undefined);
  await chain;
  assert.equal(ran, true, 'a write queued behind an already-rejected chain must still run');
});

test('unreadable index entries are preserved, never filtered away', () => {
  const isValid = entry => Boolean(entry) && typeof entry.id === 'string';
  const { usable, unreadable } = splitProjectIndex([{ id: 'a' }, { nope: true }, null, { id: 'b' }], isValid);

  assert.deepEqual(usable, [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(unreadable, [{ nope: true }, null]);
});

test('the index rewrite carries unreadable entries so history is not deleted', () => {
  // The index is rewritten after load. If the rewrite only emits valid entries, a
  // malformed record permanently loses that project's history.
  assert.match(agent, /\.\.\.this\.unreadableProjectEntries/);
});

test('one corrupt record does not abort the load of the others', () => {
  const loaded = loadEach(
    [{ n: 1 }, { n: 2 }],
    record => record.n * 10,
    () => -1,
    () => undefined,
  );
  assert.deepEqual(loaded, [10, 20]);

  const partial = loadEach(
    [{ n: 1 }, { n: 2 }, { n: 3 }],
    record => { if (record.n === 2) throw new Error('corrupt'); return record.n * 10; },
    () => -1,
    () => undefined,
  );
  assert.deepEqual(partial, [10, -1, 30], 'a corrupt record degrades alone, not the whole load');
});

test('startup load is guarded so a failure is reported instead of an empty chat', () => {
  assert.match(agent, /try \{\s*\n\s*this\.loadProjects\(\);/);
  assert.match(agent, /projects\.load\.failed/);
});

test('a persistence failure is surfaced to the user, not swallowed', () => {
  assert.match(agent, /persist\.failed/);
  assert.match(agent, /could not save your conversations/);
});
