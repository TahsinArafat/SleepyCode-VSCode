import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSource,
  matchesSource,
  stripPatternWhitespace,
  stripSourceWhitespace,
} from './source-assert.mjs';

test('matches minified source against a reformatted pattern', () => {
  assert.ok(matchesSource('case\'subagent\':{', /case'subagent':\{/));
  assert.ok(matchesSource("case 'subagent': {", /case'subagent':\{/));
  assert.ok(matchesSource("const parentId = m.parentId;", /const parentId=m\.parentId/));
});

test('whitespace matchers keep their quantifier', () => {
  // The hazard: naive rewriting turns "one or more" into "zero or more, then a literal +".
  assert.equal(stripPatternWhitespace(String.raw`\s+`), String.raw`\s*`);
  assert.equal(stripPatternWhitespace(String.raw`\s\+`), String.raw`\s*`);
  assert.equal(stripPatternWhitespace(String.raw`\s\*`), String.raw`\s*`);
  assert.equal(stripPatternWhitespace(String.raw`\s?`), String.raw`\s*`);
  assert.equal(stripPatternWhitespace(String.raw`\s{2,}`), String.raw`\s*`);
});

test('character classes are left intact', () => {
  // `[\s\S]` is an any-character matcher, not a whitespace matcher.
  assert.equal(stripPatternWhitespace(String.raw`[\s\S]{0,300}`), String.raw`[\s\S]{0,300}`);
  assert.equal(stripPatternWhitespace(String.raw`[^a\s]`), String.raw`[^a\s]`);
});

test('non-whitespace escapes stay literal', () => {
  assert.equal(stripPatternWhitespace(String.raw`\.`), String.raw`\.`);
  assert.equal(stripPatternWhitespace(String.raw`\(\)`), String.raw`\(\)`);
  assert.equal(stripPatternWhitespace(String.raw`case\'x\'`), String.raw`case\'x\'`);
});

test('an embedded regex literal in the source is not corrupted', () => {
  // Regression: the source embeds `/\/^\/skill(?:\s+(?:"([^"]*)|([^\s]*)))?$/i`, where the `\s+` is
  // meaningful whitespace syntax. Treating haystack `\s` as a matcher ate the `+` and broke this.
  // The pattern is copied verbatim from the real assertion in sleepycode-regressions.test.mjs.
  const source =
    "function skillPickerQuery(value){const match=String(value||'').match" +
    String.raw`(/^\/skill(?:\s+(?:"([^"]*)|([^\s]*)))?$/i);` +
    "return match?(match[1]??match[2]??''):null}";
  const pattern =
    /function skillPickerQuery\(value\)\{const match=String\(value\|\|''\)\.match\(\/\^\\\/skill\(\?:\\s\+\(\?:"\(\[\^"\]\*\)\|\(\[\^\\s\]\*\)\)\)\?\$\/i\)/;
  assert.ok(matchesSource(source, pattern), 'embedded regex literal must survive normalization');
  // The `\s+` inside the embedded literal must still be a real quantifier, not `\s*\+`.
  assert.equal(stripSourceWhitespace(source).includes(String.raw`(?:\s+(?:`), true);
});

test('hayback normalization removes real whitespace only', () => {
  assert.equal(stripSourceWhitespace("a = b;\n\tc"), 'a=b;c');
  // Backslash-s in source is two literal characters and must be left alone.
  assert.equal(stripSourceWhitespace(String.raw`x /\s+/.test(v)`), String.raw`x/\s+/.test(v)`);
});

test('still rejects when the pinned behavior is absent', () => {
  // Without this, a matcher that quietly accepts everything would look exactly like a green suite.
  const source = "case 'subagent': { const parentId = m.parentId; }";
  assert.ok(matchesSource(source, /case'subagent':\{const parentId=m\.parentId/));
  for (const mutated of [
    "case 'subagent': { const other = m.parentId; }",
    "case 'other': { const parentId = m.parentId; }",
    "case 'subagent': { const parentId = m.otherId; }",
    "const parentId = m.parentId;",
  ]) {
    assert.equal(
      matchesSource(mutated, /case'subagent':\{const parentId=m\.parentId/),
      false,
      `should not match: ${mutated}`,
    );
  }
});

test('accepts a plain string as a literal pattern', () => {
  // Several assertions pin minified source via a bare substring rather than a regex.
  const source = "else { ensureIdentity(turn); const answer = document.createElement('div'); }";
  assert.ok(matchesSource(source, "else{ensureIdentity(turn);const answer=document.createElement('div')"));
  assert.equal(
    matchesSource(source, "else{ensureIdentity(turn);const answer=document.createElement('span')"),
    false,
  );
  // Regex metacharacters in the string must stay literal.
  assert.ok(matchesSource('x=(a|b).test(v)', 'x=(a|b).test(v)'));
  assert.equal(matchesSource('x=ab.test(v)', 'x=(a|b).test(v)'), false);
});

test('assertSource reports a useful message on mismatch', () => {
  assert.throws(
    () => assertSource('const a = 1;', /const b = 2/),
    /expected source to match/,
  );
});