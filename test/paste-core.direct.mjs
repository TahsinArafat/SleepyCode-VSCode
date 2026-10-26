import test from 'node:test';
import assert from 'node:assert/strict';

const paste = await import('../src/paste-core.ts');

// Pasting code into the composer asks the host to locate the source. With no
// answer the paste was swallowed: nothing was inserted at all. These pin the
// search-line choice, which decides whether a location can be found.

test('the most distinctive line is chosen for the search', () => {
  const text = [
    'function add(a, b) {',
    '  return a + b;',
    '}',
  ].join('\n');
  const line = paste.pastedCodeSearchLine(text);
  // 'function add(a, b) {' is more distinctive than 'return a + b;'.
  assert.match(line, /add/);
});

test('indentation and blank lines are ignored', () => {
  const line = paste.pastedCodeSearchLine('\n\n    const identifier = computeSomething();\n\n');
  assert.equal(line, 'const identifier = computeSomething();');
});

test('a line too short or too generic is not used', () => {
  // Searching for '}' or 'return x;' would match hundreds of files.
  assert.equal(paste.pastedCodeSearchLine('}\n  }\n}'), undefined);
  assert.equal(paste.pastedCodeSearchLine('x'), undefined);
  assert.equal(paste.pastedCodeSearchLine(''), undefined);
});

test('a single-line paste is still searchable when distinctive', () => {
  assert.equal(paste.pastedCodeSearchLine('const uniqueThing = makeWidgetFactory();'), 'const uniqueThing = makeWidgetFactory();');
});

test('a located match becomes a code mention', () => {
  const mention = paste.toCodeMention({ path: 'src/math.ts', line: 12 });
  assert.equal(mention.kind, 'code');
  assert.equal(mention.path, 'src/math.ts');
  assert.equal(mention.name, 'math.ts');
  assert.match(mention.detail, /12/);
});

test('no match means no mention, so the caller falls back to plain text', () => {
  assert.equal(paste.toCodeMention(undefined), undefined);
  assert.equal(paste.toCodeMention(null), undefined);
});
