import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function sanitizeSkillName(name) {
  const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
  let safe = (name || 'skill')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (WINDOWS_RESERVED_NAME.test(safe)) safe = `${safe}-skill`;
  return safe || 'skill';
}

function resolveInstallPath(source, skill, branch) {
  let value = source.trim().replace(/\/+$/, '');
  value = value.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  const parts = value.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid GitHub reference '${source}'. Use 'owner/repo' or a github.com URL.`);
  const [owner, repo, third, fourth, ...rest] = parts;
  if (!owner || !repo) throw new Error(`Invalid GitHub reference '${source}'.`);
  let outBranch = 'main';
  let folderPath = '';
  if (third === 'tree' || third === 'blob') {
    outBranch = fourth || 'main';
    folderPath = rest.join('/');
  } else if (third && parts.length >= 4) {
    outBranch = third;
    folderPath = parts.slice(3).join('/');
  }
  return {
    owner,
    repo,
    branch: branch || outBranch || 'main',
    folderPath: folderPath || undefined,
    hintedName: skill || (folderPath ? sanitizeSkillName(folderPath.split('/').pop() ?? 'skill') : undefined),
  };
}

describe('sanitizeSkillName', () => {
  it('converts to lowercase and removes special chars', () => {
    assert.equal(sanitizeSkillName('Hello World!'), 'hello-world');
  });

  it('handles windows reserved names', () => {
    assert.ok(sanitizeSkillName('con').startsWith('con-'));
    assert.ok(sanitizeSkillName('nul').startsWith('nul-'));
  });

  it('returns skill for empty input', () => {
    assert.equal(sanitizeSkillName(''), 'skill');
  });
});

describe('resolveInstallPath', () => {
  it('parses owner/repo format', () => {
    const result = resolveInstallPath('owner/repo', 'skill-name', 'main');
    assert.equal(result.owner, 'owner');
    assert.equal(result.repo, 'repo');
    assert.equal(result.branch, 'main');
  });

  it('parses github URL format', () => {
    const result = resolveInstallPath('https://github.com/owner/repo/tree/main/skills/my-skill', '', 'main');
    assert.equal(result.owner, 'owner');
    assert.equal(result.repo, 'repo');
    assert.equal(result.branch, 'main');
    assert.equal(result.folderPath, 'skills/my-skill');
  });

  it('rejects invalid references', () => {
    assert.throws(() => resolveInstallPath('invalid', '', 'main'), /Invalid GitHub reference/);
  });
});
