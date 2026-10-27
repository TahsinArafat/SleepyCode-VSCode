import test from 'node:test';
import assert from 'node:assert/strict';
import * as identity from '../src/skill-identity.ts';

/*
 * Two vendors routinely publish a skill under the same name. Identity used to be
 * the name alone, so a repository listing kept one `review` and dropped the rest,
 * the installer wrote both into the same folder, and asking for `review` resolved
 * to whichever sorted first. Nothing about that was visible in the UI.
 */

const acme = { owner: 'acme', repo: 'skills', name: 'review' };
const other = { owner: 'other', repo: 'agent-skills', name: 'review' };

test('a skill key names its vendor as well as the skill', () => {
  assert.equal(identity.skillKey(acme), 'acme/skills:review');
  assert.equal(identity.skillKey(other), 'other/agent-skills:review');
  // Different vendors, different keys — the whole point.
  assert.notEqual(identity.skillKey(acme), identity.skillKey(other));
  // Names that are not already slugs are normalised, not rejected.
  assert.equal(identity.skillKey({ owner: 'Acme Corp', repo: 'My Skills', name: 'Code Review' }), 'acme-corp/my-skills:code-review');
});

test('a key survives a round trip', () => {
  const parsed = identity.parseSkillKey('acme/skills:review');
  assert.deepEqual(parsed, { owner: 'acme', repo: 'skills', name: 'review' });
  assert.equal(identity.parseSkillKey('review'), undefined);
  assert.equal(identity.parseSkillKey(undefined), undefined);
});

test('two vendors of the same skill get different folders', () => {
  assert.equal(identity.skillFolderName(acme), 'review--acme--skills');
  assert.equal(identity.skillFolderName(other), 'review--other--agent-skills');
  assert.notEqual(identity.skillFolderName(acme), identity.skillFolderName(other));
  // Still reads as the skill it holds, and stays one safe path segment.
  assert.match(identity.skillFolderName(acme), /^[a-z0-9-]+$/);
});

test('the display name stays the plain skill name', () => {
  // `/skill review` and the model's inventory read names, not vendors.
  assert.equal(identity.skillDisplayName('review--acme--skills'), 'review');
  assert.equal(identity.skillDisplayName('review--acme--skills', 'Code Review'), 'Code Review');
  assert.equal(identity.skillDisplayName('plain'), 'plain');
});

test('a folder or key resolves exactly, without asking', () => {
  const installed = [
    { folder: 'review--acme--skills', name: 'review', key: 'acme/skills:review' },
    { folder: 'review--other--agent-skills', name: 'review', key: 'other/agent-skills:review' },
  ];
  assert.equal(identity.findSkill(installed, 'review--acme--skills').skill?.key, 'acme/skills:review');
  assert.equal(identity.findSkill(installed, 'acme/skills:review').skill?.key, 'acme/skills:review');
  // Case is not identity, but it is not a reason to fail either.
  assert.equal(identity.findSkill(installed, 'ACME/Skills:Review').skill?.key, 'acme/skills:review');
});

test('a plain name both vendors answer to is reported, never guessed', () => {
  const installed = [
    { folder: 'review--acme--skills', name: 'review', key: 'acme/skills:review' },
    { folder: 'review--other--agent-skills', name: 'review', key: 'other/agent-skills:review' },
  ];
  const found = identity.findSkill(installed, 'review');
  assert.equal(found.kind, 'ambiguous');
  assert.equal(found.candidates.length, 2);
  // And the message says which two, so the choice is actionable.
  const message = identity.ambiguousSkillMessage('review', found.candidates);
  assert.match(message, /acme\/skills:review/);
  assert.match(message, /other\/agent-skills:review/);
});

test('a name only one vendor publishes still resolves', () => {
  const installed = [{ folder: 'docs--acme--skills', name: 'docs', key: 'acme/skills:docs' }];
  const found = identity.findSkill(installed, 'docs');
  assert.equal(found.kind, 'found');
  assert.equal(found.skill.key, 'acme/skills:docs');
  assert.equal(identity.findSkill(installed, 'nope').kind, 'missing');
  assert.equal(identity.findSkill(installed, '  ').kind, 'missing');
});
test('the install folder alone recovers which vendor a skill came from', () => {
  // No side table to drift: the identity is in the folder name.
  assert.deepEqual(identity.parseFolderName('review--acme--skills'), { name: 'review', key: 'acme/skills:review' });
  assert.deepEqual(identity.parseFolderName('docs--acme--my-skills'), { name: 'docs', key: 'acme/my-skills:docs' });
  // A skill installed before namespacing has no vendor, and must still resolve.
  assert.deepEqual(identity.parseFolderName('plain'), { name: 'plain' });
});
