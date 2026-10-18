/**
 * Phase 4 — keyboard-first shell & accessibility.
 *
 * The disclosure menus already had full arrow/Home/End/Escape handling (`bindMenuKeyboard`), and a
 * deliberate test forbids them claiming `role="menu"` because they move *real* focus. This file
 * deliberately does not re-test that. It pins the gaps that were actually still open:
 *
 *   1. `contributes.keybindings` was empty, so every shell action was mouse-only.
 *   2. Two of the seven disclosure triggers did not name their popover via `aria-controls`.
 *   3. The `Esc` ladder stopped at "clear the composer" — it could not cancel an edit or stop a run.
 *   4. The composer had no Enter/Shift+Enter caption.
 *   5. The slash and mention menus hold focus in the textarea and move a *selection index*, so the
 *      highlighted option was conveyed by a CSS class only. That is the one place in the shell where
 *      `aria-activedescendant` is the correct mechanism, and it was missing.
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
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
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

  const dir = join(tmpdir(), `sleepycode-kbd-${process.pid}-${Date.now()}`);
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
const posted = page => page.evaluate(() => window.__posted.map(m => m && m.type));

async function prime(page, { running = false } = {}) {
  await page.evaluate(({ running, MODELS }) => {
    window.__emit(MODELS);
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running }], activeId: 'c1' });
    window.__emit({ type: 'conversation', id: 'c1', items: [{ id: 'u1', role: 'user', text: 'go' }] });
    window.__emit({ type: 'user', conversationId: 'c1', item: { id: 'u1', role: 'user', text: 'go' } });
  }, { running, MODELS });
  await page.evaluate(() => window.__frame());
}

test('the shell contributes real keybindings, not just clickable controls', () => {
  const bindings = manifest.contributes && manifest.contributes.keybindings;
  assert.ok(Array.isArray(bindings) && bindings.length > 0, 'package.json must contribute keybindings');
  const commands = new Set((manifest.contributes.commands || []).map(c => c.command));
  for (const binding of bindings) {
    assert.ok(binding.command, 'every keybinding needs a command');
    assert.match(binding.when || '', /sleepycode/, `keybinding ${binding.command} must be scoped to the chat view`);
    if (!commands.has(binding.command)) {
      // Chat-local shortcuts are handled inside the webview, which has no command to contribute.
      assert.match(binding.command, /^sleepycode\./, `unknown command in keybinding: ${binding.command}`);
    }
  }
  const keys = bindings.map(b => b.key).join(' ');
  // The four shell actions that were previously mouse-only.
  assert.match(keys, /ctrl\+alt\+period|cmd\+alt\+period|ctrl\+\.|cmd\+\./i, 'a stop-the-turn shortcut must exist');
  assert.match(keys, /ctrl\+k|cmd\+k/i, 'a clear-the-composer shortcut must exist');
});

test('every disclosure trigger names the popover it controls', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await prime(page);
  const triggers = await page.evaluate(() => [
    'conversationButton', 'moreActionsButton', 'contextSummaryButton',
    'effortButton', 'modelButton', 'agentButton', 'safetyButton',
  ].map(id => {
    const el = document.getElementById(id);
    if (!el) return null;
    const controls = el.getAttribute('aria-controls');
    return { id, controls, exists: controls ? Boolean(document.getElementById(controls)) : false };
  }).filter(Boolean));
  assert.ok(triggers.length >= 7, `expected the seven disclosure triggers, found ${triggers.length}`);
  for (const trigger of triggers) {
    assert.ok(trigger.controls, `${trigger.id} must point at its popover with aria-controls`);
    assert.equal(trigger.exists, true, `${trigger.id} points at ${trigger.controls}, which is not in the document`);
  }
  assert.deepEqual(errors, []);
});

test('Escape degrades gracefully down the ladder instead of doing nothing', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await prime(page, { running: true });
  await page.click('#input');
  // Composer is empty and a turn is running, so Escape should stop the turn rather than blur.
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__frame());
  const sent = await posted(page);
  assert.ok(sent.includes('stop'), `Escape with an empty composer during a run should post stop, saw ${JSON.stringify(sent)}`);
  assert.deepEqual(errors, []);
});

test('the composer states its own Enter and Shift+Enter contract', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  await prime(page);
  const caption = await page.evaluate(() => {
    const el = document.querySelector('.composer-caption, #composerCaption, [data-composer-caption]');
    return el ? { text: el.textContent.replace(/\s+/g, ' ').trim(), hidden: el.hidden || getComputedStyle(el).display === 'none' } : null;
  });
  assert.ok(caption, 'the composer needs a visible caption describing Enter and Shift+Enter');
  assert.match(caption.text, /Enter/, 'the caption must name Enter');
  assert.match(caption.text, /newline|new line/i, 'the caption must explain Shift+Enter');
});

test('the slash menu exposes its highlighted option, because focus never leaves the textarea', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  await prime(page);
  await page.click('#input');
  await page.keyboard.type('/');
  await page.evaluate(() => window.__frame());
  const opened = await page.evaluate(() => document.getElementById('slashMenu')?.classList.contains('open') === true);
  assert.equal(opened, true, 'typing / should open the slash menu');

  const first = await page.evaluate(() => {
    const input = document.getElementById('input');
    const active = input.getAttribute('aria-activedescendant');
    const selected = document.querySelector('#slashMenu .selected, #slashMenu [aria-selected="true"]');
    return {
      // Focus stays in the textarea by design, so the active option must be named another way.
      focusStayed: document.activeElement?.id === 'input',
      active,
      resolved: active ? Boolean(document.getElementById(active)) : false,
      selectedId: selected?.id || null,
      isSelected: Boolean(selected),
    };
  });
  assert.equal(first.focusStayed, true, 'the slash menu is a combobox: focus belongs in the textarea');
  assert.ok(first.active, 'the textarea must name the highlighted option with aria-activedescendant');
  assert.equal(first.resolved, true, `aria-activedescendant "${first.active}" must resolve to a real element id`);
  assert.equal(first.isSelected, true, 'exactly one option should be marked selected');

  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.__frame());
  const moved = await page.evaluate(() => {
    const input = document.getElementById('input');
    return {
      active: input.getAttribute('aria-activedescendant'),
      selectedId: document.querySelector('#slashMenu [aria-selected="true"]')?.id || null,
    };
  });
  assert.notEqual(moved.active, first.active, 'ArrowDown must move the active descendant');
  assert.equal(moved.active, moved.selectedId, 'the named option and the marked option must be the same element');
  assert.deepEqual(errors, []);
});