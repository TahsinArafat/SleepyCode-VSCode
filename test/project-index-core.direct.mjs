import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFrameworks,
  extractImports,
  extractSymbols,
  languageForPath,
  retrieveProjectContext,
} from '../src/project-index-core.ts';

test('project index core detects language, symbols, imports, and frameworks from production code', () => {
  assert.equal(languageForPath('src/auth/session.ts'), 'TypeScript');
  const source = `import { verify } from './token';\nexport class SessionStore {}\nexport async function refreshSession() { return verify(); }`;
  const symbols = extractSymbols(source, 'TypeScript');
  assert.ok(symbols.includes('SessionStore'));
  assert.ok(symbols.includes('refreshSession'));
  assert.ok(extractImports(source, 'TypeScript').includes('./token'));
  assert.deepEqual(new Set(detectFrameworks({ dependencies: { next: '1', react: '1', '@prisma/client': '1' }, devDependencies: { vitest: '1' } })), new Set(['Next.js', 'Prisma', 'React', 'Vitest']));
});

test('project context retrieval ranks relevant paths and symbols', () => {
  const index = {
    version: 1,
    root: '/repo',
    generatedAt: Date.now(),
    fileCount: 3,
    indexedFileCount: 3,
    languages: [{ language: 'TypeScript', files: 3 }],
    frameworks: ['Next.js'],
    importantFiles: ['package.json'],
    files: [
      { path: 'src/auth/session.ts', language: 'TypeScript', size: 200, symbols: ['refreshSession', 'SessionStore'], imports: ['./token'], testLike: false },
      { path: 'src/auth/session.test.ts', language: 'TypeScript', size: 180, symbols: ['session expiry'], imports: ['./session'], testLike: true },
      { path: 'src/payments/checkout.ts', language: 'TypeScript', size: 220, symbols: ['checkout'], imports: [], testLike: false },
    ],
  };
  const hits = retrieveProjectContext(index, 'fix auth session refresh expiry', 3);
  assert.ok(['src/auth/session.ts', 'src/auth/session.test.ts'].includes(hits[0]?.path));
  assert.ok(hits.some(hit => hit.path === 'src/auth/session.ts'));
  assert.ok(hits.some(hit => hit.path === 'src/auth/session.test.ts'));
  assert.ok(!hits.some(hit => hit.path === 'src/payments/checkout.ts'));
  assert.ok(hits.every(hit => hit.score > 0));
});
