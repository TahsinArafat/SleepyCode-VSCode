import test from 'node:test';
import assert from 'node:assert/strict';

const plan = await import('../src/plan-file.ts');

test('a plan is written under the project plans folder', () => {
  assert.equal(plan.planRelativePath('Add auth'), '.sleepycode/plans/add-auth.md');
});

test('a title becomes a safe file name', () => {
  const path = plan.planRelativePath('Fix: the/parser "bug"?');
  assert.match(path, /^\.sleepycode\/plans\//);
  assert.ok(!/[\\:*?"<>|]/.test(path), `unsafe characters in ${path}`);
});

test('a title made only of symbols still produces a usable name', () => {
  assert.equal(plan.planRelativePath('///'), '.sleepycode/plans/plan.md');
  assert.equal(plan.planRelativePath(''), '.sleepycode/plans/plan.md');
});

test('a long title is bounded', () => {
  const path = plan.planRelativePath('a'.repeat(400));
  assert.ok(path.length <= 100, `too long: ${path.length}`);
});

test('a plan path can never escape the plans folder', () => {
  // The tool chooses the path from a title, so traversal must be impossible.
  for (const title of ['../../etc/passwd', '..\\..\\windows', 'a/../../b', '/abs/path']) {
    const path = plan.planRelativePath(title);
    assert.ok(path.startsWith('.sleepycode/plans/'), `${title} -> ${path}`);
    assert.ok(!path.includes('..'), `${title} -> ${path}`);
  }
});

test('plans are markdown with a title heading', () => {
  const doc = plan.planDocument('Add auth', '## Steps\n\n1. Do it');
  assert.match(doc, /^# Add auth/m);
  assert.match(doc, /## Steps/);
});

test('a plan document records when it was written', () => {
  const doc = plan.planDocument('T', 'body');
  assert.match(doc, /_Written \d{4}-\d{2}-\d{2}/);
});

test('a title-less plan still gets a heading', () => {
  assert.match(plan.planDocument('', 'body'), /^# Plan/m);
});
