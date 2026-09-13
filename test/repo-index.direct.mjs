import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  RepoIndex,
  SourceCitedMemory,
  buildManifest,
  diffManifest,
  extractImports,
  extractSymbols,
  hashContent,
  scanWorkspace,
  tokenize,
} from '../src/repo-index.ts';

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

// --- scanWorkspace ---

test('scanWorkspace reads files and honors the ignore set', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-index-'));
  writeFileSync(path.join(root, 'keep.ts'), 'export const x = 1;');
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules', 'skip.ts'), 'ignored');
  const entries = scanWorkspace(root);
  const paths = entries.map(e => e.path);
  assert.ok(paths.includes('keep.ts'));
  assert.ok(!paths.some(p => p.includes('node_modules')));
});

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
