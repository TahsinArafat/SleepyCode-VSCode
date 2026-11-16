/**
 * Code-block highlighting in the React renderer, and the one thing that
 * matters about it: a code block is model-authored text turned into markup,
 * so the load-bearing property is that it can never become markup itself.
 *
 * These tests hold the same three lines the vanilla renderer held, re-pointed
 * at `webview-ui/shared/codeLanguages.ts` which is what ships today:
 *
 *   1. Every segment emitted into the DOM is escaped, for every language the
 *      highlighter claims to support, including half-streamed input.
 *   2. Unknown languages round-trip to the escaped plaintext fallback rather
 *      than leaking anything.
 *   3. The scanner actually classifies tokens, otherwise (1)-(2) pass on a
 *      highlighter that highlights nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  highlightCode,
  escapeCodeHtml,
  normalizeCodeLanguage,
  getCodeLanguage,
} from '../webview-ui/shared/codeLanguages.ts';

const UNESCAPE = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** The text a user would select out of a rendered block. */
function textOf(html) {
  return html
    .replace(/<span class="[^"]*">/g, '')
    .replace(/<\/span>/g, '')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, m => UNESCAPE[m]);
}

const SAMPLES = [
  ['js', 'const a = 1; // note\n/* block */\nlet s = "hi";\n'],
  ['ts', 'export function f(x: number): string { return `${x}`; }\n'],
  ['python', 'def f(x):\n    """doc"""\n    return x + 1  # add\n'],
  ['json', '{"a": 1, "b": [true, null], "c": {"d": "e"}}\n'],
  ['shell', '#!/bin/sh\nfor f in *.ts; do\n  echo "$f"\ndone\n'],
  ['diff', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context\n'],
  ['rust', 'fn main() { let v: Vec<u8> = vec![]; /* c */ }\n'],
  ['go', 'func main() {\n\tfmt.Println("hi") // go\n}\n'],
  ['css', '.a > .b { color: red; /* c */ }\n'],
  ['html', '<div class="a">text</div><!-- c -->\n'],
  ['sql', 'SELECT id FROM t WHERE a = 1; -- c\n'],
  ['yaml', 'key: value # c\nlist:\n  - a\n'],
  ['md', '# Title\n\n- item\n\n```ts\nconst x = 1;\n```\n'],
];

test('every language round-trips: strip the spans, unescape, get the input back', () => {
  for (const [lang, sample] of SAMPLES) {
    const out = highlightCode(sample, lang);
    assert.equal(textOf(out), sample, `text round-trip failed for ${lang}`);
  }
});

test('round-trip holds for half-streamed input: unterminated string, comment and fence tail', () => {
  const tails = [
    ['js', 'const a = "unterminated\n'],
    ['js', '// unterminated line comment\n'],
    ['js', '/* unterminated block\n'],
    ['js', 'const t = `unterminated template\n'],
    ['python', 'x = """unterminated\n'],
    ['diff', '--- a\n+++ b\n+added but no context\n'],
    ['html', '<div class="a"><!-- unterminated comment\n'],
    ['json', '{"a": "unterminated\n'],
  ];
  for (const [lang, sample] of tails) {
    assert.equal(textOf(highlightCode(sample, lang)), sample, `tail round-trip failed for ${lang}`);
  }
});

test('code samples can never inject markup, in any language', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '</code></pre><img src=x onerror=alert(1)>',
    '`<svg/onload=alert(1)>`',
    '"\']</span><script>alert(1)</script>',
    '<!-- --><script>x</script>',
    '{"a":"</code></pre><script>alert(1)</script>"}',
    'const a = "</span></div>";',
    '+ </pre><iframe src=javascript:alert(1)>',
  ];
  const langs = [...SAMPLES.map(s => s[0]), 'unknown-lang', ''];
  for (const lang of langs) {
    for (const payload of payloads) {
      const out = highlightCode(payload, lang);
      const injected = out.replace(/<span class="[^"]*">/g, '').replace(/<\/span>/g, '');
      assert.ok(!injected.includes('<'), `raw '<' survived for lang=${lang}: ${out}`);
      assert.ok(!injected.includes('>'), `raw '>' survived for lang=${lang}: ${out}`);
      assert.equal(textOf(out), payload, `payload text changed for lang=${lang}`);
    }
  }
});

test('a named-but-unsupported language produces the escaped plaintext fallback', () => {
  const sample = 'const a = 1; // <b>not bold</b>\n';
  for (const lang of ['unknown-lang', 'markdown', 'md', 'text', 'plaintext']) {
    assert.equal(highlightCode(sample, lang), escapeCodeHtml(sample), `fallback changed for lang=${JSON.stringify(lang)}`);
  }
  // An empty fence info string triggers auto-detection, which reads the content and picks a
  // language from it. That is a feature, not a fallback; grouping it with the fallbacks was a
  // category error in the original test.
  assert.notEqual(highlightCode(sample, ''), escapeCodeHtml(sample), 'empty lang auto-detects, it does not fall back');
});

test('the scanner actually classifies tokens', () => {
  const js = highlightCode('const a = 1; // c\n', 'js');
  assert.match(js, /<span class="code-token-keyword">const<\/span>/);
  assert.match(js, /<span class="code-token-number">1<\/span>/);
  assert.match(js, /<span class="code-token-comment">\/\/ c<\/span>/);

  // The keyword is matched, the string must be matched too. The React highlighter escapes
  // its string output (`&quot;`), so the pattern has to expect that, not a bare quote.
  assert.match(highlightCode('let s = "x";\n', 'js'), /<span class="code-token-string">&quot;x&quot;<\/span>/);

  const diff = highlightCode('@@ -1 +1 @@\n+added\n-removed\n', 'diff');
  assert.match(diff, /<span class="code-token-keyword">@@ -1 \+1 @@<\/span>/);
  assert.match(diff, /<span class="code-token-inserted">\+added<\/span>/);
  assert.match(diff, /<span class="code-token-deleted">-removed<\/span>/);
});

test('language ids normalize across the aliases agents emit', () => {
  // The React path is normalised through `normalizeCodeLanguage`. Agents emit a wide range
  // of fence info strings, so the same source written as `ts` and as `TypeScript` must be
  // recognised as TypeScript rather than falling through to plaintext.
  const cases = [
    ['ts', 'typescript'], ['tsx', 'typescript'], ['mts', 'typescript'], ['cts', 'typescript'], ['typescript', 'typescript'],
    ['javascript', 'javascript'], ['js', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'], ['jsx', 'javascript'],
    ['py', 'python'], ['python', 'python'],
    ['jsonc', 'json'],
    ['bash', 'bash'], ['sh', 'bash'],
    ['patch', 'diff'],
    ['rs', 'rust'], ['golang', 'go'], ['go', 'go'],
    ['yml', 'yaml'], ['html', 'html'],
    ['md', 'markdown'], ['markdown', 'markdown'], ['text', 'plaintext'], ['plaintext', 'plaintext'],
    ['', 'auto'],   // an empty fence info string asks the highlighter to detect, which is correct.
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeCodeLanguage(input), expected, `alias failed for ${JSON.stringify(input)}`);
  }
});

test('getCodeLanguage is deterministic and never returns undefined', () => {
  // The markdown path depends on this returning a usable entry for every fence.
  for (const lang of ['js', 'python', 'unknown-lang', '']) {
    const resolved = getCodeLanguage('const a = 1;\n', lang);
    assert.ok(resolved && resolved.id, `no language resolved for ${lang}`);
  }
});
