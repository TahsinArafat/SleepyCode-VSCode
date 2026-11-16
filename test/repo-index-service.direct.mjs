import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { RepoIndexService } from '../src/repo-index-service.ts';

/** A throwaway workspace with `n` files, so "released" is a real count and not zero-because-missing. */
function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sleepy-index-service-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/**
 * `RepoIndexService` exists to give the workspace index a lifetime it can be dropped
 * from. These drive the lifetime seams directly -- the index is the largest retainer
 * in the extension, and "nobody owns this field" is what let it stay resident.
 *
 * The `vscode.Uri` argument is structural: only `fsPath` is read, so a plain object is
 * enough and no VS Code host is needed.
 */
const root = path => ({ fsPath: path });

test('an index is built once per root and reused', async () => {
  const service = new RepoIndexService();
  const dir = fixture({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
  const index = await service.load(root(dir));
  assert.equal(index.files.length, 2, 'a real scan sees the files');
  // Identity is the contract: a second load returns the same object, i.e. it did not rescan.
  assert.equal(await service.load(root(dir)), index, 'the same root reuses the same index');
  assert.equal(service.fileCount, 2);
});

test('a different root never serves the previous workspace index', async () => {
  const service = new RepoIndexService();
  const a = fixture({ 'a.ts': 'export const a = 1;\n' });
  const b = fixture({ 'b1.ts': 'export const b1 = 1;\n', 'b2.ts': 'export const b2 = 2;\n' });
  const first = await service.load(root(a));
  const second = await service.load(root(b));
  assert.notEqual(second, first, 'a second root must build its own index');
  assert.equal(first.files.length, 1);
  assert.equal(second.files.length, 2, 'the new workspace is indexed from its own tree');
  assert.equal(service.indexFor(root(a)), undefined, 'the previous root is no longer cached');
  assert.equal(service.indexFor(root(b)), second, 'the current root is cached');
});

test('dispose releases the index and a later load rebuilds it', async () => {
  const service = new RepoIndexService();
  const dir = fixture({ 'a.ts': 'export const a = 1;\n', 'nested/b.ts': 'export const b = 2;\n' });
  const built = await service.load(root(dir));
  assert.equal(service.fileCount, 2, 'precondition: a real tree is resident');
  service.dispose();
  assert.equal(service.fileCount, 0, 'dispose drops the tree');
  assert.equal(service.indexFor(root(dir)), undefined, 'nothing is cached after dispose');
  const again = await service.load(root(dir));
  assert.equal(again.files.length, 2, 'a load after dispose rescans');
  assert.notEqual(again, built, 'a load after dispose builds a fresh index rather than resurrecting the old one');
});

test('indexFor never triggers a scan, so a cache miss stays cheap', () => {
  const service = new RepoIndexService();
  // Diagnostics and searches read this on a hot path; if it built an index, asking
  // whether one exists would cost a full workspace walk.
  assert.equal(service.indexFor(root('/tmp/workspace-a')), undefined);
  assert.equal(service.fileCount, 0);
});

test('a refresh for a root that is not indexed is a no-op', () => {
  const service = new RepoIndexService();
  const dir = fixture({ 'a.ts': 'export const a = 1;\n' });
  // The watcher keeps firing for whatever workspace is open. It must not resurrect an
  // index that was deliberately released.
  assert.doesNotThrow(() => service.refreshEntry(root(dir), 'a.ts', root(path.join(dir, 'a.ts'))));
  assert.equal(service.fileCount, 0, 'a released index stays released');
});

test('a refresh re-reads an edited file and drops a removed one', async () => {
  const service = new RepoIndexService();
  const dir = fixture({ 'a.ts': 'export const a = 1;\n' });
  await service.load(root(dir));
  const file = path.join(dir, 'a.ts');
  writeFileSync(file, 'export const a = 99;\n');
  service.refreshEntry(root(dir), 'a.ts', root(file));
  const entry = service.indexFor(root(dir)).files.find(item => item.path === 'a.ts');
  assert.match(entry.content, /99/, 'the index holds the edited text, not the pre-edit text');
  service.refreshEntry(root(dir), 'a.ts', root(path.join(dir, 'gone.ts')));
  assert.equal(service.indexFor(root(dir)).files.some(item => item.path === 'a.ts'), false, 'an unreadable file is dropped');
});
