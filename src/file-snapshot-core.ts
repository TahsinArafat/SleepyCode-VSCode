/**
 * Pre-edit file snapshots for undo.
 *
 * A snapshot holds a file's entire contents so a turn can be reverted outside Git. That
 * makes it the heaviest thing a conversation carries: it rides on every assistant item and
 * on every `pending` checkpoint, and `checkpointConversation` rewrites the project to
 * `globalState` every 3 seconds while a run is active. Measured at 60 edits of 40 KB files,
 * one turn's snapshots were 2.3 MB per checkpoint, so a two-minute turn rewrote ~94 MB; the
 * unbounded worst case is 0.5 GB for a single conversation (2000 items x 250 KB).
 *
 * So the size is capped at `MAX_FILE_BYTES` — the same limit tool reads (`tools.ts`) and the
 * workspace scan (`repo-index.ts`) already apply. Over the cap the snapshot keeps its path
 * and `existed` but no content, and is marked `oversized` so a restore reports it instead of
 * writing an empty file over one it has no copy of.
 *
 * Pure and DOM-free so the boundary is asserted directly, the way `markdown-blocks.ts` is:
 * the callers in `agent.ts` cannot be loaded by the node test runner.
 */

import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { FileSnapshot } from './types';

// `types.ts` owns the shape so the transcript, the persistence layer and this module cannot
// disagree about it; this module only owns the rule for filling one in.
export type { FileSnapshot };

/**
 * Largest file that will be snapshotted.
 *
 * Duplicated from `MAX_FILE_BYTES` in `types.ts` rather than imported: that module is types
 * only, and importing a runtime value from it would make this file unresolvable to the node
 * test runner, which is the whole reason the rule lives here. `test/file-snapshot-core.direct.mjs`
 * asserts the two stay equal, so the duplication cannot drift silently.
 */
export const MAX_SNAPSHOT_BYTES = 250_000;
/** Total original content retained for one assistant turn before restore is disabled. */
export const MAX_TURN_SNAPSHOT_BYTES = 4_000_000;

/**
 * Capture a file's pre-edit content so undo can restore it outside Git.
 *
 * `before` avoids a disk read when the tool already supplied the previous text.
 *
 * The content is never truncated: restoring a partial file would corrupt it, which is worse
 * than declining to restore. `existed: false` with empty content is the one legitimate empty
 * snapshot — it means the file did not exist before, so undo deletes it.
 */
export function captureFileSnapshot(
  rootPath: string,
  relative: string,
  before?: unknown,
  existed?: boolean,
  maxBytes: number = MAX_SNAPSHOT_BYTES,
): FileSnapshot {
  if (typeof before === 'string') {
    if (before.length <= maxBytes) return { path: relative, existed: existed ?? true, content: before };
    return { path: relative, existed: existed ?? true, content: '', oversized: true };
  }
  try {
    const content = readFileSync(path.join(rootPath, relative), 'utf8');
    if (content.length <= maxBytes) return { path: relative, existed: existed ?? true, content };
    return { path: relative, existed: existed ?? true, content: '', oversized: true };
  } catch {
    return { path: relative, existed: false, content: '' };
  }
}

/**
 * A snapshot for a file that exists on disk right now, used to build a redo entry.
 *
 * Bounded for the same reason as the forward path, and for a sharper one: redo entries live
 * in `turnUndo`/`turnRedo` (up to 5 turns) for the rest of the session, so an unbounded read
 * here would pin the current contents of every edited file in memory until the window closed.
 */
export function captureRedoSnapshot(rootPath: string, relative: string, maxBytes: number = MAX_SNAPSHOT_BYTES): FileSnapshot {
  try {
    if (!statSync(path.join(rootPath, relative)).isFile()) return { path: relative, existed: false, content: '' };
  } catch {
    return { path: relative, existed: false, content: '' };
  }
  return captureFileSnapshot(rootPath, relative, undefined, true, maxBytes);
}

/** Whether a snapshot can be written back. False means the restore must be reported, not attempted. */
export function isRestorable(snapshot: FileSnapshot): boolean {
  return snapshot.oversized !== true && snapshot.pressureEvicted !== true;
}

/** The message shown when a snapshot cannot be restored. */
export function unrestorableReason(snapshot: FileSnapshot): string {
  if (snapshot.pressureEvicted) return `${snapshot.path}: snapshot content was released to stay within memory limits, so this turn cannot be restored`;
  return `${snapshot.path}: too large to snapshot (${Math.round(MAX_SNAPSHOT_BYTES / 1024)} KB limit), so it cannot be restored`;
}