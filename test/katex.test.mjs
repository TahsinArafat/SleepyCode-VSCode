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
  assert.match(runtime, /r\.innerHTML=markdown\(part\);/);
  assert.match(runtime, /current\.innerHTML=markdown\(current\.dataset\.raw\);/);
  assert.match(runtime, /reasoning\.innerHTML=markdown\(reasoning\.dataset\.raw\);/);
  assert.match(runtime, /className='reasoning';r\.innerHTML=markdown\(w\.text\);/);
  assert.doesNotMatch(runtime, /task-label">'\+markdown\((?:t\.name|w\.text|retLabel)\)/);
  assert.match(runtime, /task-label">'\+markdown\(t\.name,false\)/);
  assert.match(runtime, /task-label">'\+markdown\(w\.text,false\)/);
  assert.match(runtime, /innerHTML=markdown\(m\.name,false\)/);
  assert.match(runtime, /innerHTML=markdown\(label,false\)/);
  assert.match(runtime, /Reconnect failed '\+m\.attempt\+'\/'\+m\.max\+'\*\*',false\)/);
});

test('math blocks stay scrollable and themed', () => {
  assert.match(styles, /\.math-block\{[^}]*overflow-x:auto/);
  assert.match(styles, /\.math-block \.katex-display/);
});
