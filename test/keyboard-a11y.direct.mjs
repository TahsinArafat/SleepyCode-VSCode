/**
 * Keyboard navigation & a11y, pinned in the React shell.
 *
 * The legacy vanilla suite drove `src/webview` in Chromium and pinned a set of
 * shell affordances; some of those no longer exist, and pretending otherwise
 * would be pinning fiction. What is here pins what does exist, and records
 * what does not:
 *
 *   1. The shell contributes real keybindings (stop-turn, clear-the-composer).
 *   2. Every picker trigger in the composer names its popover with
 *      aria-controls, and the portal it points at carries the same id.
 *   3. Escape does something defined: with the slash palette open it clears
 *      the invocation (capture phase, before ProseMirror); mid-edit it cancels
 *      the edit. It does NOT stop a running turn — the shell keybinding
 *      ctrl/cmd+. does, and the vanilla "Escape with an empty composer stops
 *      the run" reflex is gone.
 *   4. The slash palette is a listbox that marks one option active for
 *      keyboard users (aria-selected + .active). It is NOT a combobox wired to
 *      the editor, so aria-activedescendant is never used — a genuine step
 *      down from the classic shell, recorded here rather than papered over.
 *   5. The composer no longer states its Enter/Shift+Enter contract in a
 *      visible caption; the ProseMirror keymap (Shift-Enter = newline) and the
      shell keybinding carry the contract instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar, conversation } from '../scripts/webview-harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('package.json'));
const composer = read('webview-ui/sidebar/components/Composer.tsx');
const sidebarCss = read('webview-ui/sidebar/sidebar.css');

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
  assert.match(keys, /ctrl\+alt\+period|cmd\+alt\+period|ctrl\+\.|cmd\+\./i, 'a stop-the-turn shortcut must exist');
  assert.match(keys, /ctrl\+k|cmd\+k/i, 'a clear-the-composer shortcut must exist');
});

test('every picker trigger names the popover it controls with aria-controls', () => {
  // The pickers pair a trigger's aria-controls with the portal's id through a
  // shared useId(). Pin the pairing in source, not one trigger at a time —
  // adding a picker without the pair breaks this immediately.
  const triggers = composer.match(/aria-controls=\{open \? menuId : undefined\}/g) ?? [];
  const portals = composer.match(/id=\{menuId\}/g) ?? [];
  assert.ok(triggers.length >= 7, `expected at least seven paired pickers, found ${triggers.length}`);
  assert.equal(portals.length, triggers.length, 'every trigger must point at a portal with the same id');
  const expanded = composer.match(/aria-expanded=\{open\}/g) ?? [];
  assert.ok(expanded.length >= 7, `every paired trigger must track aria-expanded (found ${expanded.length})`);
});

test('Escape does something defined', () => {
  // Capture-phase Escape: with the slash palette open, Escape clears the
  // invocation before ProseMirror or the submit handler can see the key.
  assert.match(composer, /if \(e\.key === "Escape"\) \{ claim\(\); richEditor\.current\?\.setText\(""\); setSlashText\(""\); \}/);
  // Bubble-phase Escape: mid-edit, Escape cancels the edit.
  assert.match(composer, /} else if \(e\.key === "Escape" && editing\) \{/);
  assert.match(composer, /onCancelEdit\?\.\(\);/);
});

test('the slash palette is a listbox that marks exactly one option active', () => {
  assert.match(composer, /<div className="slash-popup" role="listbox" aria-label="Commands"/);
  assert.match(composer, /role="option"/);
  assert.match(composer, /aria-selected=\{index === slashIndex\}/);
  assert.match(composer, /"slash-item" \+ \(index === slashIndex \? " active" : ""\)/);
  assert.match(sidebarCss, /\.slash-item\.active \{/);
});

test('typing / opens the listbox with exactly one active option', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [conversation('c1', 'Kbd')], openTabs: ['c1'] });
    await app.click('.editor');
    await app.page.keyboard.type('/');
    await app.page.waitForTimeout(160);
    const state = await app.page.evaluate(() => ({
      listbox: Boolean(document.querySelector('[role="listbox"][aria-label="Commands"]')),
      options: document.querySelectorAll('.slash-item').length,
      active: document.querySelectorAll('.slash-item.active').length,
      selected: document.querySelectorAll('.slash-item[aria-selected="true"]').length,
    }));
    assert.equal(state.listbox, true, 'typing / must open the command palette');
    assert.ok(state.options >= 12, `expected at least the twelve commands, found ${state.options}`);
    assert.equal(state.active, 1, 'exactly one option holds keyboard selection');
    assert.equal(state.selected, 1, 'exactly one option is marked via aria-selected');
  } finally {
    await app.close();
  }
});

test('Tab reaches every shell control, so nothing needs a mouse', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [conversation('c1', 'A11y')], openTabs: ['c1'] });
    const seen = [];
    for (let i = 0; i < 40; i += 1) {
      await app.page.keyboard.press('Tab');
      const cls = await app.page.evaluate(() => document.activeElement?.className ?? '');
      if (cls) seen.push(String(cls).split(' ')[0]);
    }
    // The send button is disabled until the composer has content, so a disabled
    // control is legitimately out of the tab order here; pin the rest.
    for (const cls of ['editor', 'ctx-ring', 'hicon', 'model-select', 'attach-btn']) {
      assert.ok(seen.includes(cls), `${cls} should be reachable by Tab (saw ${[...new Set(seen)].join(', ')})`);
    }
  } finally {
    await app.close();
  }
});

test('the model picker opens from the keyboard and returns focus on Escape', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [conversation('c1', 'A11y')], openTabs: ['c1'] });
    await app.page.focus('.model-select');
    await app.page.keyboard.press('Enter');
    await app.page.waitForTimeout(140);
    const opened = await app.page.evaluate(() => ({
      expanded: document.querySelector('.model-select')?.getAttribute('aria-expanded'),
      focusedPlaceholder: document.activeElement?.getAttribute('placeholder') ?? null,
    }));
    assert.equal(opened.expanded, 'true', 'Enter must open the picker');
    assert.equal(opened.focusedPlaceholder, 'Search models', 'the picker must move focus into its search field');
    await app.page.keyboard.press('Escape');
    await app.page.waitForTimeout(140);
    const closed = await app.page.evaluate(() => ({
      expanded: document.querySelector('.model-select')?.getAttribute('aria-expanded'),
      focusIsTrigger: document.activeElement === document.querySelector('.model-select'),
    }));
    assert.equal(closed.expanded, 'false', 'Escape must close the picker');
    assert.equal(closed.focusIsTrigger, true, 'Escape must return focus to the trigger');
  } finally {
    await app.close();
  }
});

test('live regions announce status politely, and the turn phase reaches one', () => {
  // The vanilla suite asserted a single polite status region announced the
  // turn's start and finish. In React the announcement lives in ThinkingStatus
  // (polite, atomic, aria-labelled) and the phase that feeds it comes from the
  // session status; MessageActions carries its own polite region for copy.
  const thinking = read('webview-ui/shared/ThinkingStatus.tsx');
  assert.match(thinking, /role="status" aria-live="polite" aria-atomic="true"/);
  const app = read('webview-ui/sidebar/App.tsx');
  assert.match(app, /<ThinkingStatus text=\{phase\}/);
  const actions = read('webview-ui/sidebar/components/MessageActions.tsx');
  assert.match(actions, /role="status" aria-live="polite"/);
});

test('focus is visible and does not rely on colour alone', () => {
  assert.match(read('webview-ui/sidebar/sidebar.css'), /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--control-ring\)/);
  const theme = read('webview-ui/shared/theme.css');
  assert.match(theme, /@media \(forced-colors: active\)/);
  assert.match(theme, /--control-ring:\s*Highlight/);
});
