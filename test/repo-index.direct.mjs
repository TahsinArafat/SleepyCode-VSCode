import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  RepoIndex,
  SCAN_MAX_ENTRY_BYTES,
  SCAN_MAX_FILES,
  SCAN_MAX_TOTAL_BYTES,
  SourceCitedMemory,
  buildManifest,
  diffManifest,
  extractImports,
  extractSymbols,
  hashContent,
  scanWorkspace,
  tokenize,
} from '../src/repo-index.ts';
import { RepoIndexService } from '../src/repo-index-service.ts';

// --- hashContent / manifest ---

test('hashContent is stable and content-sensitive', () => {
  assert.equal(hashContent('abc'), hashContent('abc'));
  assert.notEqual(hashContent('abc'), hashContent('abd'));
  assert.match(hashContent('abc'), /^[0-9a-f]{8}$/);
});

test('buildManifest and diffManifest detect added/changed/removed/unchanged', () => {
  const prev = buildManifest([{ path: 'a.ts', content: 'one' }, { path: 'b.ts', content: 'two' }]);
  const next = buildManifest([{ path: 'a.ts', content: 'one' }, { path: 'b.ts', content: 'changed' }, { path: 'c.ts', content: 'new' }]);
  const diff = diffManifest(prev, next);
  assert.deepEqual(diff.unchanged, ['a.ts']);
  assert.deepEqual(diff.changed, ['b.ts']);
  assert.deepEqual(diff.added, ['c.ts']);
  assert.deepEqual(diff.removed, []);
});

// --- tokenize ---

test('tokenize drops stopwords and short tokens', () => {
  assert.deepEqual(tokenize('The quick and the fox'), ['quick', 'fox']);
});

// --- extractSymbols / extractImports ---

test('extractSymbols finds functions, classes, interfaces, and types', () => {
  const src = 'export function alpha() {}\nclass Beta {}\ninterface Gamma {}\ntype Delta = number;\nconst epsilon = 1;';
  const symbols = extractSymbols(src, 'x.ts');
  const names = symbols.map(s => s.name);
  assert.ok(names.includes('alpha'));
  assert.ok(names.includes('Beta'));
  assert.ok(names.includes('Gamma'));
  assert.ok(names.includes('Delta'));
  assert.ok(names.includes('epsilon'));
  assert.equal(symbols.find(s => s.name === 'Beta').kind, 'class');
});

test('extractImports captures import, require, and re-export specifiers', () => {
  const src = "import a from './a';\nconst b = require('./b');\nexport { c } from './c';";
  assert.deepEqual(extractImports(src).sort(), ['./a', './b', './c']);
});

// --- RepoIndex ---

test('tokenize splits camelCase and snake_case into sub-tokens', () => {
  assert.deepEqual(tokenize('authenticateCredentials'), ['authenticate', 'credentials']);
  assert.deepEqual(tokenize('snake_case_name'), ['snake', 'case', 'name']);
});

test('RepoIndex semantic search ranks the most relevant file first', () => {
  const index = new RepoIndex([
    { path: 'auth.ts', content: 'function loginUser() { return authenticateCredentials(); }' },
    { path: 'styles.css', content: 'body { color: red; }' },
  ]);
  const results = index.semanticSearch('authenticate credentials login', 2);
  assert.equal(results[0].path, 'auth.ts');
  assert.ok(results[0].score > 0);
});

test('RepoIndex symbol search matches by name prefix', () => {
  const index = new RepoIndex([{ path: 'x.ts', content: 'function fetchUser() {} function fetchOrders() {}' }]);
  index.indexSymbols();
  const results = index.symbolSearch('fetch', 5);
  assert.deepEqual(results.map(s => s.name).sort(), ['fetchOrders', 'fetchUser']);
});

test('RepoIndex architectureMap links relative imports and package nodes', () => {
  const index = new RepoIndex([
    { path: 'a.ts', content: "import { b } from './b';\nimport fs from 'node:fs';" },
    { path: 'b.ts', content: 'export const b = 1;' },
  ]);
  const map = index.architectureMap();
  assert.ok(map.edges.some(e => e.from === 'a.ts' && e.to === 'b.ts'));
  assert.ok(map.nodes.some(n => n.kind === 'package' && n.label === 'node:fs'));
});

test('RepoIndex upsert and remove update the file set', () => {
  const index = new RepoIndex([{ path: 'a.ts', content: 'one' }]);
  index.upsert({ path: 'a.ts', content: 'two' });
  assert.equal(index.files.length, 1);
  index.upsert({ path: 'b.ts', content: 'three' });
  assert.equal(index.files.length, 2);
  index.remove('a.ts');
  assert.deepEqual(index.files.map(f => f.path), ['b.ts']);
});

test('a repeated symbol read is served from the index instead of re-extracted', () => {
  // Extracting symbols over a whole workspace is expensive (measured ~3.5 s and ~120 MB on
  // 4,000 files). The `repo_symbol` tool called this per invocation, so two symbol questions
  // paid for two full extractions. Identity is the signal: a rebuild always makes a new array.
  const index = new RepoIndex([
    { path: 'a.ts', content: 'export function alpha() {}\nexport class Beta {}\n' },
    { path: 'b.ts', content: 'export interface Gamma {}\n' },
  ]);
  const first = index.indexSymbols();
  const second = index.indexSymbols();
  assert.equal(first, second, 'the second read must reuse the first result');
  assert.deepEqual(first.map(s => s.name).sort(), ['Beta', 'Gamma', 'alpha']);
});

