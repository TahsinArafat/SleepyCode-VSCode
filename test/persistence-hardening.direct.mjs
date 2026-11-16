import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enqueuePersist, loadEach, splitProjectIndex, trimPersistedConversations } from '../src/persist-core.ts';
import { assertSource } from './source-assert.mjs';
import { MAX_TURN_UNDO } from '../src/types.ts';

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const sessionCore = readFileSync(new URL('../src/session-core.ts', import.meta.url), 'utf8');

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

test('a stored undo stack longer than the cap is clamped on load', () => {
  // The in-memory push sites already slice to MAX_TURN_UNDO. Load is a separate
  // path over untrusted stored input: a record written by an older build (or a
  // hand-edited one) used to load unbounded and stay that way for the session.
  //
  // The clamp lives in session-core's restoreLoadedConversation now, so it is
  // asserted there (behaviorally, in session-core.direct.mjs) and pinned here as
  // the routing requirement: every stored conversation goes through that helper.
  assertSource(sessionCore, 'conversation.turnUndo = Array.isArray(conversation.turnUndo) ? conversation.turnUndo.slice(-options.maxTurnUndo) : [];');
  assertSource(sessionCore, 'conversation.turnRedo = Array.isArray(conversation.turnRedo) ? conversation.turnRedo.slice(-options.maxTurnUndo) : [];');
  assertSource(agent, 'maxTurnUndo: MAX_TURN_UNDO,');
  // Both the undo and the redo-failure-reversal push must use the same constant;
  // a literal 5 here would drift from the load clamp.
  assertSource(agent, 'conversation.turnUndo = [...(conversation.turnUndo ?? []), popped.snapshot].slice(-MAX_TURN_UNDO);');
  assertSource(agent, 'conversation.turnUndo = [...(conversation.turnUndo ?? []), snapshot].slice(-MAX_TURN_UNDO);');
  assert.equal(MAX_TURN_UNDO, 5, 'the cap the in-memory path documented');
});

test('logging does not re-persist the whole ring on every line', () => {
  // `log()` is called from ~115 sites, several per model call. Each call used to do a
  // globalState.get of the 400-entry ring plus a full update of it. The ring is now
  // in memory, flushed on a debounce and on dispose.
  assertSource(agent, 'private logRingEntries(): ExtensionLogEntry[] {');
  assertSource(agent, 'this.logRing ??= this.context.globalState.get<ExtensionLogEntry[]>(AgentViewProvider.LOG_KEY, []);');
  assertSource(agent, 'private scheduleLogFlush(): void {');
  assertSource(agent, 'private async flushLogs(): Promise<void> {');
  // The write must survive deactivate, or the lines closest to a failure are lost.
  assertSource(agent, 'if (this.logRing) void this.flushLogs().catch(');
  // And a burst must stay a burst: exactly one write is queued per debounce window.
  assertSource(agent, 'if (this.logFlushTimer) return;');
});

test('the persisted conversation byte budget evicts oldest-first and respects the limit', () => {
  const make = (id, kb, pinned) => ({ id, pinned, blob: 'x'.repeat(kb * 1000) });
  const measure = value => JSON.stringify(value).length;
  const kept = trimPersistedConversations([make('a', 4), make('b', 4), make('c', 4), make('d', 4)], 9000, measure);
  assert.deepEqual(kept.kept.map(item => item.id), ['a', 'b'], 'the newest conversations survive');
  assert.deepEqual(kept.dropped.map(item => item.id), ['c', 'd'], 'the oldest are dropped, reported');
  assert.ok(kept.bytes <= 9000, 'the budget is an actual ceiling');
});

test('the byte budget never evicts the pinned or the active conversation', () => {
  const make = (id, kb, pinned) => ({ id, pinned, blob: 'x'.repeat(kb * 1000) });
  const measure = value => JSON.stringify(value).length;
  const pinned = trimPersistedConversations([make('pinned', 4, true), make('b', 4), make('c', 4), make('d', 4)], 9000, measure);
  assert.ok(pinned.kept.some(item => item.id === 'pinned'), 'a pinned conversation is what the user asked to keep');
  // The active conversation may sort last (it is often the one being edited), which is
  // exactly the entry naive oldest-first eviction would delete first.
  const active = trimPersistedConversations([make('new', 4), make('mid', 4), make('active', 5)], 6000, measure, { keepId: 'active' });
  assert.deepEqual(active.kept.map(item => item.id), ['active'], 'the open conversation is never trimmed away');
});

test('a project under the byte budget is persisted untouched', () => {
  const list = [{ id: 'a', pinned: false, blob: 'x'.repeat(100) }, { id: 'b', pinned: false, blob: 'y'.repeat(100) }];
  const result = trimPersistedConversations(list, 1_000_000, value => JSON.stringify(value).length);
  assert.deepEqual(result.kept.map(item => item.id), ['a', 'b']);
  assert.deepEqual(result.dropped, [], 'normal use must not hit the trim path at all');
});

test('both persist paths apply the byte budget, not just the count limit', () => {
  // persistProjects (coarse) and persistProject (mid-run checkpoints) used to slice to
  // MAX_PERSISTED_CONVERSATIONS inline. If one path forgets the budget, a checkpoint
  // rewrites the oversized record the coarse path just trimmed.
  assertSource(agent, 'conversations: this.persistedConversationsFor(project),');
  const applies = agent.match(/conversations: this\.persistedConversationsFor\(project\),/g) ?? [];
  assert.equal(applies.length, 2, 'both write sites go through the shared trim');
  assertSource(agent, '{ keepId: project.activeConversationId },');
  assertSource(agent, "this.log('warn', 'persist.project.trimmed'");
});
