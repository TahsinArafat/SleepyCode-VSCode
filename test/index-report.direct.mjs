import test from 'node:test';
import assert from 'node:assert/strict';
import { indexReport, INDEX_FRESH_MS } from '../src/index-report.ts';

/*
 * SleepyCode's index is lexical — files, symbols, imports, languages, frameworks.
 * The ported Indexing page was about embeddings, vector chunks and an embedding
 * model, none of which exist here, so it could only ever show an empty index. This
 * is the readout that page shows instead.
 */

const now = 1_000_000_000;
const snapshot = {
  generatedAt: now - 2 * 60_000,
  fileCount: 340,
  indexedFileCount: 120,
  languages: [{ language: 'TypeScript', files: 8 }, { language: 'CSS', files: 2 }, { language: 'Markdown', files: 5 }],
  frameworks: ['React', 'esbuild'],
  importantFiles: ['package.json', 'README.md'],
};

test('an index that was never built says so, and counts as stale', () => {
  const report = indexReport(undefined, now);
  assert.equal(report.state, 'empty');
  assert.equal(report.files, 'Not built yet');
  assert.equal(report.age, 'never built');
  // Prompting a build is the right action, so this must not read as fresh.
  assert.equal(report.stale, true);
});

test('a built index reports what was read against what was found', () => {
  const report = indexReport(snapshot, now);
  assert.equal(report.state, 'ready');
  assert.equal(report.files, '120 of 340 files read');
  assert.equal(report.age, 'built 2 minutes ago');
  assert.equal(report.stale, false);
});

test('"found but nothing read" is not the same as "never built"', () => {
  // Two different facts that both look like zero files.
  const report = indexReport({ generatedAt: now, fileCount: 40, indexedFileCount: 0 }, now);
  assert.equal(report.state, 'empty');
  assert.equal(report.files, '40 files found, none read');
  assert.notEqual(report.age, 'never built');
});

test('languages are ordered by how much of the project they are', () => {
  const report = indexReport(snapshot, now);
  assert.deepEqual(report.languages.map(entry => entry.language), ['TypeScript', 'Markdown', 'CSS']);
  assert.deepEqual(report.frameworks, ['React', 'esbuild']);
  assert.deepEqual(report.importantFiles, ['package.json', 'README.md']);
});

test('an index older than the rebuild window reads as stale', () => {
  const fresh = indexReport({ ...snapshot, generatedAt: now - INDEX_FRESH_MS + 1000 }, now);
  assert.equal(fresh.stale, false);
  const old = indexReport({ ...snapshot, generatedAt: now - INDEX_FRESH_MS - 1000 }, now);
  assert.equal(old.stale, true);
  // And the age is in words rather than a timestamp the reader has to convert.
  assert.match(indexReport({ ...snapshot, generatedAt: now - 3 * 60 * 60_000 }, now).age, /3 hours ago/);
});

test('malformed snapshot fields are ignored rather than rendered', () => {
  const report = indexReport({ languages: [{ language: 5 }, null], frameworks: [1, 'Vue'], importantFiles: 'nope' }, now);
  assert.deepEqual(report.languages, []);
  assert.deepEqual(report.frameworks, ['Vue']);
  assert.deepEqual(report.importantFiles, []);
});
test('the report says whether indexing is on at all', () => {
  // A read-only page that shows a healthy index while indexing is switched off
  // would be describing something the agent never consults.
  assert.equal(indexReport({ indexedFileCount: 3, fileCount: 9 }).enabled, true);
  assert.equal(indexReport({ indexedFileCount: 3, fileCount: 9 }, Date.now(), { enabled: false }).enabled, false);
  // …and a disabled index still reports what is on disk, so turning it back on
  // does not look like data loss.
  const disabled = indexReport({ indexedFileCount: 3, fileCount: 9 }, Date.now(), { enabled: false });
  assert.equal(disabled.state, 'ready');
  assert.match(disabled.files, /3 of 9 files read/);
  assert.equal(indexReport(undefined, Date.now(), { enabled: false }).files, 'Not built yet');
});
