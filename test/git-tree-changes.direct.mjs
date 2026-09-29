import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureGitTree, gitTreeChanges, restoreGitTree } from '../src/git.ts';

async function git(cwd, args) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
}

test('Git checkpoints record every turn change and restore modified, created, and deleted files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sleepycode-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', 'sleepycode@example.invalid']);
  await git(root, ['config', 'user.name', 'SleepyCode Test']);
  // Git defaults core.autocrlf to true on Windows, which would rewrite the
  // restored files with CRLF endings. Line-ending conversion is an
  // environment concern, not the behaviour under test, so pin it here the
  // same way the identity above is pinned.
  await git(root, ['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'modified.txt'), 'before\n');
  await writeFile(path.join(root, 'deleted.txt'), 'remove me\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base']);

  const before = await captureGitTree(root);
  await writeFile(path.join(root, 'modified.txt'), 'after\nmore\n');
  await writeFile(path.join(root, 'nested', 'created.txt'), 'new\n');
  await rm(path.join(root, 'deleted.txt'));
  const after = await captureGitTree(root);

  const changes = await gitTreeChanges(root, before, after);
  assert.deepEqual(changes.map(change => [change.path, change.action]), [
    ['deleted.txt', 'Deleted'],
    ['modified.txt', 'Modified'],
    ['nested/created.txt', 'Created'],
  ]);
  assert.equal(changes.find(change => change.path === 'modified.txt')?.additions, 2);
  assert.equal(changes.find(change => change.path === 'modified.txt')?.deletions, 1);

  await restoreGitTree(root, before);
  // Compare raw bytes, not decoded text: this proves the checkout restored the
  // file exactly, with no line-ending or BOM rewriting.
  assert.deepEqual(await readFile(path.join(root, 'modified.txt')), Buffer.from('before\n'));
  assert.deepEqual(await readFile(path.join(root, 'deleted.txt')), Buffer.from('remove me\n'));
  await assert.rejects(readFile(path.join(root, 'nested', 'created.txt'), 'utf8'));

  await restoreGitTree(root, after);
  assert.deepEqual(await readFile(path.join(root, 'modified.txt')), Buffer.from('after\nmore\n'));
  assert.deepEqual(await readFile(path.join(root, 'nested', 'created.txt')), Buffer.from('new\n'));
  await assert.rejects(readFile(path.join(root, 'deleted.txt'), 'utf8'));
});
