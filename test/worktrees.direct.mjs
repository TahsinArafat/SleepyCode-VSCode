import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { WORKTREE_ROOT, WorktreeError, worktreeDir } from '../src/worktrees.ts';

test('WORKTREE_ROOT lives under .sleepycode', () => {
  assert.equal(WORKTREE_ROOT, '.sleepycode/worktrees');
});

test('worktreeDir sanitizes names and stays under the worktree root', () => {
  const dir = worktreeDir('/repo', 'My Feature!!');
  assert.ok(dir.includes(path.join('.sleepycode', 'worktrees')));
  assert.ok(dir.endsWith(path.join('worktrees', 'My-Feature')));
});

test('worktreeDir rejects a name that sanitizes to empty', () => {
  assert.throws(() => worktreeDir('/repo', '///'), (error) => error instanceof WorktreeError && error.code === 'bad_name');
});

test('WorktreeError carries a code', () => {
  const error = new WorktreeError('nope', 'not_found');
  assert.equal(error.name, 'WorktreeError');
  assert.equal(error.code, 'not_found');
});
