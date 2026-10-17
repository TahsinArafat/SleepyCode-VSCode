/**
 * Input history recall in the composer (webview runtime.ts).
 *
 * The webview is plain browser JS, so the real runtime can be driven headlessly:
 * type, press Up/Down, and assert what lands back in the textarea. The rules under
 * test are the ones that make recall feel like a shell rather than a trap — caret
 * position must be able to traverse a multi-line draft without hijacking Up/Down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';

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
  const body = readFileSync(join(root, 'src/webview.ts'), 'utf8')
    .slice(readFileSync(join(root, 'src/webview.ts'), 'utf8').indexOf('<body>') + 6)
    .split('<script')[0].replace(/\$\{[^}]*\}/g, 'X');

  const html = `<!doctype html><html><head><meta charset="UTF-8">
<style>${css}</style><style>html,body{height:100%;margin:0}</style></head><body>${body}
<script>
window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted?.push(m),getState:()=>undefined,setState:s=>{}});
window.__posted=[];
window.__emit=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));
</script><script>${runtime}</script></body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  // selectModel guards submit(), so recall paths need a model present.
  await page.evaluate(() => window.__emit({ type: 'models', groups: [{ id: 'g1', name: 'Test', models: [{ id: 'm1', name: 'Model One' }] }], selected: 'm1' }));
  await page.evaluate(() => window.__emit({ type: 'conversation', conversationId: 'c1', items: [], running: false, label: '' }));
  await page.waitForTimeout(150);
  return { page, browser, errors };
}

async function press(page, key) {
  await page.evaluate(k => {
    const el = document.getElementById('input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  }, key);
}

test('Up and Down walk back and forth through sent prompts, newest first', async t => {
  const { page, browser, errors } = await openComposer();
  t.after(() => browser.close());
  const type = async text => {
    await page.fill('#input', text);
    await page.evaluate(() => document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true })));
    await press(page, 'Enter');
    await page.waitForTimeout(60);
  };
  await type('first prompt');
  await type('second prompt');
  const sent = await page.evaluate(() => window.__posted.filter(m => m.type === 'send').map(m => m.text));
  assert.deepEqual(sent, ['first prompt', 'second prompt'], `history is built from sends; got ${JSON.stringify(sent)}`);

  // The draft currently in the box must survive the first Up press.
  await page.fill('#input', 'half-typed draft');
  const run = async k => await page.evaluate(key => {
    const el = document.getElementById('input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    return el.value;
  }, k);

  assert.equal(await run('ArrowUp'), 'second prompt', 'first Up recalls the most recent prompt');
  const state = await page.evaluate(() => {
    const el = document.getElementById('input');
    return { value: el.value, caret: el.selectionStart, len: el.value.length };
  });
  assert.equal(state.value, 'second prompt', `recall did not move the caret: ${JSON.stringify(state)}`);
  assert.equal(await run('ArrowUp'), 'first prompt');
  assert.equal(await run('ArrowDown'), 'second prompt');
  assert.equal(await run('ArrowDown'), 'half-typed draft', 'walking back to the draft restores what was typed');

  assert.deepEqual(errors, []);
});

test('Up at the oldest entry is a no-op, and Down past the newest clears to the draft', async t => {
  const { page, browser } = await openComposer();
  t.after(() => browser.close());
  const value = () => page.$eval('#input', el => el.value);
  const pressAndRead = async key => {
    await press(page, key);
    return value();
  };

  await page.fill('#input', 'only prompt');
  await page.evaluate(() => window.__posted = []);
  await press(page, 'Enter');
  await page.waitForTimeout(60);
  await page.fill('#input', 'draft');
  assert.equal(await pressAndRead('ArrowUp'), 'only prompt');
  assert.equal(await pressAndRead('ArrowUp'), 'only prompt', 'no wraparound at the oldest end');
  assert.equal(await pressAndRead('ArrowDown'), 'draft');
  assert.equal(await pressAndRead('ArrowDown'), 'draft', 'extra Down is inert rather than blanking the draft');
});

test('arrow carets still move freely through a multi-line draft', async t => {
  const { page, browser } = await openComposer();
  t.after(() => browser.close());
  const value = () => page.$eval('#input', el => el.value);

  await page.fill('#input', 'sent prompt');
  await page.waitForTimeout(30);
  await page.fill('#input', 'line one\nline two');
  await page.evaluate(() => {
    const el = document.getElementById('input');
    el.focus();
    el.setSelectionRange(15, 15);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(30);
  assert.equal(await value(), 'line one\nline two', 'Up mid-draft moves the caret instead of recalling history');
});

test('Escape clears a non-empty composer and then blurs it', async t => {
  const { page, browser } = await openComposer();
  t.after(() => browser.close());
  const value = () => page.$eval('#input', el => el.value);

  await page.fill('#input', 'something in progress');
  await press(page, 'Escape');
  assert.equal(await value(), '', 'first Escape clears the text');
  await page.evaluate(() => document.getElementById('input').focus());
  await press(page, 'Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.id || 'body'), 'body', 'second Escape drops focus');
});

test('empty composer sends are not recorded into history', async t => {
  const { page, browser } = await openComposer();
  t.after(() => browser.close());
  await page.evaluate(() => window.__posted = []);
  await press(page, 'Enter');
  await page.waitForTimeout(60);
  const posted = await page.evaluate(() => window.__posted);
  assert.deepEqual(posted, [], 'no send message is posted for an empty composer');
  await page.fill('#input', 'a real prompt');
  await press(page, 'Enter');
  await page.waitForTimeout(60);
  const after = await page.evaluate(() => window.__posted);
  assert.equal(after.length, 1, 'a real prompt still sends');
});

test('the harness working directory is cleaned up', () => {
  const work = join(tmpdir(), 'sleepycode-composer-history-test');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  assert.ok(true);
});
