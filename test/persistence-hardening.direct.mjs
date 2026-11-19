import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConversationStore, conversationFingerprint, conversationV2Key, enqueuePersist, estimateSerializedBytes, loadEach, measureSerializedBytes, projectV2Key, splitProjectIndex, summarizeConversation, trimPersistedConversations } from '../src/persist-core.ts';
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

test('archiving releases the compaction snapshot cache and un-archiving reloads it', () => {
  // The compaction undo/redo stacks are the heaviest per-conversation cache: up to three
  // snapshot pairs, each with a full transcript copy and model history on both sides.
  // `deleteConversation` cleared them; `archiveConversation` did not, and archive is the
  // ordinary "hide this" path — so every archived conversation kept them for the session.
  const start = agent.indexOf("if (message.type === 'archiveConversation')");
  const body = agent.slice(start, agent.indexOf("if (message.type === 'deleteConversation')"));
  assertSource(body, /this\.compactionUndoStacks\.delete\(message\.id\);/, 'archiving drops the undo snapshots');
  assertSource(body, /this\.compactionRedoStacks\.delete\(message\.id\);/, 'archiving drops the redo snapshots');
  assertSource(body, /this\.loadCompactionSnapshots\(message\.id\);/, 'un-archiving restores them, because archive is reversible');

  // The reload must come from the durable record, or un-archive would restore an empty stack.
  assertSource(agent, /private loadCompactionSnapshots\(conversationId: string\): void \{/);
  assertSource(agent, /sleepycode\.compactionSnapshots\.\$\{conversationId\}/);
  // Startup and un-archive share one implementation; a second copy would drift.
  assertSource(agent, /this\.loadCompactionSnapshots\(conversation\.id\);/);
});

function memoryStore(failOn = () => false) {
  const data = new Map();
  return {
    data,
    get(key, fallback) {
      return data.has(key) ? structuredClone(data.get(key)) : fallback;
    },
    async update(key, value) {
      if (failOn(key, value)) throw new Error(`injected write failure: ${key}`);
      if (value === undefined) data.delete(key);
      else data.set(key, structuredClone(value));
    },
  };
}

function conversationFixture(id = 'c1', text = 'hello') {
  return {
    id,
    title: 'Conversation',
    items: [{ id: `${id}-item`, role: 'user', text, timestamp: 1 }],
    messages: [{ role: 'user', content: text }],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    turnUndo: [{ items: [{ id: 'before', role: 'user', text: 'before', timestamp: 0 }], messages: [] }],
    turnRedo: [],
  };
}

test('v2 migration writes manifests and hydrates individual records with undo', async () => {
  const storage = memoryStore();
  const store = new ConversationStore(storage);
  const project = { id: 'p1', name: 'Project', path: '/p1', conversations: [conversationFixture()], activeConversationId: 'c1', createdAt: 1, updatedAt: 2 };
  assert.equal(await store.migrateProject(project), true);
  const manifest = store.readManifest('p1');
  assert.equal(manifest.version, 2);
  assert.equal(manifest.conversations[0].items.length, 0);
  assert.equal(manifest.conversations[0].messageCount, 1);
  const restored = store.readConversation('c1');
  assert.equal(restored.items[0].text, 'hello');
  assert.equal(restored.turnUndo.length, 1);
  assert.equal(restored.cold, false);
});

test('a failed v2 core write preserves the previous record and snapshot revision', async () => {
  const storage = memoryStore();
  const store = new ConversationStore(storage);
  const conversation = conversationFixture();
  assert.equal(await store.writeConversation(conversation), true);
  const firstRevision = conversation.turnSnapshotRevision;
  const firstCore = storage.get(conversationV2Key('c1'));
  conversation.items[0].text = 'newer but unsaved';
  storage.update = async (key, value) => {
    if (key === conversationV2Key('c1')) throw new Error('core write failed');
    if (value === undefined) storage.data.delete(key);
    else storage.data.set(key, structuredClone(value));
  };
  assert.equal(await store.writeConversation(conversation), false);
  assert.equal(conversation.turnSnapshotRevision, firstRevision);
  assert.deepEqual(storage.get(conversationV2Key('c1')), firstCore);
  const restored = store.readConversation('c1');
  assert.equal(restored.items[0].text, 'hello');
  assert.equal(restored.turnUndo.length, 1);
  assert.equal(store.readManifest('p1'), undefined);
});

test('a failed migration never exposes a partial manifest', async () => {
  const storage = memoryStore();
  const store = new ConversationStore(storage);
  const project = { id: 'p1', name: 'Project', path: '/p1', conversations: [conversationFixture('c1'), conversationFixture('c2', 'second')], activeConversationId: 'c1', createdAt: 1, updatedAt: 2 };
  storage.update = async (key, value) => {
    if (key === conversationV2Key('c2')) throw new Error('second record failed');
    if (value === undefined) storage.data.delete(key);
    else storage.data.set(key, structuredClone(value));
  };
  assert.equal(await store.migrateProject(project), false);
  assert.equal(storage.get(projectV2Key('p1')), undefined);
  assert.equal(store.readConversation('c1').items[0].text, 'hello');
  assert.equal(store.readConversation('c2'), undefined);
});

test('cold summaries preserve history metadata without heavy arrays', () => {
  const summary = summarizeConversation(conversationFixture(), true);
  assert.equal(summary.cold, true);
  assert.equal(summary.items.length, 0);
  assert.equal(summary.messages, undefined);
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.lastStatus, 'empty');
  assert.equal(summary.excerpt, 'hello');
});

