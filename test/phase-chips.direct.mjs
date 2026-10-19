/**
 * Phase 5, last item — the turn timeline.
 *
 * The transcript only ever showed the current sentence in the activity summary, so a long run read as
 * one spinner that never resolved. The chips fix that, and the constraint that shaped the
 * implementation is worth stating: they are derived from state that *already exists* — the loading
 * flag, the streaming text element, and the tool count. No new message type, no host change, nothing
 * to keep in sync on the extension side.
 *
 * One thing worth stating because it looks like a bug and is not: the Answer chip is never the
 * *active* one. `createTextSegment()` finishes the activity panel and drops its refs before the
 * first answer token lands, so the panel's last live moment is "Tools", and Answer only ever appears
 * as done. A fourth stage claiming otherwise would be a state the panel never passes through. Both
 * chip paths are covered -- the live panel and the closed panel that buildLiveActivity renders.
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

  const dir = join(tmpdir(), `sleepycode-phases-${process.pid}-${Date.now()}`);
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

/** Read the chip row out of whichever activity panel is on screen. */
async function chips(page) {
  return page.evaluate(() => {
    const holder = document.querySelector('.activity .activity-summary-chips');
    const row = holder?.querySelector('.phase-chips');
    return {
      present: Boolean(row),
      labels: row ? [...row.querySelectorAll('.phase-chip')].map(el => el.textContent) : [],
      active: row?.querySelector('[aria-current="step"]')?.textContent ?? null,
      done: row ? [...row.querySelectorAll('.phase-chip.done')].map(el => el.textContent) : [],
      listRole: row?.getAttribute('role') ?? null,
      listLabel: row?.getAttribute('aria-label') ?? null,
      itemRole: row?.querySelector('.phase-chip')?.getAttribute('role') ?? null,
    };
  });
}

const startTurn = page => page.evaluate(async () => {
  window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
  window.__emit({ type: 'conversation', id: 'c1', items: [] });
  window.__emit({ type: 'user', conversationId: 'c1', item: { id: 'u1', role: 'user', text: 'go' } });
  await window.__frame();
  // modelRoute is the lightest message that opens the activity panel without also starting a task,
  // so it is the only way to observe the first step on its own. A `tool` message calls the same
  // ensureActivity() and would blow straight past it.
  window.__emit({ type: 'modelRoute', conversationId: 'c1', model: 'gpt-5' });
  await window.__frame();
});

test('a fresh run shows Plan as the current step', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await startTurn(page);
  const out = await chips(page);
  assert.equal(out.present, true, 'the activity summary should carry a chip row');
  assert.deepEqual(out.labels, ['Plan', 'Tools', 'Answer']);
  assert.equal(out.active, 'Plan');
  assert.deepEqual(out.done, [], 'nothing is finished on the first step');
  assert.equal(out.listRole, 'list');
  assert.equal(out.listLabel, 'Turn progress');
  assert.equal(out.itemRole, 'listitem', 'each chip must be a listitem or the list is meaningless');
  assert.deepEqual(errors, []);
});

test('once a tool runs, Tools becomes the current step', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await startTurn(page);
  await page.evaluate(async () => {
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'read', name: 'Read', parentId: '' });
    await window.__frame();
  });
  const out = await chips(page);
  assert.equal(out.active, 'Tools');
  assert.deepEqual(out.done, ['Plan'], 'Plan stays done once we have moved past it');
  assert.deepEqual(errors, []);
});

test('the panel closes when the answer starts, and the timeline ends with all three done', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await startTurn(page);
  await page.evaluate(async () => {
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'read', name: 'Read', parentId: '' });
    await window.__frame();
    window.__emit({ type: 'delta', conversationId: 'c1', text: 'Here is' });
    await window.__frame();
  });
  const out = await chips(page);
  assert.deepEqual(out.done, ['Plan', 'Tools', 'Answer'], `expected the whole timeline done, got ${JSON.stringify(out.done)}`);
  assert.equal(out.active, null, 'the panel is closed by the time text streams, so nothing is current');
  assert.deepEqual(errors, []);
});

test('a finished turn marks every chip done and none current', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await startTurn(page);
  await page.evaluate(async () => {
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'read', name: 'Read', parentId: '' });
    window.__emit({ type: 'delta', conversationId: 'c1', text: 'All done.' });
    await window.__frame();
    // `steered` is the plain turn-end path: finish() closes the text and then finishes the activity,
    // which is the transition that has to leave every chip done and none current.
    window.__emit({ type: 'steered', conversationId: 'c1' });
    await window.__frame();
  });
  const out = await chips(page);
  assert.equal(out.present, true, 'the settled panel should still be on screen');
  assert.deepEqual(out.done, ['Plan', 'Tools', 'Answer'], `expected all three done, got ${JSON.stringify(out.done)}`);
  assert.equal(out.active, null, 'a finished turn has no current step');
  assert.deepEqual(errors, []);
});

test('a closed activity panel renders a timeline with no current step', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await startTurn(page);
  await page.evaluate(async () => {
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'read', name: 'Read', parentId: '' });
    await window.__frame();
    // A non-retained error closes the activity panel, which is what pushes it onto closedActivities
    // and re-renders it through buildLiveActivity -- the other of the two chip paths.
    window.__emit({ type: 'error', conversationId: 'c1', text: 'boom' });
    await window.__frame();
  });
  const rows = await page.evaluate(() => {
    const out = [...document.querySelectorAll('.activity .phase-chips')].map(r => ({
      active: r.querySelector('[aria-current="step"]')?.textContent ?? null,
      done: [...r.querySelectorAll('.phase-chip.done')].map(el => el.textContent),
    }));
    return { count: out.length, rows: out };
  });
  assert.ok(rows.count >= 1, `expected a closed timeline to render, found ${rows.count}`);
  for (const row of rows.rows) {
    assert.equal(row.active, null, 'a closed panel has no current step');
    assert.deepEqual(row.done, ['Plan', 'Tools', 'Answer']);
  }
  assert.deepEqual(errors, []);
});