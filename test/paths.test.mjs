import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { realpathSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';

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
    assert.ok(result.startsWith(realpathSync(root) + path.sep));
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
    assert.ok(result.startsWith(realpathSync(root) + path.sep));
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

// The helper above is a local copy, which means these never exercised the shipped
// code. Import it here so a change to the real predicate is caught.
describe('the shipped pathInside and pathInsideLexical', () => {
  const load = async () => {
    const util = await import('../src/util.ts');
    return util;
  };

  it('keeps the symlink check on pathInside while memoizing the root', async () => {
    // Memoizing `realpath(root)` was the one change made to this predicate, and the
    // root is the half a symlink attack does not target. The candidate is still
    // resolved on every call, so an escaping link must still be refused.
    const { pathInside } = await load();
    const outside = path.join(tmpRoot, 'shipped-outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'target.txt'), 'secret');
    const link = path.join(workspace, 'shipped-escape-link');
    try { symlinkSync(path.join(outside, 'target.txt'), link, 'file'); } catch { }
    assert.equal(pathInside(workspace, path.join(workspace, 'src', 'file.ts')), true);
    assert.equal(pathInside(workspace, path.join(outside, 'target.txt')), false);
    assert.equal(pathInside(workspace, link), false, 'a symlink out of the root is still refused after the root is cached');
  });

  it('invalidating the root memo does not change the answer', async () => {
    const { pathInside, invalidateRealRoots } = await load();
    const target = path.join(workspace, 'src', 'file.ts');
    const before = pathInside(workspace, target);
    invalidateRealRoots();
    assert.equal(pathInside(workspace, target), before);
  });

  it('pathInsideLexical answers containment without touching the filesystem', async () => {
    // It exists only for display decisions (which file the composer's context chip
    // names), and it is deliberately blind to symlinks — so it must never be used
    // where the answer authorizes a read.
    const { pathInsideLexical } = await load();
    assert.equal(pathInsideLexical(workspace, path.join(workspace, 'src', 'file.ts')), true);
    assert.equal(pathInsideLexical(workspace, path.join(workspace, 'missing.ts')), true);
    assert.equal(pathInsideLexical(workspace, workspace), false);
    assert.equal(pathInsideLexical(workspace, path.join(tmpRoot, 'elsewhere.ts')), false);
    assert.equal(pathInsideLexical(workspace, workspace + '/src/../../escape.ts'), false);
  });

  it('pathInsideLexical is materially cheaper than pathInside', async () => {
    const { pathInside, pathInsideLexical } = await load();
    const target = path.join(workspace, 'src', 'file.ts');
    const time = (fn) => {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 5_000; i += 1) fn();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    pathInside(workspace, target);
    const withFs = time(() => pathInside(workspace, target));
    const withoutFs = time(() => pathInsideLexical(workspace, target));
    assert.ok(withoutFs < withFs, `lexical=${withoutFs.toFixed(1)}ms should beat filesystem=${withFs.toFixed(1)}ms`);
  });

  it('the editor-context sender only needs the lexical check', () => {
    // This runs on every debounced cursor move and every editor switch, where two
    // realpathSync calls are 5-20 ms each on a network home or a cloud File Provider
    // path. It decides a label, not an authorization.
    const agentSource = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
    const start = agentSource.indexOf('private sendEditorContext(): void {');
    assert.ok(start > 0, 'sendEditorContext exists');
    const body = agentSource.slice(start, agentSource.indexOf('private getEffectiveModelInfo', start));
    assert.match(body, /pathInsideLexical\(root\.fsPath, editorPath\)/, 'editor context uses the filesystem-free check');
    assert.doesNotMatch(body, /pathInside\(root\.fsPath, editorPath\)/, 'and no longer pays two realpathSync calls per cursor move');
  });
});