test('snapshot restore preflights before writing and keeps a rollback path', () => {
  const start = agent.indexOf('private async restoreFileSnapshots');
  const body = agent.slice(start, agent.indexOf('private itemIndexForTurnIndex', start));
  const preflight = body.indexOf('const unavailable = snapshots.filter');
  const backup = body.indexOf('const backupRoot = await mkdtemp');
  const write = body.indexOf('vscode.workspace.fs.writeFile');
  assert.ok(preflight >= 0 && backup > preflight && write > backup, 'preflight and backups must precede every write');
  assertSource(body, /backups\.filter\(entry => entry\.attempted\)/, 'failed writes roll back every attempted file');
});

test('cold offload writes successfully before clearing heavy conversation state', () => {
  const start = agent.indexOf('private async offloadColdConversations');
  const body = agent.slice(start, agent.indexOf('private async unloadInactiveProjects', start));
  const write = body.indexOf('await this.conversationStore.writeConversation');
  const clear = body.indexOf('conversation.items = [];');
  assert.ok(write >= 0 && clear > write, 'heavy state must not be released before a successful write');
  assertSource(body, /conversation\.cold = true;/);
});

test('estimateSerializedBytes accurately estimates UTF-8 size and guards against circular graphs', () => {
  const sample = {
    id: 'conv-1',
    items: [
      { role: 'user', text: 'hello world 😊' },
      { role: 'assistant', text: 'response', flags: [true, false, null, 42] },
    ],
  };
  const actualBytes = Buffer.byteLength(JSON.stringify(sample), 'utf8');
  const estimated = estimateSerializedBytes(sample);
  assert.ok(estimated >= actualBytes * 0.7 && estimated <= actualBytes * 1.5, `estimated=${estimated}, actual=${actualBytes}`);

  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  cyclic.list = [cyclic];
  const bounded = estimateSerializedBytes(cyclic, 200);
  assert.ok(Number.isFinite(bounded) && bounded > 0);
});

test('a truncated measurement saturates upward instead of reporting a small number', () => {
  // The bug this closes: a conversation with many dense tool-call objects is node-heavy
  // but byte-light, so stopping the walk early used to report a SMALL size for a huge
  // conversation. Every caller here uses the number to decide whether to release memory.
  const denseConversation = (items, workPer) => ({
    items: Array.from({ length: items }, () => ({
      id: 'j', role: 'assistant', text: 'ok',
      work: Array.from({ length: workPer }, () => ({ kind: 'tool', id: 'w', tool: 'r', done: true, input: { a: 1, b: 2, c: 3, d: 4, e: 5 } })),
    })),
    messages: [], turnUndo: [], turnRedo: [],
  });

  // Before the fix this object measured ~2.9 MB at the old 250k-node budget — under the
  // 6 MB gate in `relieveConversationPressure`, so the ladder concluded there was
  // nothing to do and the conversation could never be compacted.
  const huge = denseConversation(8_000, 40);
  const truth = measureSerializedBytes(huge, 50_000_000);
  assert.ok(truth.truncated === false, 'the reference measurement completes');
  assert.ok(truth.bytes > 30_000_000, `the fixture is genuinely large, got ${truth.bytes}`);

  const capped = measureSerializedBytes(huge, 250_000);
  assert.equal(capped.truncated, true, 'the walk reports that it did not finish');
  assert.ok(capped.bytes >= 6_000_000, `a truncated measure must not read as small, got ${capped.bytes}`);
  assert.ok(capped.bytes <= truth.bytes, 'and must not claim more than the real size');
  // The decision the number feeds: relief must fire rather than skip.
  assert.ok(estimateSerializedBytes(huge, 250_000) > 6_000_000, 'the pressure ladder is not bypassed');
});

