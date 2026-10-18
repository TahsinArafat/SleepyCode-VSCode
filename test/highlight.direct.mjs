/**
 * Code-block highlighting (Phase 2).
 *
 * The highlighter is the one place in the transcript that takes *model-authored* text and turns it
 * into markup, so the load-bearing property is not "does it look nice" — it is that a code sample can
 * never become markup. These tests hold that line:
 *
 *   1. **No character is ever lost or altered.** Stripping the emitted spans and unescaping returns
 *      the input byte for byte, for every language, including unterminated fences/strings/comments —
 *      which is the state a half-streamed block is actually rendered in.
 *   2. **No markup escapes.** Adversarial payloads come back with every `<`/`>` neutralised; the only
 *      tags in the output are the scanner's own spans.
 *   3. **Unknown languages are byte-identical to the pre-Phase-2 renderer**, so highlighting can never
 *      change output for a language it does not recognise.
 *   4. Token classes are actually produced, otherwise (1)-(3) would pass on a highlighter that
 *      highlights nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertSource } from './source-assert.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ESCAPE_HTML_SOURCE, HTML_ESCAPES_SOURCE } from '../src/webview/runtime-core.ts';
import { HIGHLIGHT_SOURCE } from '../src/webview/highlight.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The production sanitizer, assembled exactly as runtime.ts assembles it. */
const escSource = ESCAPE_HTML_SOURCE.replace('${HTML_ESCAPES_SOURCE}', HTML_ESCAPES_SOURCE);
const esc = new Function(`${escSource}\nreturn esc;`)();

/** The shipped browser source, evaluated with the production esc. There is no second copy. */
const { highlight, highlightLanguageId } = new Function(
  'esc',
  `${HIGHLIGHT_SOURCE}\nreturn { highlight, highlightLanguageId };`,
)(esc);

const UNESCAPE = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** The text a user would select and copy out of a rendered block. */
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
  ['toml', 'key = "v" # c\n'],
];

test('stripping spans and unescaping returns the input exactly, for every language', () => {
  for (const [lang, sample] of SAMPLES) {
    const out = highlight(sample, lang);
    assert.equal(textOf(out), sample, `text round-trip failed for ${lang}`);
  }
});

test('round-trip holds for half-streamed input: unterminated string, comment and fence tail', () => {
  // This is the state an in-flight code block is rendered in on every frame, so it is the state that
  // must not corrupt. A scanner that swallows an unterminated token would silently eat the tail.
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
    assert.equal(textOf(highlight(sample, lang)), sample, `tail round-trip failed for ${lang}`);
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
      const out = highlight(payload, lang);
      // Every '<' must have come from a span we emitted ourselves.
      const injected = out.replace(/<span class="[^"]*">/g, '').replace(/<\/span>/g, '');
      assert.ok(!injected.includes('<'), `raw '<' survived for lang=${lang}: ${out}`);
      assert.ok(!injected.includes('>'), `raw '>' survived for lang=${lang}: ${out}`);
      assert.equal(textOf(out), payload, `payload text changed for lang=${lang}`);
    }
  }
});

test('an unknown or absent language is byte-identical to the pre-Phase-2 plain renderer', () => {
  const sample = 'const a = 1; // <b>not bold</b>\n';
  for (const lang of ['', 'unknown-lang', 'markdown', 'md', 'text']) {
    assert.equal(highlight(sample, lang), esc(sample), `fallback changed for lang=${JSON.stringify(lang)}`);
  }
});

