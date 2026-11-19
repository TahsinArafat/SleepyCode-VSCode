import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/memory-report-core.ts';
import { logClipboardText } from '../src/settings-extras.ts';

/*
 * The memory report.
 *
 * It exists because "opening it eats 6 GB" arrived with no evidence: the extension only
 * reported its footprint after a run completed, so an idle window logged nothing at all.
 * These pin the shape of the answer, because a report whose fields cannot separate the
 * possible causes sends the reader back to guessing.
 */

const report = (over = {}) => ({
  // MiB-consistent: the formatter divides by 1048576, so 300 MiB is 300 * 1048576 bytes.
  snapshot: {
    heapUsed: 100 * 1048576, heapTotal: 150 * 1048576, rss: 300 * 1048576,
    external: 10 * 1048576, arrayBuffers: 2 * 1048576,
    oldSpace: 60 * 1048576, largeObjectSpace: 5 * 1048576,
    codeSpace: 30 * 1048576, newSpace: 5 * 1048576,
    ...(over.snapshot ?? {}),
  },
  retainers: {
    projects: 1, conversations: 4, coldConversations: 3, items: 120,
    stateBytes: 4 * 1048576, stateSaturated: false, snapshotBytes: 1048576,
    indexFiles: 0, indexBytes: 0, terminals: 1, runningTerminals: 0,
    cliServerOwned: false, mcpCached: false, activeRuns: 0, queuedPrompts: 0,
    compactionBytes: 0, compactionSnapshots: 0, compactionSaturated: false,
    reactItemsBytes: 0, reactItemsSaturated: false,
    ...over.retainers,
  },
  containers: { reactItems: 1, logRing: 400, subscriptions: 30, ...over.containers },
});

test('the log line names the process totals and every releaseable retainer', () => {
  const line = m.formatMemoryLine(report());
  for (const field of ['heap', 'heapTotal', 'rss', 'external', 'arrayBuffers', 'old', 'code', 'new', 'state', 'snapshots', 'index', 'terminals', 'mcp', 'runs', 'queued']) {
    assert.match(line, new RegExp(`\\b${field}\\b`), `the log line must report ${field}`);
  }
  assert.match(line, /rss 300\.0MB/);
});

test('a saturated measurement is marked as a floor, not printed as a figure', () => {
  // A conversation too large to measure exactly reports "at least this much"; printing
  // it as an exact number is how a 41 MB chat once read as 2.9 MB.
  assert.match(m.formatMemoryLine(report({ retainers: { stateSaturated: true, stateBytes: 32 * 1048576 } })), /state >32\.0MB/);
  assert.doesNotMatch(m.formatMemoryLine(report()), /state >/, 'an exact measurement is not marked');
});

test('the full report separates the four things a large footprint could be', () => {
  const text = m.formatMemoryReport(report(), { at: 0, note: 'pid 1' });
  // Process totals: is it this extension at all, and is it the JS heap or native memory?
  assert.match(text, /heap used/);
  assert.match(text, /rss +300\.0 MB/, 'rss is the figure comparable with the editor process list');
  assert.match(text, /external/, 'bytes outside the JS heap must be visible');
  // Retained state: is it the conversations?
  assert.match(text, /Conversation state/);
  assert.match(text, /3 cold, heavy state released/);
  // Other retainers: is it the index, a terminal, an MCP connection, a CLI server?
  assert.match(text, /repo index +0 files/);
  assert.match(text, /terminals +0 running of 1/);
  // Containers: is something growing by conversation id?
  assert.match(text, /Long-lived containers/);
  assert.match(text, /logRing +400/);
});

test('container counts are listed only when they hold something', () => {
  const text = m.formatMemoryReport(report({ containers: { reactItems: 0, logRing: 0, subscriptions: 0 } }), {});
  assert.doesNotMatch(text, /Long-lived containers/, 'an empty set is noise, not evidence');
});

