import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  captureFileSnapshot,
  captureRedoSnapshot,
  isRestorable,
  unrestorableReason,
  MAX_SNAPSHOT_BYTES,
} from '../src/file-snapshot-core.ts';

/*
 * A snapshot holds a file's whole contents, and it rides on every assistant item and every
 * `pending` checkpoint, which `checkpointConversation` rewrites to `globalState` every 3
 * seconds while a run is active. Measured at 60 edits of 40 KB files, one turn's snapshots
 * were 2.3 MB per checkpoint, so a two-minute turn rewrote ~94 MB, and the unbounded worst
 * case is 0.5 GB for one conversation. These pin the cap and, more importantly, the refusal:
 * an oversized snapshot must never be written back as an empty file.
 */

const root = mkdtempSync(path.join(tmpdir(), 'snapshot-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

const write = (name, size) => {
  const full = path.join(root, name);
  writeFileSync(full, 'x'.repeat(size));
  return full;
};

test('a file at or under the cap is captured in full', () => {
  write('small.ts', 1000);
  const snap = captureFileSnapshot(root, 'small.ts');
  assert.equal(snap.existed, true);
  assert.equal(snap.content.length, 1000);
  assert.equal(snap.oversized, undefined);
  assert.equal(isRestorable(snap), true);
});

test('a file exactly at the cap is still captured', () => {
  // The boundary is inclusive: `<=`. Off-by-one here would refuse a file the limit allows.
  const size = MAX_SNAPSHOT_BYTES;
  write('boundary.ts', size);
  const snap = captureFileSnapshot(root, 'boundary.ts');
  assert.equal(snap.content.length, size);
  assert.equal(snap.oversized, undefined);
});

test('a file one byte over the cap is refused, not truncated', () => {
  const size = MAX_SNAPSHOT_BYTES + 1;
  write('toobig.ts', size);
  const snap = captureFileSnapshot(root, 'toobig.ts');
  assert.equal(snap.content, '', 'no partial content may be kept');
  assert.equal(snap.oversized, true);
  assert.equal(snap.existed, true, 'the file did exist, so undo knows there is something to put back');
  assert.equal(isRestorable(snap), false);
});

test('an oversized snapshot reports why it cannot be restored', () => {
  const snap = captureFileSnapshot(root, 'toobig.ts');
  assert.match(unrestorableReason(snap), /too large to snapshot/);
  assert.match(unrestorableReason(snap), /toobig\.ts/);
});

test('pressure-evicted content is unrestorable and explains the budget release', () => {
  const snap = { path: 'large.ts', existed: true, content: '', pressureEvicted: true };
  assert.equal(isRestorable(snap), false);
  assert.match(unrestorableReason(snap), /released to stay within memory limits/);
  assert.match(unrestorableReason(snap), /cannot be restored/);
});

test('a missing file is recorded as not having existed', () => {
  const snap = captureFileSnapshot(root, 'nope.ts');
  assert.equal(snap.existed, false);
  assert.equal(snap.content, '');
  assert.equal(snap.oversized, undefined, 'a missing file is not an oversized one');
  assert.equal(isRestorable(snap), true, 'deleting a file the agent created is a real restore');
});

test('a caller-supplied "before" string is bounded the same way as a disk read', () => {
  // The tool often already holds the previous text and passes it in to skip a read. That path
  // must not become the way around the cap.
  const small = captureFileSnapshot(root, 'x.ts', 'a'.repeat(1000));
  assert.equal(small.content.length, 1000);
  const big = captureFileSnapshot(root, 'x.ts', 'a'.repeat(MAX_SNAPSHOT_BYTES + 1));
  assert.equal(big.oversized, true);
  assert.equal(big.content, '');
});

test('a "before" string overrides what is on disk, as the forward path expects', () => {
  write('both.ts', 10);
  const snap = captureFileSnapshot(root, 'both.ts', 'from the tool');
  assert.equal(snap.content, 'from the tool');
});

test('a redo snapshot reads the file as it is now, bounded', () => {
  write('redo.ts', 500);
  const snap = captureRedoSnapshot(root, 'redo.ts');
  assert.equal(snap.existed, true);
  assert.equal(snap.content.length, 500);

  write('redo-big.ts', MAX_SNAPSHOT_BYTES + 1);
  const big = captureRedoSnapshot(root, 'redo-big.ts');
  assert.equal(big.oversized, true, 'redo entries are retained for the session, so they are capped too');
  assert.equal(big.content, '');
});

test('a redo snapshot of a missing file records it as absent', () => {
  const snap = captureRedoSnapshot(root, 'gone.ts');
  assert.equal(snap.existed, false);
  assert.equal(snap.content, '');
});

test('the cap matches the limit tool reads and the workspace scan apply', () => {
  // Three subsystems bound file size; if these drift, a file one of them accepts becomes a
  // snapshot the others refuse, and the failure surfaces as a lost undo rather than a type error.
  const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
  const match = types.match(/export const MAX_FILE_BYTES = ([\d_]+);/);
  assert.ok(match, 'MAX_FILE_BYTES must exist in types.ts');
  assert.equal(Number(match[1].replaceAll('_', '')), MAX_SNAPSHOT_BYTES);
});