import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/webview.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/webview/runtime.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/webview/styles.ts', import.meta.url), 'utf8');

test('the sheet has no stray backtick that would truncate String.raw', () => {
  // styles.ts is a String.raw template. A backtick in a comment silently truncates
  // the stylesheet at that point — every rule after it stops shipping.
  const src = styles;
  const start = src.indexOf('`', src.indexOf('String.raw')) + 1;
  const end = src.lastIndexOf('`');
  const inner = src.slice(start, end);
  assert.equal(inner.includes('`'), false, 'no backticks may appear inside the stylesheet template');
});

test('the top bar keeps three actions inline and the rest behind a menu', () => {
  // Six identical ghost icons gave no clue which was which and crowded the title.
  assert.match(html, /id="moreActionsButton"/);
  assert.match(html, /id="moreActionsMenu"/);
  for (const id of ['usageButton', 'marketplaceButton', 'settingsButton']) {
    // Attribute order is class -> data-top-group -> id, so match the whole tag.
    const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
    assert.match(tag, /class="chat-more-item"/, `${id} belongs in the overflow menu`);
    assert.match(tag, /data-top-group="more"/, `${id} is grouped under More`);
  }
  // High-frequency actions stay inline.
  for (const id of ['undoButton', 'redoButton', 'newConversation']) {
    assert.ok(html.includes(`id="${id}"`), `${id} stays inline`);
  }
});

test('the overflow menu opens, closes, and exposes its items as labelled rows', () => {
  assert.match(runtime, /function setMoreMenuOpen/);
  assert.match(runtime, /moreBtn\.setAttribute\('aria-expanded'/);
  assert.match(runtime, /chat-more-label/);
  assert.match(styles, /\.chat-more-menu\.open\{display:block\}/);
  assert.match(styles, /\.chat-more-item\{/);
});

test('composer overrides are declared after the narrow-width media blocks', () => {
  // A later @media beats an earlier unqualified rule at equal specificity; placing
  // these before the existing blocks silently reintroduced the truncation.
  const oldCap = styles.indexOf('.composer .actions .context-summary{max-width:72px}');
  const newCap = styles.indexOf('max-width:104px');
  assert.ok(newCap > oldCap, 'the Context cap override must come after the old one');
  const oldModel = styles.indexOf('.composer .actions .model-pill,.composer .actions .agent-pill{max-width:112px}');
  const newModel = styles.indexOf('max-width:min(160px,42vw)');
  assert.ok(newModel > oldModel, 'the model pill override must come after the old one');
});

test('the empty state is centred without clipping its starter cards', () => {
  // place-items:center in a scroll container pins tall content above the fold.
  assert.match(styles, /\.empty\{[^}]*display:block/);
  assert.match(styles, /\.empty-inner\{[^}]*justify-content:center/);
  assert.match(styles, /\.starter-card\{/);
});