test('a 6 GB process with small retained state is flagged, because that is the puzzle', () => {
  // The reported case: the process is enormous while the extension's own retainers are
  // trivial. This is the line that proves the bytes are elsewhere.
  const huge = report({ snapshot: { rss: 6_442_450_944 } });
  const text = m.formatMemoryReport(huge, {});
  assert.match(text, /rss +6144\.0 MB/);
  assert.match(text, /state +4\.0 MB/, 'retained state stays small in the report, so the bytes are demonstrably elsewhere');
  assert.equal(m.isConcerning(huge.snapshot), true);
  assert.equal(m.isConcerning(report().snapshot), false, 'a normal footprint is not flagged');
});

test('megabytes rounds to one decimal and survives a non-finite value', () => {
  assert.equal(m.megabytes(1048576), '1.0');
  assert.equal(m.megabytes(0), '0.0');
  assert.equal(m.megabytes(Number.NaN), 'n/a');
});

test('the log clipboard text carries the version, so a pasted log can be matched to a build', () => {
  const text = logClipboardText(['[t] INFO a'], '0.10.10');
  assert.match(text, /^SleepyCode 0\.10\.10\n/);
  assert.match(text, /\[t\] INFO a/);
  // An unknown version must still produce a header rather than an empty line.
  assert.match(logClipboardText([], undefined), /^SleepyCode unknown\n/);
  assert.equal(logClipboardText([], '1.0').endsWith('\n'), true);
});

// ---------------------------------------------------------------------------
// The verdict: retained vs unreclaimed vs native.
//
// This is the distinction the reported case needs. A 400 MB heap with ~1 MB of retained
// state has three very different explanations, and the report exists to name which one,
// because each has a different fix (find a holder / stop worrying / look at native memory).

test('a large heap made of live objects is called retained, not garbage', () => {
  // old_space is live long-lived JS objects. Large, while the named retainers are small,
  // means something is holding them that this report does not yet name.
  const retained = report({
    snapshot: { heapUsed: 406 * 1048576, rss: 615 * 1048576, oldSpace: 300 * 1048576, codeSpace: 20 * 1048576 },
  });
  const verdict = m.memoryVerdict(retained);
  assert.match(verdict, /300\.0MB is live JS objects/, 'names old_space as the live set');
  assert.match(verdict, /account for 5\.0MB/, 'contrasts it with what is actually accounted for');
  assert.match(verdict, /somewhere this report does not name yet/, 'says so rather than guessing');
});

test('a large heap of unreclaimed space is called garbage, because that is usually benign', () => {
  // V8 sizes the heap by allocation rate, so a busy window holds far more than it needs.
  // Reporting this as a leak is the failure mode that sends an investigation the wrong way.
  const garbage = report({
    snapshot: { heapUsed: 406 * 1048576, rss: 615 * 1048576, oldSpace: 40 * 1048576, codeSpace: 20 * 1048576 },
  });
  const verdict = m.memoryVerdict(garbage);
  assert.match(verdict, /heap 406\.0MB but old_space only 40\.0MB/, 'contrasts the two');
  assert.match(verdict, /unreclaimed garbage/, 'says garbage, not leak');
  assert.match(verdict, /shrinks after a GC/, 'says what would confirm it');
});

test('compiled JavaScript is named when the heap is dominated by it', () => {
  // The bundle inlines the AI SDK, MCP SDK, zod, prosemirror and react. Code is real
  // memory and is not session data, so it must not be read as a leak.
  const code = report({
    snapshot: { heapUsed: 300 * 1048576, oldSpace: 100 * 1048576, codeSpace: 180 * 1048576 },
  });
  assert.match(m.memoryVerdict(code), /compiled JavaScript/, 'code_space is called out as dependencies');
});

test('bytes outside the JS heap are named when they dominate', () => {
  const native = report({
    snapshot: { heapUsed: 100 * 1048576, oldSpace: 50 * 1048576, external: 800 * 1048576, rss: 1_200 * 1048576 },
  });
  assert.match(m.memoryVerdict(native), /outside the JS heap/, 'external memory is its own explanation');
});