test('the scanner actually classifies tokens', () => {
  const js = highlight('const a = 1; // c\n', 'js');
  assert.match(js, /<span class="tok-keyword">const<\/span>/);
  assert.match(js, /<span class="tok-num">1<\/span>/);
  assert.match(js, /<span class="tok-com">\/\/ c<\/span>/);

  assert.match(highlight('let s = "x";\n', 'js'), /<span class="tok-str">&quot;x&quot;<\/span>/);

  // A JSON string followed by ':' is a key, not a value.
  const json = highlight('{"a": 1, "b": [true, null]}\n', 'json');
  assert.match(json, /<span class="tok-key">&quot;a&quot;<\/span>/);
  assert.match(json, /<span class="tok-num">1<\/span>/);
  assert.match(json, /<span class="tok-keyword">true<\/span>/);
  assert.match(json, /<span class="tok-keyword">null<\/span>/);

  const diff = highlight('@@ -1 +1 @@\n+added\n-removed\n', 'diff');
  assert.match(diff, /<span class="tok-meta">@@ -1 \+1 @@<\/span>/);
  assert.match(diff, /<span class="tok-add">\+added<\/span>/);
  assert.match(diff, /<span class="tok-del">-removed<\/span>/);

  const html = highlight('<div class="a">\n', 'html');
  assert.match(html, /<span class="tok-key">&lt;div class=&quot;a&quot;&gt;<\/span>/);

  const shell = highlight('echo $HOME\n', 'shell');
  assert.match(shell, /<span class="tok-keyword">echo<\/span>/);
  assert.match(shell, /<span class="tok-key">\$HOME<\/span>/);
});

test('language ids normalize across the aliases agents actually emit', () => {
  const cases = [
    ['ts', 'js'], ['tsx', 'js'], ['TypeScript', 'js'], ['javascript', 'js'],
    ['py', 'python'], ['Python', 'python'],
    ['jsonc', 'json'],
    ['bash', 'shell'], ['sh', 'shell'], ['console', 'shell'],
    ['patch', 'diff'],
    ['rs', 'rust'], ['golang', 'go'],
    ['yml', 'yaml'], ['vue', 'html'],
    ['md', ''], ['markdown', ''], ['text', ''], ['plaintext', ''], ['', ''], [undefined, ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(highlightLanguageId(input), expected, `alias failed for ${JSON.stringify(input)}`);
  }
});

test('the injected source is safe to splice: no template-literal interpolation or stray backtick', () => {
  // runtime.ts interpolates this string into a String.raw template, so a `${` or a backtick in here
  // would truncate the webview at build time rather than fail a test.
  assert.ok(!HIGHLIGHT_SOURCE.includes('${'), 'HIGHLIGHT_SOURCE must not contain ${');
  const backtick = String.fromCharCode(96);
  assert.ok(!HIGHLIGHT_SOURCE.includes(backtick), 'HIGHLIGHT_SOURCE must not contain a literal backtick');
});

test('the source is spliced into the runtime template and checked for syntax by the build', () => {
  const runtime = readFileSync(join(root, 'src/webview/runtime.ts'), 'utf8');
  assertSource(runtime, /import \{ HIGHLIGHT_SOURCE \} from '\.\/highlight';/);
  assertSource(runtime, /\$\{HIGHLIGHT_SOURCE\}/);
});

test("runtime.ts's own template survives a stray backtick or interpolation", () => {
  // runtime.ts is one String.raw template, so a backtick in a *comment* truncates the entire
  // webview, and an unapproved `${` leaks through as literal source. Both fail at build time with
  // an error that points nowhere near the cause, so they are pinned here with a useful message.
  const runtime = readFileSync(join(root, 'src/webview/runtime.ts'), 'utf8');
  const template = runtime.match(/String\.raw`([\s\S]*?)`;/)?.[1];
  assert.ok(template, 'could not locate the runtime String.raw template');

  const backtick = String.fromCharCode(96);
  const strayBacktick = template.indexOf(backtick);
  assert.equal(strayBacktick, -1,
    `runtime.ts contains a literal backtick at offset ${strayBacktick}, which truncates the webview template: ` +
    JSON.stringify(template.slice(Math.max(0, strayBacktick - 60), strayBacktick + 20)));

  const allowed = ['ESCAPE_HTML_SOURCE', 'STREAM_RENDER_SOURCE', 'STREAM_FRAME_SOURCE', 'HIGHLIGHT_SOURCE', 'gitTracked', 'markUri'];
  for (const match of template.matchAll(/\$\{([^}]*)\}/g)) {
    assert.ok(allowed.includes(match[1]),
      'runtime.ts interpolates an identifier that verify.mjs does not substitute, so it would survive into the shipped webview: ' + match[1]);
  }
});
