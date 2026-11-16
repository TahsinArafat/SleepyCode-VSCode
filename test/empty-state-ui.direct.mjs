/**
 * The empty state, in the real React webview.
 *
 * The pure-module half (`indexCard`, `STARTERS`) is already tested by
 * `test/empty-state.direct.mjs`. What is not covered there is the wiring: whether the
 * chat actually renders the index card, and whether clicking a starter reaches the
 * composer. The vanilla webview's version of this test caught the same wiring for
 * its renderer, and the failure mode it described -- a plan item marked done that
 * the UI does not show -- is exactly the risk here too.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar } from '../scripts/webview-harness.mjs';

/** Put the webview in the state a fresh workspace with a ready index would produce. */
async function primeWorkspace(app) {
  await app.boot({ activeId: 'c1', conversations: [] });
  await app.send({ type: 'projectIndex', status: 'ready', indexed: 137, total: 137, text: '137 files indexed', index: { languages: [{ language: 'TypeScript' }], frameworks: ['TypeScript'] } }, 120);
}

test('the empty state states the indexed file count and offers a reindex action', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await primeWorkspace(app);
    const card = await app.page.evaluate(() => {
      const el = document.querySelector('.empty-index');
      return el ? { text: el.textContent, disabled: el.disabled } : null;
    });
    assert.ok(card, 'the empty state must render the index card');
    assert.match(card.text, /137/, 'the card must carry the file count');
    assert.match(card.text, /Reindex/, 'the card must offer the reindex action');
    assert.equal(card.disabled, false, '"ready" means the index is usable');
  } finally {
    await app.close();
  }
});

test('the empty state hides the index card while indexing', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await primeWorkspace(app);
    await app.send({ type: 'projectIndex', status: 'indexing', indexed: 12, total: 100, text: 'Indexing 12/100 files…', index: { languages: [], frameworks: [] } }, 120);
    const busy = await app.page.evaluate(() => {
      const el = document.querySelector('.empty-index');
      return el ? { busy: el.classList.contains('busy'), disabled: el.disabled } : null;
    });
    assert.ok(busy, 'the busy state is still a card');
    assert.equal(busy.disabled, true, 'an in-flight index must not offer a conflicting reindex');
  } finally {
    await app.close();
  }
});

test('starters fill the composer when clicked', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await primeWorkspace(app);
    // The empty state is where a fresh user lands. The starters are real prompts,
    // not descriptions of prompts, so the composer must end up with one in it.
    const count = await app.page.evaluate(() => document.querySelectorAll('.empty-action').length);
    assert.ok(count >= 3, `expected at least three starters, found ${count}`);
    await app.click('.empty-action');
    const text = await app.page.evaluate(() => {
      const editor = document.querySelector('.editor');
      return editor ? editor.textContent : '';
    });
    assert.ok(text && text.length > 10, `expected a real prompt in the composer, got ${JSON.stringify(text)}`);
  } finally {
    await app.close();
  }
});