test('a normal footprint is described as retained state, not an explanation of a problem', () => {
  const fine = report();
  const verdict = m.memoryVerdict(fine);
  assert.match(verdict, /retained state 5\.0MB across 4 conversations/);
  assert.doesNotMatch(verdict, /leak|garbage|unreclaimed/);
});

test('a post-GC figure is used when the engine exposes one, and explains itself otherwise', () => {
  // --expose-gc is not used by an extension host, so the honest report says the totals
  // include unreclaimed space rather than implying they are a live set.
  const withoutGc = m.formatMemoryReport(report(), {});
  assert.match(withoutGc, /heap after GC is unavailable/, 'says the measurement is missing');
  assert.match(withoutGc, /Compare repeated reports instead/, 'gives the reader the next step');

  const withGc = report({ snapshot: { heapUsed: 400 * 1048576, heapAfterGc: 120 * 1048576 } });
  const text = m.formatMemoryReport(withGc, {});
  assert.match(text, /after GC +120\.0 MB/, 'reports the measured live set');
  assert.match(text, /reclaimed 280\.0 MB/, 'and what a GC would have freed');
});

test('the report always ends with a reading of its own numbers', () => {
  // A reader who does not know the codebase still needs to know which section grew.
  assert.match(m.formatMemoryReport(report(), {}), /^Reading: /m, 'the verdict closes the report');
});

// ---------------------------------------------------------------------------
// The reported case: 126 MB of live objects beside the report's own "1 MB of state".
//
// The two figures were both true. Conversation state was measured once while three
// further copies of the same transcript sat in compaction stacks and the webview's
// per-conversation cache, and nothing in the report counted them.

test('compaction snapshots and the webview copy are counted, not just described', () => {
  const withCopies = report({
    retainers: {
      stateBytes: 1 * 1048576,
      compactionBytes: 96 * 1048576,
      compactionSnapshots: 3,
      reactItemsBytes: 28 * 1048576,
    },
  });
  const text = m.formatMemoryReport(withCopies, {});
  assert.match(text, /compaction +96\.0 MB/, 'the snapshot bytes are shown');
  assert.match(text, /3 undo\/redo snapshot/, 'and how many snapshots hold them');
  assert.match(text, /webview copy +28\.0 MB/, 'the per-conversation copy is shown');
  // The point: the explained total now approaches the heap instead of contradicting it.
  const log = m.formatMemoryLine(withCopies);
  assert.match(log, /compaction 96\.0MB\/3/);
  assert.match(log, /reactItems 28\.0MB/);
});

test('the verdict counts the copies, so it stops claiming only 1 MB is held', () => {
  // With 300 MB of old_space and the copies counted, the "accounted for" figure must
  // reflect them -- otherwise the reading says "held somewhere this report does not
  // name" while the report is in fact naming it.
  const explained = report({
    snapshot: { oldSpace: 300 * 1048576, heapUsed: 320 * 1048576 },
    retainers: { stateBytes: 1 * 1048576, compactionBytes: 96 * 1048576, reactItemsBytes: 28 * 1048576, snapshotBytes: 0, indexBytes: 0 },
  });
  assert.match(m.memoryVerdict(explained), /account for 125\.0MB/, 'copies are part of what is accounted for');
});

test('a saturated copy measurement reads as a floor like every other figure', () => {
  const saturated = report({ retainers: { compactionBytes: 32 * 1048576, compactionSaturated: true, reactItemsSaturated: true, reactItemsBytes: 32 * 1048576 } });
  const text = m.formatMemoryReport(saturated, {});
  assert.match(text, /compaction +>32\.0 MB/);
  assert.match(text, /webview copy +>32\.0 MB/);
  assert.match(m.formatMemoryLine(saturated), /compaction >32\.0MB/);
});
