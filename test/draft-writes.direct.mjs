/**
 * Composer draft writes, in the real React webview.
 *
 * Every keystroke used to post the WHOLE drafts map to the host, which merged it and ran a
 * `globalState.update` per character. Typing 30 characters produced 61 posts — twice the
 * keystroke count, because the ProseMirror editor's own `onChange` and the React `onInput`
 * backstop both ran the same refresh/detect/emit trio. The write is now coalesced on a
 * 250 ms debounce and the duplicate path is gone, so the same 30 characters produce one post.
 *
 * The write is deferred; the *draft* is not. These tests pin both halves, because a debounce
 * that loses a draft on tab switch or on submit would be a worse bug than the churn it fixes.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar } from '../scripts/webview-harness.mjs';

const draftPosts = sent => sent.filter(m => m.type === 'updateChatWorkspace' && m.state && m.state.drafts);

async function typeInto(app, text) {
  const editor = await app.page.$('.editor');
  await editor.click();
  await app.page.keyboard.type(text);
}

test('typing a burst of characters coalesces into a single draft write', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Drafts' }] });
    await app.sent(); // discard the boot traffic
    await typeInto(app, 'abcdefghijklmnopqrstuvwxyz');
    await app.page.waitForTimeout(700); // past the 250 ms debounce

    const posts = draftPosts(await app.sent());
    assert.equal(posts.length, 1, `26 keystrokes must coalesce to one write, got ${posts.length}`);
    // The draft the host receives must be the final text, not a truncated first frame.
    const drafts = Object.values(posts[0].state.drafts);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].text, 'abcdefghijklmnopqrstuvwxyz');
  } finally {
    await app.close();
  }
});

test('a deferred draft write is flushed before the webview goes away', async () => {
  // The debounce must not be the only path out. A pane move or window blur has to flush,
  // or a draft typed in the last 250 ms is lost on the next reload.
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Drafts' }] });
    await app.sent();
    await typeInto(app, 'unsaved draft');
    // Blur immediately, well inside the debounce window.
    await app.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await app.page.waitForTimeout(120);

    const posts = draftPosts(await app.sent());
    assert.ok(posts.length >= 1, 'blur must flush the pending draft');
    const drafts = Object.values(posts[posts.length - 1].state.drafts);
    assert.equal(drafts[0].text, 'unsaved draft');
  } finally {
    await app.close();
  }
});

test('a draft follows the user across tabs by default (shared key)', async () => {
  // Coalescing must not merge tabs into one draft: the map is keyed per tab and the host
  // restores each one, so collapsing them would lose the user's other in-progress messages.
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({
      activeId: 'c1',
      conversations: [{ id: 'c1', title: 'One' }, { id: 'c2', title: 'Two' }],
      openTabs: ['c1'],
    });
    await app.sent();
    await typeInto(app, 'carried text');
    await app.page.waitForTimeout(350);

    const posts = draftPosts(await app.sent());
    assert.ok(posts.length >= 1, 'typing must produce a write');
    const last = posts[posts.length - 1].state.drafts;
    const keys = Object.keys(last);
    assert.deepEqual(keys, ['\u0000shared'], 'the default draft key must be the shared one, got ' + JSON.stringify(keys));
    assert.equal(last['\u0000shared'].text, 'carried text');
  } finally {
    await app.close();
  }
});

test('the per-tab drafts setting keys each draft to its own tab', async () => {
  // With `perTabDrafts` on, drafts are keyed by conversation id. This is the setting whose
  // keying a debounce could plausibly break, so it is pinned directly.
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({
      activeId: 'c1',
      conversations: [{ id: 'c1', title: 'One' }, { id: 'c2', title: 'Two' }],
      openTabs: ['c1'],
    });
    await app.send({ type: 'configState', personas: [], activePersonaId: '', hasProviders: true, approvalPolicy: 'ask', uiPrefs: { perTabDrafts: true } }, 150);
    await app.sent();

    await typeInto(app, 'tab one text');
    await app.page.waitForTimeout(350);

    const posts = draftPosts(await app.sent());
    assert.ok(posts.length >= 1, 'typing must produce a write');
    const last = posts[posts.length - 1].state.drafts;
    assert.ok('c1' in last, 'the draft must be keyed to its tab, got ' + JSON.stringify(Object.keys(last)));
    assert.equal(last.c1.text, 'tab one text');
  } finally {
    await app.close();
  }
});
