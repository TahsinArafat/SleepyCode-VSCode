/**
 * The host refunds a failed send's text via `queueDraft`. This pins the two
 * rules that protect the user's own typing:
 *
 *   1. an empty composer gets the refund — the words are not lost;
 *   2. a composer the user has typed into since does NOT get overwritten.
 *
 * The cross-conversation case (shared draft mode) is covered by the same rule:
 * there is nowhere safe to park the refund, so it is dropped rather than
 * written over this chat's words or another chat's.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar, conversation } from '../scripts/webview-harness.mjs';

const ROOT = 'c1';

async function bootComposer(app) {
  await app.boot({ activeId: ROOT, conversations: [conversation(ROOT, 'Drafts')], openTabs: [ROOT] });
}

const editorText = (page) => page.evaluate(() => document.querySelector('.editor')?.textContent ?? '');

test('a failed send refunds an empty composer', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootComposer(app);
    await app.send({ type: 'queueDraft', convId: ROOT, draft: { text: 'refund the prompt', attachments: [] } }, 180);
    assert.equal(await editorText(app.page), 'refund the prompt');
  } finally {
    await app.close();
  }
});

test('a refund never overwrites what the user typed since', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootComposer(app);
    await app.click('.editor');
    await app.page.keyboard.type('my own words');
    await app.page.waitForTimeout(120);
    await app.send({ type: 'queueDraft', convId: ROOT, draft: { text: 'refund the prompt', attachments: [] } }, 180);
    assert.equal(await editorText(app.page), 'my own words');
  } finally {
    await app.close();
  }
});

test('a refund for a conversation that is not open is not written into this one', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootComposer(app);
    await app.send({ type: 'queueDraft', convId: 'other', draft: { text: 'other chat refund', attachments: [] } }, 180);
    assert.equal(await editorText(app.page), '');
  } finally {
    await app.close();
  }
});