test('an exact measurement is unchanged and reports itself as exact', () => {
  const ordinary = { items: [{ role: 'user', text: 'hello' }], messages: [], turnUndo: [], turnRedo: [] };
  const detailed = measureSerializedBytes(ordinary);
  assert.equal(detailed.truncated, false);
  assert.equal(detailed.bytes, estimateSerializedBytes(ordinary), 'the simple form agrees with the detailed one');
  // The default budget is high enough that an ordinary conversation is exact.
  assert.equal(measureSerializedBytes(ordinary, 1_000_000).bytes, detailed.bytes);
});

function countingStore() {
  const data = new Map();
  const writes = [];
  return {
    data,
    writes,
    get(key, fallback) {
      return data.has(key) ? structuredClone(data.get(key)) : fallback;
    },
    async update(key, value) {
      writes.push(key);
      if (value === undefined) data.delete(key);
      else data.set(key, structuredClone(value));
    },
  };
}

test('a repeated checkpoint with nothing changed writes nothing', async () => {
  // Checkpoints fire every three seconds during a run and used to rewrite every
  // resident conversation in the project: 3 store writes each, measured at ~17 MB
  // serialized per pass with eight resident chats. That work runs on the extension
  // host's single thread, so it is felt as editor stutter, not just disk churn.
  const storage = countingStore();
  const store = new ConversationStore(storage);
  const conversation = conversationFixture();
  conversation.turnUndo = [];
  conversation.turnRedo = [];

  assert.equal(await store.writeConversation(conversation), true);
  const firstPass = storage.writes.length;
  assert.ok(firstPass > 0, 'the first write is a real write');

  storage.writes.length = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    assert.equal(await store.writeConversation(conversation), true, 'reporting success keeps the caller contract honest');
  }
  assert.equal(storage.writes.length, 0, '20 unchanged checkpoints cost zero store writes');
});

test('an empty undo stack costs one store write, not three', async () => {
  // Three writes per conversation were unconditional: snapshot record, core record,
  // then delete of the previous snapshot. With both stacks empty the snapshot
  // carries no information at all.
  const storage = countingStore();
  const store = new ConversationStore(storage);
  const conversation = conversationFixture();
  conversation.turnUndo = [];
  conversation.turnRedo = [];

  assert.equal(await store.writeConversation(conversation), true);
  assert.equal(storage.writes.length, 1, `expected only the core write, got ${storage.writes.join(', ')}`);
  assert.equal(storage.writes[0], conversationV2Key('c1'));
  assert.equal(conversation.turnSnapshotRevision, undefined, 'no snapshot record, so no revision to point at');
  const restored = store.readConversation('c1');
  assert.deepEqual(restored.turnUndo, [], 'a missing snapshot reads back as an empty stack');
});

test('a stale snapshot revision is dropped when the stacks are cleared', async () => {
  // Leaving the revision behind would resurrect undo entries the user had already
  // consumed, because `readConversation` trusts whatever the revision points at.
  const storage = countingStore();
  const store = new ConversationStore(storage);
  const conversation = conversationFixture();
  assert.equal(await store.writeConversation(conversation), true);
  const withUndo = conversation.turnSnapshotRevision;
  assert.ok(withUndo, 'a non-empty stack gets a revision');

  conversation.turnUndo = [];
  conversation.turnRedo = [];
  conversation.updatedAt = 99;
  assert.equal(await store.writeConversation(conversation), true);
  assert.equal(conversation.turnSnapshotRevision, undefined);
  assert.equal(storage.data.has(`sleepycode.turnSnapshots.c1.${withUndo}`), false, 'the old snapshot record is deleted');
  assert.deepEqual(store.readConversation('c1').turnUndo, []);
});

