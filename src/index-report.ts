/*
 * What the index is, in the terms this build actually works in.
 *
 * SleepyCode builds a lexical project index — files, symbols, imports, languages,
 * frameworks — and answers context questions from it. The ported Indexing page was
 * about something else entirely: embeddings, vector chunks, an embedding model and
 * its runtime, plus documentation sources. None of that exists here, so that page
 * could only ever show an empty index with a disabled progress bar.
 *
 * This module turns the index snapshot into the readout that page shows.
 */

export interface IndexSnapshotLike {
  generatedAt?: number;
  fileCount?: number;
  indexedFileCount?: number;
  languages?: { language: string; files: number }[];
  frameworks?: string[];
  importantFiles?: string[];
}

export interface IndexReport {
  state: 'empty' | 'ready';
  /** False when indexing is switched off entirely: the index is not consulted. */
  enabled: boolean;
  /** "12 of 340 files" — what was read, against what was found. */
  files: string;
  /** How old the index is, in words. */
  age: string;
  /** True once the cached snapshot is older than the rebuild window. */
  stale: boolean;
  languages: { language: string; files: number }[];
  frameworks: string[];
  importantFiles: string[];
}

/** The cache window in `ProjectIndexService.ensure`: older than this is rebuilt. */
export const INDEX_FRESH_MS = 10 * 60 * 1000;

function ageText(generatedAt: number | undefined, now: number): string {
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt) || generatedAt <= 0) return 'never built';
  const minutes = Math.max(0, Math.round((now - generatedAt) / 60_000));
  if (minutes < 1) return 'built just now';
  if (minutes < 60) return `built ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `built ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `built ${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The index readout.
 *
 * An index that was never built and one that was built from nothing are different
 * facts, and both look like "0 files" — the headline says which.
 */
export function indexReport(snapshot: IndexSnapshotLike | undefined, now = Date.now(), options: { enabled?: boolean } = {}): IndexReport {
  const enabled = options.enabled !== false;
  if (!snapshot || typeof snapshot !== 'object') {
    return { state: 'empty', enabled, files: 'Not built yet', age: 'never built', stale: true, languages: [], frameworks: [], importantFiles: [] };
  }
  const indexed = typeof snapshot.indexedFileCount === 'number' ? snapshot.indexedFileCount : 0;
  const total = typeof snapshot.fileCount === 'number' ? snapshot.fileCount : 0;
  const languages = Array.isArray(snapshot.languages)
    ? snapshot.languages
        .filter(entry => entry && typeof entry.language === 'string' && typeof entry.files === 'number')
        .slice()
        .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language))
    : [];
  const generatedAt = snapshot.generatedAt;
  return {
    state: indexed > 0 ? 'ready' : 'empty',
    enabled,
    files: indexed > 0 ? `${indexed} of ${total} files read` : `${total} files found, none read`,
    age: ageText(generatedAt, now),
    stale: typeof generatedAt !== 'number' || now - generatedAt > INDEX_FRESH_MS,
    languages,
    frameworks: Array.isArray(snapshot.frameworks) ? snapshot.frameworks.filter(value => typeof value === 'string') : [],
    importantFiles: Array.isArray(snapshot.importantFiles) ? snapshot.importantFiles.filter(value => typeof value === 'string') : [],
  };
}