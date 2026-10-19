import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const runtime = read('src/webview/runtime.ts');
const webviewHtml = read('src/webview.ts');
const styles = read('src/webview/styles.ts');
const pkg = JSON.parse(read('package.json'));

test('katex is a runtime dependency and bundled media assets exist', () => {
  assert.ok(pkg.dependencies?.katex, 'katex must be a dependency');
  const js = read('media/katex/katex.min.js');
  const css = read('media/katex/katex.min.css');
  assert.ok(js.includes('katex'), 'bundled KaTeX runtime looks valid');
  assert.ok(css.includes('.katex'), 'bundled KaTeX stylesheet looks valid');
});

test('webview loads KaTeX assets and widens the CSP for fonts', () => {
  assert.match(webviewHtml, /loadKatexAssets/);
  assert.match(webviewHtml, /font-src \$\{webview\.cspSource\}/);
  assert.match(webviewHtml, /katexStyle/);
  assert.match(webviewHtml, /katexScript/);
});

test('runtime renders inline and display math through KaTeX', () => {
  assert.match(runtime, /renderToString/);
  assert.match(runtime, /protectInlineMath/);
  assert.match(runtime, /restoreMath/);
  assert.match(runtime, /math-block/);
  assert.match(runtime, /\\\$\\\$/);
});

test('KaTeX is limited to think and content tokens, not tool-call labels', () => {
  assert.match(runtime, /function markdown\(raw,allowMath\)/);
  assert.match(runtime, /function protectInlineMath\(line,allowMath\)\{if\(allowMath===false\)return String\(line\);/);
  assert.match(runtime, /r\.innerHTML\s*=\s*markdown\(\s*part\s*\)/);
  // The streamed answer paints through the incremental stream renderer now, but its math handling
  // must be unchanged. Two invariants pin that: it is bound to the page's own `markdown`, so live
  // output and replayed history stay in lockstep, and `allowMath` arrives undefined, which markdown
  // treats as enabled (`allowMath !== false`) — the same value a full pass gets.
  assert.match(runtime, /createStreamRenderer\(markdown\)/);
  assert.match(runtime, /streamRenderer\.html\(\s*raw\s*,\s*undefined\s*\)/);
  // Reasoning now paints through the same coalesced, incremental path as the answer: the delta
  // handler only updates the buffer and schedules a paint, and the painter builds its renderer from
  // the page's own `markdown`. Without that binding a thought would lose its math.
  assert.match(runtime, /reasoningPaint\.schedule\(\{\s*el:\s*reasoning,\s*raw:\s*reasoning\.dataset\.raw\s*\}\)/);
  assert.match(runtime, /renderer\s*=\s*createStreamRenderer\(markdown\)/);
  assert.match(runtime, /el\.innerHTML\s*=\s*renderer\.html\(\s*payload\.raw\s*,\s*undefined\s*\)/);
  assert.match(runtime, /className\s*=\s*'reasoning';\s*r\.innerHTML\s*=\s*markdown\(\s*w\.text\s*\)/);
  assert.doesNotMatch(runtime, /task-label">'\+markdown\((?:t\.name|w\.text|retLabel)\)/);
  assert.match(runtime, /task-label">'\+markdown\(\s*t\.name\s*,\s*false\s*\)/);
  assert.match(runtime, /task-label">'\+markdown\(\s*name\s*,\s*false\s*\)/);
  // updateTask used to render the live label itself; it now delegates to the shared tool-card
  // builder, which passes allowMath=false. Guard against a math-enabled label creeping back in.
  assert.doesNotMatch(runtime, /\.task-label'\)\.innerHTML\s*=\s*markdown\(\s*m\.name\s*[,)]/);
  assert.match(runtime, /innerHTML\s*=\s*markdown\(\s*label\s*,\s*false\s*\)/);
  assert.match(runtime, /Reconnect failed '\s*\+\s*m\.attempt\s*\+\s*'\/'\s*\+\s*m\.max\s*\+\s*'\*\*'\s*,\s*false\s*\)/);
});

test('math blocks stay scrollable and themed', () => {
  assert.match(styles, /\.math-block\{[^}]*overflow-x:auto/);
  assert.match(styles, /\.math-block \.katex-display/);
});
