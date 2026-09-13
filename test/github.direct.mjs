import test from 'node:test';
import assert from 'node:assert/strict';
import {
  branchForIssue,
  buildPrBody,
  parseChecks,
  parseIssues,
  parseReviewComments,
  slugify,
} from '../src/github.ts';

test('slugify lowercases, strips punctuation, and caps length', () => {
  assert.equal(slugify('Fix: Login Bug!'), 'fix-login-bug');
  assert.equal(slugify('   '), 'task');
  assert.ok(slugify('x'.repeat(100)).length <= 40);
});

test('branchForIssue composes fix/<number>-<slug>', () => {
  assert.equal(branchForIssue(42, 'Crash on startup'), 'fix/42-crash-on-startup');
});

test('parseIssues maps gh JSON into issue objects', () => {
  const json = JSON.stringify([
    { number: 7, title: 'T', body: 'B', state: 'OPEN', labels: [{ name: 'bug' }, 'help wanted'], url: 'u', assignees: [{ login: 'octo' }] },
  ]);
  const issues = parseIssues(json);
  assert.equal(issues[0].number, 7);
  assert.deepEqual(issues[0].labels, ['bug', 'help wanted']);
  assert.deepEqual(issues[0].assignees, ['octo']);
});

test('parseIssues tolerates a non-array payload', () => {
  assert.deepEqual(parseIssues('{}'), []);
});

test('parseChecks reads tab-separated gh pr checks output', () => {
  const checks = parseChecks('build\tcompleted\tsuccess\thttps://x\nlint\tin_progress\t\t');
  assert.equal(checks.length, 2);
  assert.equal(checks[0].name, 'build');
  assert.equal(checks[0].conclusion, 'success');
  assert.equal(checks[1].status, 'in_progress');
});

test('parseReviewComments maps gh api payload', () => {
  const comments = parseReviewComments(JSON.stringify([
    { id: 1, user: { login: 'rev' }, body: 'nit', path: 'a.ts', line: 3, state: 'COMMENTED', html_url: 'u' },
  ]));
  assert.equal(comments[0].author, 'rev');
  assert.equal(comments[0].path, 'a.ts');
  assert.equal(comments[0].line, 3);
});

test('buildPrBody includes the summary, closing reference, and checklist', () => {
  const body = buildPrBody(9, 'Fixes the thing', ['tests pass', 'docs updated']);
  assert.match(body, /## Summary/);
  assert.match(body, /Fixes the thing/);
  assert.match(body, /Closes #9/);
  assert.match(body, /- \[ \] tests pass/);
});
