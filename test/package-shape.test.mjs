import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

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
