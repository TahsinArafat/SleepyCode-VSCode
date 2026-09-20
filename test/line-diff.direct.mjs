import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactLinePreview, countLines, diffLines, fileChangeStats, splitLines } from '../src/line-diff.ts';

test('splitLines ignores a trailing newline', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('one'), ['one']);
  assert.deepEqual(splitLines('one\n'), ['one']);
  assert.deepEqual(splitLines('one\ntwo\n'), ['one', 'two']);
  assert.equal(countLines('one\ntwo\n'), 2);
});

test('creating a file counts every line as plus', () => {
  const diff = fileChangeStats('', 'alpha\nbeta\n');
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 0);
  assert.deepEqual(diff.preview.map(line => line.kind), ['add', 'add']);
});

test('deleting a file counts every line as minus', () => {
  const diff = fileChangeStats('alpha\nbeta\ngamma\n', '');
  assert.equal(diff.additions, 0);
  assert.equal(diff.deletions, 3);
  assert.deepEqual(diff.preview.map(line => line.kind), ['del', 'del', 'del']);
});

test('modifying a file counts inserted and removed lines', () => {
  const before = ['keep', 'old', 'tail'].join('\n');
  const after = ['keep', 'new', 'extra', 'tail'].join('\n');
  const diff = diffLines(before, after);
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 1);
  assert.deepEqual(diff.lines.map(line => `${line.kind}:${line.text}`), [
    'ctx:keep',
    'del:old',
    'add:new',
    'add:extra',
    'ctx:tail',
  ]);
});

test('identical text produces no plus or minus', () => {
  const diff = fileChangeStats('same\n', 'same\n');
  assert.equal(diff.additions, 0);
  assert.equal(diff.deletions, 0);
  assert.deepEqual(diff.preview, []);
});

test('compact preview keeps nearby context and truncates long hunks', () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
  const after = before.replace('line 10', 'changed 10').replace('line 30', 'changed 30');
  const preview = compactLinePreview(diffLines(before, after).lines, 6, 1);
  assert.ok(preview.some(line => line.kind === 'meta'));
  assert.ok(preview.some(line => line.kind === 'add' && line.text.includes('changed 10')));
  assert.ok(preview.length <= 7);
});
