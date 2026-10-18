/**
 * Keyboard-first shell.
 *
 * Every test here drives the real webview with the keyboard only — no programmatic .click() for the
 * interaction under test, because the bug this phase fixes is precisely that things worked by mouse
 * and silently did not by keyboard. Mouse clicks appear only to set up unrelated state.
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

const MODELS = {
  type: 'models', selected: 'gpt-5',
  groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'gpt-5-mini', name: 'GPT-5 mini' }] }],
};

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

  const dir = join(tmpdir(), `sleepycode-a11y-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('file://' + file);
  await page.evaluate(m => {
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
    window.__emit({ type: 'conversation', id: 'c1', items: [] });
    window.__emit(m);
  }, MODELS);
  await page.evaluate(() => window.__frame());
  return { browser, page, dir, errors };
}

const cleanup = (t, browser, dir) => t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
const active = page => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'BODY';
  return { id: el.id || '', cls: String(el.className || ''), role: el.getAttribute('role'), text: (el.textContent || '').trim().slice(0, 24) };
});
const isOpen = (page, id) => page.evaluate(id => document.getElementById(id)?.classList.contains('open') === true, id);

test('Tab reaches every control and cycles, so nothing is unreachable without a mouse', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  const seen = [];
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    const el = await active(page);
    if (el !== 'BODY') seen.push(el.id || el.cls);
  }
  for (const id of ['conversationButton', 'undoButton', 'redoButton', 'newConversation', 'moreActionsButton', 'input', 'attachButton', 'modelButton', 'agentButton', 'safetyButton', 'send']) {
    assert.ok(seen.includes(id), `${id} should be reachable by Tab`);
  }
});

test('the model menu opens from the keyboard, moves with arrows, and Escape returns focus to its trigger', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await page.focus('#modelButton');

  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__frame());
  assert.equal(await isOpen(page, 'modelMenu'), true, 'Enter should open the menu');
  assert.equal(await page.getAttribute('#modelButton', 'aria-expanded'), 'true', 'aria-expanded must track the open state');

  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.__frame());
  const first = await active(page);
  assert.match(first.cls, /model-option/, 'ArrowDown should move focus onto the first model, not the search box');
  assert.equal(await isOpen(page, 'modelMenu'), true);

  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.__frame());
  const second = await active(page);
  assert.notEqual(second.text, first.text, 'a second ArrowDown should move to the next model');

  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__frame());
  assert.equal(await isOpen(page, 'modelMenu'), false, 'Escape should close the menu');
  assert.equal((await active(page)).id, 'modelButton', 'focus must return to the trigger, not to <body>');
  assert.equal(await page.getAttribute('#modelButton', 'aria-expanded'), 'false');
  assert.deepEqual(errors, []);
});

test('arrow keys on a closed trigger open the menu without needing Enter first', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  await page.focus('#modelButton');
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.__frame());
  assert.equal(await isOpen(page, 'modelMenu'), true);
  assert.match((await active(page)).cls, /model-option/);
});

test('every disclosure trigger exposes a name and a relationship to its popover', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  const triggers = await page.evaluate(() => ['conversationButton', 'moreActionsButton', 'contextSummaryButton', 'effortButton', 'safetyButton', 'modelButton', 'agentButton'].map(id => {
    const el = document.getElementById(id);
    const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
    return { id, name, hasPopup: el.getAttribute('aria-haspopup'), expanded: el.getAttribute('aria-expanded'), controls: el.getAttribute('aria-controls') };
  }));
  for (const trigger of triggers) {
    assert.ok(trigger.name, `${trigger.id} needs an accessible name`);
    assert.equal(trigger.hasPopup, 'true', `${trigger.id} should advertise that it opens something`);
    assert.equal(trigger.expanded, 'false', `${trigger.id} should start collapsed`);
  }
  // aria-controls is present where the popover is a sibling we can name.
  for (const id of ['modelButton', 'agentButton', 'effortButton', 'safetyButton']) {
    const trigger = triggers.find(item => item.id === id);
    assert.ok(trigger.controls, `${id} should point at its popover with aria-controls`);
  }
});

test('a popover does not claim ARIA menu semantics it does not implement', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  // role="menu" promises arrow navigation and roving tabindex. These are disclosure popovers with
  // ordinary buttons, so they must not claim the role.
  const menus = await page.evaluate(() => [...document.querySelectorAll('#modelMenu,#agentMenu,#safetyMenu,#effortMenu,#conversationMenu,#moreActionsMenu')]
    .map(el => ({ id: el.id, role: el.getAttribute('role') })));
  assert.ok(menus.length > 0);
  for (const menu of menus) assert.notEqual(menu.role, 'menu', `${menu.id} must not claim role=menu`);
});

test('the modal traps focus while open and hands it back to where it was', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  await page.focus('#input');
  await page.evaluate(() => window.__emit({ type: 'notify', id: 1, title: 'Delete?', detail: 'x', okLabel: 'Delete', cancelLabel: 'Cancel', danger: true, risk: 'high' }));
  await page.evaluate(() => window.__frame());

  const opened = await active(page);
  assert.ok(['notifyOk', 'notifyCancel'].includes(opened.id), 'a blocking modal must move focus inside itself');
  const named = await page.evaluate(() => ['notifyOk', 'notifyCancel'].map(id => (document.getElementById(id).textContent || '').trim()));
  assert.deepEqual(named, ['Delete', 'Cancel'], 'the modal buttons must be labelled with their real actions');

  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__frame());
  assert.equal((await active(page)).id, 'input', 'focus must return to whatever had it before the modal');
});

test('an inline approval returns focus when it is decided', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  await page.evaluate(() => window.__emit({ type: 'user', conversationId: 'c1', item: { id: 'u1', role: 'user', text: 'go' } }));
  await page.focus('#input');
  await page.evaluate(() => window.__emit({
    type: 'notify', id: 2, title: 'Run command', detail: 'd', okLabel: 'Allow once', cancelLabel: 'Deny', risk: 'medium',
    approval: { id: 2, conversationId: 'c1', kind: 'command', command: 'npm test' },
  }));
  await page.evaluate(() => window.__frame());
  assert.match((await active(page)).cls, /approval-ok/, 'focus should move to the primary action');

  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__frame());
  assert.equal((await active(page)).id, 'input', 'focus must not be stranded after rejecting');
});

test('turn progress is announced, because the spinner and send icon are purely visual', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  const status = () => page.evaluate(() => {
    const el = document.getElementById('turnStatus');
    return el ? { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), text: (el.textContent || '').trim() } : null;
  });
  const region = await status();
  assert.ok(region, 'a status region must exist');
  assert.equal(region.role, 'status');
  assert.equal(region.live, 'polite');

  await page.evaluate(() => window.__emit({ type: 'state', running: true, conversationId: 'c1' }));
  await page.evaluate(() => window.__frame());
  assert.match((await status()).text, /Working/, 'starting a turn should announce that it started');

  await page.evaluate(() => window.__emit({ type: 'state', running: false, conversationId: 'c1' }));
  await page.evaluate(() => window.__frame());
  assert.match((await status()).text, /complete/i, 'finishing should announce that it finished');
});

test('focus is visible and does not rely on colour alone', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  // :focus-visible deliberately ignores programmatic focus, so reach the composer the way a user
  // would. Tabbing there is the case the ring exists for.
  const reached = await page.evaluate(() => {
    const el = document.getElementById('input');
    el.focus();
    return document.activeElement === el;
  });
  assert.equal(reached, true);
  await page.evaluate(() => document.getElementById('input').blur());
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    if ((await active(page)).id === 'input') break;
  }
  const ring = await page.evaluate(() => {
    const el = document.getElementById('input');
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle, matches: el.matches(':focus-visible') };
  });
  assert.equal(ring.matches, true, 'the focused composer should match :focus-visible when reached by keyboard');
  assert.notEqual(ring.style, 'none', 'the focused control must draw an outline');
  assert.ok(parseFloat(ring.width) >= 2, `focus outline should be thick enough to see, got ${ring.width}`);
});

test('forced-colors mode still draws a visible focus ring', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  await page.emulateMedia({ forcedColors: 'active' });
  await page.focus('#input');
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('input'));
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  assert.notEqual(ring.style, 'none', 'high-contrast users must still see focus');
});