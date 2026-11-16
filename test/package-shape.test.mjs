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

test('CI drives the shipping webview through the browser harnesses', async () => {
  // The probes existed and were repaired (plan A6) but nothing ran them: `check` is
  // browser-free by design, and CI stopped after `npm run build`. A perf guard nobody
  // runs is the same as no guard, which is how the O(N^2) streaming shape came back
  // once already.
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.ok(ci.includes('npm run check:perf'), 'ci.yml must run the browser harnesses');

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts['check:perf'], 'the task CI invokes must exist');
  assert.ok(pkg.scripts['check:perf'].includes('perf-probe.mjs --check'), 'the perf probe must run in asserting mode, not report-only');
  assert.ok(pkg.scripts['check:perf'].includes('ui-shots.mjs --check'), 'ui-shots must run in its failing mode');
});

test('the perf gate asserts a relative shape, never wall-clock speed', async () => {
  // Absolute timings are not gateable: unchanged code measured 141 ms then 30 ms for
  // the same scenario on the same machine. A wall-clock threshold would flake
  // constantly on CI, so the gate must key off the early-vs-late growth ratio.
  const probe = await readFile(new URL('../scripts/perf-probe.mjs', import.meta.url), 'utf8');
  assert.ok(probe.includes('MAX_GROWTH_RATIO'), 'the gate needs a growth-ratio limit');
  assert.ok(probe.includes('growthRatio > MAX_GROWTH_RATIO'), 'the growth ratio is what gets compared');
  assert.ok(probe.includes('process.exit(1)'), 'a regression must fail the build');
  // Guard the trap directly: no absolute millisecond threshold on the measured set.
  assert.equal(
    /totalMs\s*>\s*\d+/.test(probe),
    false,
    'a wall-clock threshold on measured timings would flake on slower CI runners',
  );
});
