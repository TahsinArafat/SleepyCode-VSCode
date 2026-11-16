import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const reactApp = read('webview-ui/shared/markdown.ts');
const reactHtml = read('src/webview-react.ts');
const reactCss = read('webview-ui/sidebar/sidebar.css');
const mathBlocks = read('src/math-blocks.ts');
const pkg = JSON.parse(read('package.json'));

test('katex is a dependency and the bundled media assets exist', () => {
  assert.ok(pkg.dependencies?.katex, 'katex must be a dependency');
  const js = read('media/katex/katex.min.js');
  const css = read('media/katex/katex.min.css');
  assert.ok(js.includes('katex'), 'bundled KaTeX runtime looks valid');
  assert.ok(css.includes('.katex'), 'bundled KaTeX stylesheet looks valid');
});

test('the React webview injects KaTeX assets and widens the CSP for fonts', () => {
  // The stylesheet is inlined with font urls rewritten to webview URIs in a style
  // block (CSP `style-src` already permits unsafe-inline); the script is bundled
  // into `dist/webview/sidebar.js`, not loaded as a separate resource.
  assert.match(reactHtml, /function katexStyleSheet\(/, 'the shell must build a KaTeX stylesheet with rewritten font URIs');
  assert.match(reactHtml, /fonts\/\*\)|fonts\/|fonts'/, 'font references are resolved to webview URIs');
  assert.match(reactHtml, /entry === "sidebar" \? katexStyleSheet/, 'only the chat entry pays for the stylesheet');
  assert.match(reactHtml, /font-src \$\{webview\.cspSource\}/, 'KaTeX fonts must load from the webview source');
});

test('the markdown pipeline renders math through KaTeX via the shared helper', () => {
  assert.match(mathBlocks, /function protectInlineMath\(/, 'math is pulled out before marked sees it');
  assert.match(mathBlocks, /function restoreMath\(/, 'rendered math is spliced back in after parsing');
  assert.match(mathBlocks, /function createMathRenderer\(/, 'a bounded renderer cache is used, not a bare call site');
  assert.match(reactApp, /katexRender/, 'the React path has its own KaTeX renderer bound');
  assert.match(reactApp, /displayMode/, 'inline and display math are both wired');
});

test('display math is wrapped in a .math-block container', () => {
  assert.match(reactApp, /<div class="math-block">\$\{inner\}<\/div>/, 'display math must be wrapped in a scrollable block');
});

test('inline task-like labels never receive math parsing', () => {
  // In the React path, labels are passed through the same guarded renderer any other
  // inline token gets; the invariant that matters is that `allowMath` is honoured.
  assert.match(mathBlocks, /allowMath === false/, 'allowMath false short-circuits both protect and restore');
});

test('math blocks stay scrollable and themed', () => {
  assert.match(reactCss, /\.math-block\s*\{[^}]*overflow-x:\s*auto/, 'wide formulae scroll horizontally');
  assert.match(reactCss, /\.math-block\s+\.katex-display/, 'display math gets its own spacing');
  assert.match(reactCss, /\.katex\s*\{[^}]*color:\s*var\(--fg\)/, 'the foreground colour is applied to KaTeX output');
});
