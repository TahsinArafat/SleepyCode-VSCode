import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { realpathSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const tmpRoot = '/tmp/sleepycode-path-test-' + Date.now();
mkdirSync(tmpRoot, { recursive: true });
const workspace = path.join(tmpRoot, 'workspace');
mkdirSync(workspace, { recursive: true });
mkdirSync(path.join(workspace, 'src'), { recursive: true });
writeFileSync(path.join(workspace, 'src', 'file.ts'), 'export const x = 1;');

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { }
});

function pathInside(root, candidate) {
  const lexical = path.relative(root, candidate);
  if (lexical === '' || lexical === '..' || lexical.startsWith('..' + path.sep) || path.isAbsolute(lexical)) return false;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const resolved = path.relative(realRoot, realCandidate);
    return resolved !== '' && resolved !== '..' && !resolved.startsWith('..' + path.sep) && !path.isAbsolute(resolved);
  } catch {
    return true;
  }
}

function resolvePathSafe(root, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('Path must stay inside the workspace.');
  }

  const realRoot = realpathSync(root);
  const candidate = path.join(realRoot, normalized);
  let checkPath = candidate;

  while (true) {
    try {
      const real = realpathSync(checkPath);
      if (real === realRoot || real.startsWith(realRoot + path.sep)) return candidate;
      throw new Error('Path escapes the workspace.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(checkPath);
      if (parent === checkPath) throw new Error('Path escapes the workspace.');
      checkPath = parent;
    }
  }
}

describe('pathInside', () => {
  it('returns true for paths inside root', () => {
    assert.equal(pathInside('/workspace', '/workspace/src/file.ts'), true);
  });

  it('returns false for paths outside root', () => {
    assert.equal(pathInside('/workspace', '/other/file.ts'), false);
  });

  it('returns false for root itself', () => {
    assert.equal(pathInside('/workspace', '/workspace'), false);
  });

  it('rejects an existing symlink that resolves outside root', () => {
    const outside = path.join(tmpRoot, 'outside-path-inside');
    mkdirSync(outside, { recursive: true });
    const link = path.join(workspace, 'outside-file-link');
    writeFileSync(path.join(outside, 'file.txt'), 'outside');
    symlinkSync(path.join(outside, 'file.txt'), link, 'file');
    assert.equal(pathInside(workspace, link), false);
  });
});

describe('resolvePathSafe', () => {
  const root = workspace;

  it('resolves a normal relative path', () => {
    const result = resolvePathSafe(root, 'src/file.ts');
    assert.ok(result.startsWith(root + '/'));
  });

  it('rejects absolute paths', () => {
    assert.throws(() => resolvePathSafe(root, '/etc/passwd'), /Path must stay inside/);
  });

  it('rejects paths with ..', () => {
    assert.throws(() => resolvePathSafe(root, '../etc/passwd'), /Path must stay inside/);
  });

  it('rejects empty paths', () => {
    assert.throws(() => resolvePathSafe(root, ''), /Path must stay inside/);
  });

  it('handles Windows-style paths', () => {
    const result = resolvePathSafe(root, 'src\\file.ts');
    assert.ok(result.startsWith(root + '/'));
  });

  it('allows a deeply nested path that does not exist yet', () => {
    const result = resolvePathSafe(root, 'new/deep/file.ts');
    assert.equal(result, path.join(realpathSync(root), 'new', 'deep', 'file.ts'));
  });

  it('rejects an existing symlink that resolves outside the workspace', () => {
    const outside = path.join(tmpRoot, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const link = path.join(root, 'outside-link');
    symlinkSync(outside, link, 'dir');
    assert.throws(() => resolvePathSafe(root, 'outside-link/secret.txt'), /Path escapes the workspace/);
  });

});
