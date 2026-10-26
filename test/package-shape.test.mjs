import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Guards the `.vscodeignore` allowlist that trims playwright-core, the source map and the icon.
 * vsce lets an allowlist win, so a dependency bump that adds a new playwright-core entry would
 * silently stop shipping it (the browser tools would fail at runtime for users only). Instead of
 * reconstructing vsce's glob rules here, run vsce and assert the shipped set.
 */

function shipped() {
  return new Set(execFileSync(process.execPath, [process.cwd() + '/node_modules/.bin/vsce', 'ls'], { encoding: 'utf8' }).split('\n').filter(Boolean));
}

test('the built source map stays out of the package', () => {
  assert.equal(shipped().has('dist/extension.js.map'), false, 'dist/extension.js.map must not ship (the `.map` rule does not reach dist/; `**/*.map` must stay)');
});

test('playwright-core type definitions and the trace/report viewer stay out of the package', () => {
  const files = shipped();
  assert.equal([...files].some(f => f.includes('playwright-core/types/')), false, 'type definitions are compile-time only');
  assert.equal([...files].some(f => f.includes('playwright-core/lib/vite/')), false, 'the trace/report viewer is never loaded by the browser tools');
});

test('playwright-core runtime and its server bundles still ship', () => {
  const files = shipped();
  assert.ok(files.has('node_modules/playwright-core/lib/coreBundle.js'), 'coreBundle.js must ship');
  assert.ok(files.has('node_modules/playwright-core/lib/utilsBundle.js'), 'utilsBundle.js must ship');
  assert.ok(files.has('node_modules/playwright-core/package.json'), 'package.json must ship');
});

/**
 * The chat UI is not inside dist/extension.js: `src/webview-react.ts` renders a
 * shell that loads `dist/webview/sidebar.js` and `.css`. If either is missing
 * the panel opens to an empty #root with no error, which reads as a dead
 * extension — and nothing in the host can detect it.
 */
test('the React webview bundles the chat shell loads actually ship', () => {
  const files = shipped();
  for (const entry of ['sidebar', 'settings']) {
    assert.ok(files.has(`dist/webview/${entry}.js`), `dist/webview/${entry}.js must ship`);
    assert.ok(files.has(`dist/webview/${entry}.css`), `dist/webview/${entry}.css must ship`);
  }
});

test('the build task produces the React webview, not just the extension host', async () => {
  // These bundles used to be built by a script no npm task ran, so a clean
  // `npm run package` shipped a chat with no JavaScript at all.
  const build = await readFile(new URL('../esbuild.mjs', import.meta.url), 'utf8');
  for (const entry of ['sidebar', 'settings']) {
    assert.ok(
      build.includes(`webview-ui/${entry}/main.tsx`),
      `esbuild.mjs must build webview-ui/${entry}/main.tsx — it is what dist/webview/${entry}.js is made from`,
    );
  }
  assert.ok(build.includes('dist/webview'), 'the webview bundle must be written where src/webview-react.ts reads it');
});
