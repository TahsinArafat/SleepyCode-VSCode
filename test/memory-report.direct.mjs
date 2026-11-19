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
  snapshot: { heapUsed: 100 * 1048576, heapTotal: 150 * 1048576, rss: 300 * 1048576, external: 10 * 1048576, arrayBuffers: 2 * 1048576, ...(over.snapshot ?? {}) },
  retainers: {
    projects: 1, conversations: 4, coldConversations: 3, items: 120,
    stateBytes: 4 * 1048576, stateSaturated: false, snapshotBytes: 1048576,
    indexFiles: 0, indexBytes: 0, terminals: 1, runningTerminals: 0,
    cliServerOwned: false, mcpCached: false, activeRuns: 0, queuedPrompts: 0,
    ...over.retainers,
  },
  containers: { reactItems: 1, logRing: 400, subscriptions: 30, ...over.containers },
});

test('the log line names the process totals and every releaseable retainer', () => {
  const line = m.formatMemoryLine(report());
  for (const field of ['heap', 'heapTotal', 'rss', 'external', 'arrayBuffers', 'state', 'snapshots', 'index', 'terminals', 'mcp', 'runs', 'queued']) {
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
