/**
 * Phase 5, part two — density, and the empty state the plan assumed did not exist.
 *
 * Two things are worth being honest about here.
 *
 * First, the empty state was already developer-grade before this test existed. It already renders the
 * indexed file count, the index status with its reindex affordance, and a set of clickable starters.
 * The plan doc described it as work still to do, the same way Phase 4's keyboard section described
 * work that already existed. So these tests are not pinning something new -- they are pinning
 * something real, so that a future edit cannot quietly drop the file count and leave a plan item
 * that reads "done" and is not.
 *
 * Second, compact density clamps reasoning to two lines rather than hiding it. A density preference
 * that deletes text the user cannot get back is not a density preference. The full text stays in the
 * DOM and stays in the transcript export; only the visual height changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function openComposer() {
  const bundled = await esbuild.build({
    entryPoints: [join(root, 'src/webview/runtime.ts')],
    bundle: true, format: 'cjs', platform: 'neutral', write: false, target: 'es2022',
  });
  const cjsModule = { exports: {} };
  new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(cjsModule, cjsModule.exports, createRequire(import.meta.url));
  const runtime = cjsModule.exports.getWebviewRuntime('MARK_URI.svg', true);
  const css = readFileSync(join(root, 'src/webview/styles.ts'), 'utf8').match(/String\.raw`([\s\S]*?)`/)?.[1];
  const wv = readFileSync(join(root, 'src/webview.ts'), 'utf8');
  const body = wv.slice(wv.indexOf('<body>') + 6).split('<script')[0].replace(/\$\{[^}]*\}/g, 'X');
  const html = `<!doctype html><html><head><meta charset="UTF-8">
<style>${css}</style></head><body>${body}
<script>
window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted?.push(m),getState:()=>undefined,setState:()=>{}});
window.__posted=[];
window.__emit=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));
window.__frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
</script><script>${runtime}</script></body></html>`;

  const dir = join(tmpdir(), `sleepycode-density-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('file://' + file);
  return { browser, page, dir, errors };
}

const cleanup = (t, browser, dir) => t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

/** Put the webview in the state a fresh workspace with a ready index would produce. */
async function primeWorkspace(page) {
  await page.evaluate(async () => {
    window.__emit({ type: 'conversations', conversations: [], activeId: '' });
    window.__emit({ type: 'project', path: '/ws/demo', name: 'demo' });
    window.__emit({
      type: 'projectIndex', status: 'ready', indexed: 137, total: 137,
      index: { languages: [{ language: 'TypeScript' }, { language: 'JavaScript' }], frameworks: ['TypeScript'] },
    });
    await window.__frame();
  });
}

test('the empty state states the indexed file count and the index status', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await primeWorkspace(page);
  const out = await page.evaluate(() => ({
    text: document.getElementById('empty')?.innerText || '',
    hasIndexCard: Boolean(document.querySelector('[data-reindex-project]')),
  }));
  assert.match(out.text, /137 files indexed/, `expected the file count in the empty state, got ${JSON.stringify(out.text)}`);
  assert.match(out.text, /TypeScript/, 'expected the detected languages to be surfaced');
  assert.equal(out.hasIndexCard, true, 'the index card should offer the reindex affordance');
  assert.deepEqual(errors, []);
});

test('starters are clickable and put their prompt in the composer', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await primeWorkspace(page);
  const count = await page.evaluate(() => document.querySelectorAll('[data-starter]').length);
  assert.ok(count >= 3, `expected at least three starters, found ${count}`);
  await page.click('[data-starter]');
  const value = await page.inputValue('#input');
  assert.ok(value.length > 10, `expected the starter prompt to land in the composer, got ${JSON.stringify(value)}`);
  assert.deepEqual(errors, []);
});

test('a fresh session is comfortable, not compact', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  assert.equal(await page.evaluate(() => document.body.classList.contains('compact')), false);
  assert.deepEqual(errors, []);
});

test('loading settings applies compact immediately and reflects it in the control', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await page.evaluate(async () => {
    window.__emit({ type: 'settings', providers: [], apiKeys: {}, compact: true });
    await window.__frame();
  });
  const out = await page.evaluate(() => ({
    compact: document.body.classList.contains('compact'),
    checked: document.getElementById('compactDensity')?.checked,
  }));
  assert.equal(out.compact, true, 'compact must apply without a reload -- it is a view preference');
  assert.equal(out.checked, true, 'the control must reflect the restored value');
  assert.deepEqual(errors, []);
});

test('leaving settings restores comfortable density', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await page.evaluate(async () => {
    window.__emit({ type: 'settings', providers: [], apiKeys: {}, compact: true });
    await window.__frame();
    window.__emit({ type: 'settings', providers: [], apiKeys: {}, compact: false });
    await window.__frame();
  });
  assert.equal(await page.evaluate(() => document.body.classList.contains('compact')), false);
  assert.deepEqual(errors, []);
});

test('toggling the control persists the choice through saveSettings', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await page.evaluate(async () => {
    window.__emit({ type: 'settings', providers: [], apiKeys: {} });
    await window.__frame();
  });
  // Click the label, not the input: the real checkbox is visually hidden behind .checkbox-box, so
  // driving the input directly is not what a user does. And click it through the DOM rather than
  // through Playwright, because this row lives in a settings tab that is not the open one -- the
  // label is display:none, and a visibility-gated click would just time out.
  await page.evaluate(() => document.querySelector('label[for="compactDensity"]').click());
  await page.waitForTimeout(900);
  const on = await page.evaluate(() => ({
    saved: window.__posted.filter(m => m && m.type === 'saveSettings').pop(),
    compact: document.body.classList.contains('compact'),
    checked: document.getElementById('compactDensity').checked,
  }));
  assert.ok(on.saved, 'checking should autosave');
  assert.equal(on.saved.compact, true);
  assert.equal(on.compact, true, 'the view must follow the control immediately');
  assert.equal(on.checked, true);

  await page.evaluate(() => { window.__posted.length = 0; });
  await page.evaluate(() => document.querySelector('label[for="compactDensity"]').click());
  await page.waitForTimeout(900);
  const off = await page.evaluate(() => ({
    saved: window.__posted.filter(m => m && m.type === 'saveSettings').pop(),
    compact: document.body.classList.contains('compact'),
  }));
  assert.ok(off.saved, 'unchecking should autosave');
  assert.equal(off.saved.compact, false);
  assert.equal(off.compact, false);
  assert.deepEqual(errors, []);
});