test('a symbol read after an edit re-extracts, so the index cannot go stale', () => {
  // Memoizing must not survive a write, or `repo_symbol` would answer from pre-edit source.
  const index = new RepoIndex([{ path: 'a.ts', content: 'export function before() {}\n' }]);
  assert.deepEqual(index.indexSymbols().map(s => s.name), ['before']);
  index.upsert({ path: 'a.ts', content: 'export function after() {}\n' });
  assert.deepEqual(index.indexSymbols().map(s => s.name), ['after']);
  index.remove('a.ts');
  assert.deepEqual(index.indexSymbols(), [], 'a removed file contributes no symbols');
});

test('upsert replaces in place rather than copying the whole file list', () => {
  // The old implementation ran `entries.filter(...)` on every upsert, which is O(files) for a
  // single-file save. The array is mutated, not replaced, so a burst of saves is not
  // quadratic in workspace size.
  const index = new RepoIndex([{ path: 'a.ts', content: 'a' }, { path: 'b.ts', content: 'b' }]);
  const before = index.files;
  index.upsert({ path: 'a.ts', content: 'changed' });
  assert.equal(index.files, before, 'the array must be mutated in place');
  assert.equal(index.files.length, 2);
  assert.equal(index.files.find(f => f.path === 'a.ts').content, 'changed');
});

test('symbolCount answers without the caller materializing the list', () => {
  // The index panel printed a count; it used to call indexSymbols() for that alone.
  const index = new RepoIndex([{ path: 'a.ts', content: 'export function one() {}\nexport const two = 1;\n' }]);
  assert.equal(index.symbolCount(), index.indexSymbols().length);
  assert.equal(index.symbolCount(), index.indexSymbols().length, 'counting twice stays consistent');
});

// --- scanWorkspace ---

test('scanWorkspace reads files and honors the ignore set', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-index-'));
  writeFileSync(path.join(root, 'keep.ts'), 'export const x = 1;');
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules', 'skip.ts'), 'ignored');
  const entries = await scanWorkspace(root);
  const paths = entries.map(e => e.path);
  assert.ok(paths.includes('keep.ts'));
  assert.ok(!paths.some(p => p.includes('node_modules')));
});

test('scanWorkspace stops at the file cap', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-index-cap-'));
  for (let i = 0; i < 5; i++) writeFileSync(path.join(root, `f${i}.ts`), `export const x${i} = ${i};`);
  const entries = await scanWorkspace(root, new Set(), 250_000, 2);
  assert.equal(entries.length, 2, 'the walk must stop at the file cap');
  const uncapped = await scanWorkspace(root);
  assert.equal(uncapped.length, 5, 'without a cap every file is indexed');
});

test('upsert enforces the file-count cap and keeps recently written entries', () => {
  const index = new RepoIndex();
  for (let i = 0; i < SCAN_MAX_FILES + 2; i++) index.upsert({ path: `f${i}.ts`, content: 'x' });
  assert.equal(index.files.length, SCAN_MAX_FILES);
  assert.equal(index.files.some(file => file.path === 'f0.ts'), false);
  assert.equal(index.files.some(file => file.path === `f${SCAN_MAX_FILES + 1}.ts`), true);
});

test('upsert enforces aggregate and per-file byte caps', () => {
  const index = new RepoIndex();
  const body = 'x'.repeat(SCAN_MAX_ENTRY_BYTES);
  for (let i = 0; i < 130; i++) index.upsert({ path: `f${i}.ts`, content: body });
  assert.ok(index.contentBytes <= SCAN_MAX_TOTAL_BYTES);
  assert.ok(index.files.every(file => Buffer.byteLength(file.content, 'utf8') <= SCAN_MAX_ENTRY_BYTES));
  index.upsert({ path: 'too-large.ts', content: 'x'.repeat(SCAN_MAX_ENTRY_BYTES + 1) });
  assert.equal(index.files.some(file => file.path === 'too-large.ts'), false);
});

test('watcher refresh honors aggregate caps and concurrent loads share one index', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-index-service-'));
  writeFileSync(path.join(root, 'seed.ts'), 'export const seed = 1;');
  const service = new RepoIndexService();
  const uri = { fsPath: root };
  const [first, second, third] = await Promise.all([service.load(uri), service.load(uri), service.load(uri)]);
  assert.equal(first, second);
  assert.equal(second, third);
  const body = 'x'.repeat(SCAN_MAX_ENTRY_BYTES);
  for (let i = 0; i < 130; i++) {
    const relative = `f${i}.ts`;
    const absolute = path.join(root, relative);
    writeFileSync(absolute, body);
    service.refreshEntry(uri, relative, uriFor(absolute));
  }
  assert.ok(first.contentBytes <= SCAN_MAX_TOTAL_BYTES);
  service.dispose();
  assert.equal(service.fileCount, 0);
});

function uriFor(fsPath) {
  return { fsPath };
}

// --- SourceCitedMemory ---

test('SourceCitedMemory invalidates facts when the source hash changes', () => {
  const memory = new SourceCitedMemory();
  const fact = memory.record({ text: 'x is defined here', source: 'a.ts', sourceHash: 'hash1' });
  const invalidated = memory.invalidate([{ path: 'a.ts', hash: 'hash2' }]);
  assert.equal(invalidated, 1);
  assert.equal(fact.valid, false);
  assert.equal(memory.pruneInvalid(), 1);
  assert.equal(memory.all.length, 0);
});

test('SourceCitedMemory round-trips through JSON', () => {
  const memory = new SourceCitedMemory();
  memory.record({ text: 'note', source: 'b.ts', sourceHash: 'h' });
  const restored = new SourceCitedMemory();
  restored.load(memory.toJSON());
  assert.equal(restored.all.length, 1);
  assert.equal(restored.all[0].text, 'note');
});
