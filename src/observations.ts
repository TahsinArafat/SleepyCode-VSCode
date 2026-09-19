/**
 * Non-destructive observation storage.
 *
 * Tool output is never silently destroyed. When a result exceeds what is useful
 * inline, the full text is archived under the workspace's `.sleepycode/observations`
 * directory and the model receives a bounded view plus a handle it can page back
 * with `obs_recall`. This mirrors the ObservationPack mechanism used by SoL-Pi:
 * large results stay reachable without being replayed on every provider request.
 *
 * The store is dependency-free (only node builtins) so it can be unit tested
 * directly and reused outside the VS Code host.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Results larger than this are archived and replaced with a handle. */
export const OBSERVATION_THRESHOLD_BYTES = 8 * 1024;
/** Bytes of head/tail excerpt included inline alongside the handle. */
export const OBSERVATION_EXCERPT_BYTES = 1_500;
/** Default page size for `obs_recall`. */
export const OBSERVATION_PAGE_BYTES = 16 * 1024;

export type ObservationHandle = {
  id: string;
  /** Absolute path of the archived full text. */
  path: string;
  bytes: number;
  lines: number;
  /** Head/tail excerpt shown inline in place of the full payload. */
  excerpt: string;
};

export type ObservationPage = {
  text: string;
  /** Byte offset to pass on the next recall, or null when the end was reached. */
  nextOffset: number | null;
  totalBytes: number;
};

function countLines(text: string): number {
  if (!text.length) return 0;
  let lines = text.endsWith('\n') ? 0 : 1;
  for (const character of text) if (character === '\n') lines += 1;
  return lines;
}

function observationId(text: string): string {
  return `obs_${createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

function excerpt(text: string): string {
  if (text.length <= OBSERVATION_EXCERPT_BYTES * 2) return text;
  const head = text.slice(0, OBSERVATION_EXCERPT_BYTES);
  const tail = text.slice(-OBSERVATION_EXCERPT_BYTES);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n…(${omitted} bytes omitted — call obs_recall with id to read the rest)…\n\n${tail}`;
}

/**
 * Archive `text` and return a handle. Writing is idempotent: the same content
 * maps to the same id, so repeated reads of the same file do not duplicate data.
 */
export async function archiveObservation(observationsDir: string, _toolName: string, text: string): Promise<ObservationHandle> {
  const id = observationId(text);
  await mkdir(observationsDir, { recursive: true });
  const filePath = join(observationsDir, `${id}.txt`);
  await writeFile(filePath, text, 'utf8').catch(async error => {
    // A concurrent archive of identical content is fine — the bytes already match.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  });
  return {
    id,
    path: filePath,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: countLines(text),
    excerpt: excerpt(text),
  };
}

/**
 * Bounded, non-destructive view of tool output. Small payloads pass through
 * unchanged; large ones are archived and replaced with a handle plus excerpt.
 * Returns the archived handle when one was created so callers can report it.
 */
export async function capObservation(observationsDir: string, toolName: string, text: string, threshold = OBSERVATION_THRESHOLD_BYTES): Promise<{ text: string; observation?: ObservationHandle }> {
  if (Buffer.byteLength(text, 'utf8') <= threshold) return { text };
  const observation = await archiveObservation(observationsDir, toolName, text);
  const header = `[archived observation ${observation.id}: ${observation.lines} lines, ${observation.bytes} bytes. Call obs_recall with id "${observation.id}" and an optional byte offset to read more.]`;
  return { text: `${header}\n\n${observation.excerpt}`, observation };
}

/**
 * Read a page of an archived observation. Offsets are byte-based and always
 * return whole lines except when a single line exceeds the page size.
 */
export async function readObservationPage(observationsDir: string, id: string, offset = 0): Promise<ObservationPage> {
  if (!/^obs_[a-f0-9]{24}$/.test(id)) throw new Error(`Invalid observation id: ${id}`);
  const filePath = join(observationsDir, `${id}.txt`);
  const buffer = await readFile(filePath);
  const totalBytes = buffer.length;
  const start = Math.max(0, Math.min(offset, totalBytes));
  let end = Math.min(start + OBSERVATION_PAGE_BYTES, totalBytes);
  // Prefer to end on a line boundary so recalled pages read cleanly.
  if (end < totalBytes) {
    const nextNewline = buffer.indexOf(0x0a, end);
    if (nextNewline !== -1 && nextNewline - end < OBSERVATION_PAGE_BYTES) end = nextNewline + 1;
  }
  const text = buffer.subarray(start, end).toString('utf8');
  return { text, nextOffset: end >= totalBytes ? null : end, totalBytes };
}