test('every conversation mutation shape is visible to the fingerprint', () => {
  const base = () => {
    const conversation = conversationFixture();
    conversation.turnUndo = [];
    conversation.turnRedo = [];
    return conversation;
  };
  const unchanged = conversationFingerprint(base());
  const assertChanged = (label, mutate) => {
    const conversation = base();
    mutate(conversation);
    assert.notEqual(conversationFingerprint(conversation), unchanged, `${label} must be detected`);
  };

  // The reason a fingerprint exists instead of comparing `updatedAt`: these three
  // mutate without bumping it, so a timestamp check would silently skip the write.
  assertChanged('setPersona', c => { c.personaId = 'reviewer'; });
  assertChanged('setMode', c => { c.mode = 'ask'; });
  assertChanged('goal token accrual', c => { c.goal = { text: 'g', status: 'active', tokensUsed: 10, tokenBudget: 100 }; });

  assertChanged('an appended turn', c => { c.items.push({ id: 'i2', role: 'assistant', text: 'done', timestamp: 2 }); });
  assertChanged('an in-place text edit', c => { c.items[0].text = 'hello again'; });
  assertChanged('a title rename', c => { c.title = 'Renamed'; });
  assertChanged('pinning', c => { c.pinned = true; });
  assertChanged('archiving', c => { c.archived = true; });
  assertChanged('a model switch', c => { c.model = 'other-model'; });
  assertChanged('model history growth', c => { c.messages.push({ role: 'assistant', content: 'hi' }); });
  assertChanged('a pending turn', c => { c.pending = { userText: 'x', messages: [] }; });
  assertChanged('replacing the item array', c => { c.items = [...c.items]; });
});

test('the same untouched conversation fingerprints identically across checkpoints', () => {
  // The per-object reference stamps are identity-based on purpose, so a freshly
  // rehydrated conversation reads as changed and gets written. What must hold is
  // that the SAME live object is stable pass to pass, which is what a checkpoint
  // relies on to skip its writes.
  const conversation = conversationFixture();
  conversation.turnUndo = [];
  conversation.turnRedo = [];
  const first = conversationFingerprint(conversation);
  for (let pass = 0; pass < 5; pass += 1) {
    assert.equal(conversationFingerprint(conversation), first, 'an unmutated conversation is stable');
  }
});

function projectFixture() {
  const first = conversationFixture('c1');
  first.turnUndo = [];
  first.turnRedo = [];
  const second = conversationFixture('c2', 'second');
  second.turnUndo = [];
  second.turnRedo = [];
  return { id: 'p1', name: 'Project', path: '/p1', conversations: [first, second], activeConversationId: 'c1', createdAt: 1, updatedAt: 2 };
}

test('a manifest is rewritten when a conversation changes and skipped when none do', async () => {
  // The manifest is a projection: it stores each conversation's message count,
  // status, and excerpt. If it were skipped while a conversation changed, the
  // history list would show a stale summary for a turn that had already been saved.
  const storage = countingStore();
  const store = new ConversationStore(storage);
  const project = projectFixture();

  assert.equal(await store.writeManifest(project), true);
  assert.equal(storage.writes.length, 1);

  storage.writes.length = 0;
  for (let pass = 0; pass < 10; pass += 1) assert.equal(await store.writeManifest(project), true);
  assert.equal(storage.writes.length, 0, 'an unchanged project costs zero manifest writes');

  project.conversations[1].updatedAt = 500;
  assert.equal(await store.writeManifest(project), true);
  assert.equal(storage.writes.length, 1, 'a changed conversation forces exactly one rewrite');
  assert.equal(store.readManifest('p1').updatedAt, 2);
});

test('a cold conversation summary in the manifest is not skipped when it is released', async () => {
  // Offloading writes `cold`, `messageCount`, `excerpt` and friends without bumping
  // `updatedAt`. If those were absent from the fingerprint the manifest would keep
  // advertising a live conversation that had already been released.
  const storage = countingStore();
  const store = new ConversationStore(storage);
  const project = projectFixture();
  assert.equal(await store.writeManifest(project), true);

  storage.writes.length = 0;
  const conversation = project.conversations[1];
  conversation.cold = true;
  conversation.messageCount = 7;
  conversation.excerpt = 'released';
  conversation.lastStatus = 'done';
  assert.equal(await store.writeManifest(project), true);
  assert.equal(storage.writes.length, 1);
  const manifest = store.readManifest('p1');
  assert.equal(manifest.conversations[1].cold, true);
  assert.equal(manifest.conversations[1].messageCount, 7);
  assert.equal(manifest.conversations[1].excerpt, 'released');
});


