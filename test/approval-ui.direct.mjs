/**
 * Approval cards in the React webview.
 *
 * The legacy vanilla test drove `src/webview/runtime.ts` in Chromium and pinned
 * the approval seam: the card answers over the same channel as everything else,
 * and a decided card is dead. The React card speaks a different protocol — it
 * posts `resolveApproval` and the adapter maps that to the host's
 * `notifyResponse` vocabulary ('ok' one-shot, 'cancel' refusal, 'secondary' the
 * session grant); that mapping is pinned by test/webview-adapter.direct.mjs.
 *
 * This test pins what the card itself owes: the command is shown as text, both
 * one-shot choices work, the session grant is only offered when the host sent
 * a secondary suggestion, the card goes decided and stops being clickable, and
 * nothing posts twice after a decision.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 *
 * NOT asserted here, by design:
 *   - Escape-to-reject: no such behaviour exists in the React card.
 *   - A modal fallback for unplaceable prompts: there is no modal. An approval
 *     without a callId pins to the bottom of the ACTIVE transcript, so the same
 *     prompt belonging to another conversation is invisible until that
 *     conversation is opened. Recorded as a gap, not pinned as expected.
 *   - The persisted approval record: `itemsToTurns` projects nothing for
 *     `kind: 'approval'` transcript items, so a reloaded conversation shows no
 *     record of the decision. Same — a gap, not a contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar, conversation } from '../scripts/webview-harness.mjs';

const ROOT = 'c1';

const shellRequest = (requestId, extra = {}) => ({
  requestId,
  convId: ROOT,
  toolName: 'Shell',
  actionType: 'shell',
  subject: 'Run command',
  detail: 'npm test',
  ...extra,
});

async function bootWithApproval(app, request) {
  await app.boot({ activeId: ROOT, conversations: [conversation(ROOT, 'Approval test')], openTabs: [ROOT] });
  await app.send({ type: 'approvalRequest', convId: ROOT, request });
}

test('a live approval renders with the command and both one-shot choices', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootWithApproval(app, shellRequest('7', { suggestion: 'Allow this command for session' }));
    const card = await app.page.evaluate(() => {
      const card = document.querySelector('.approval-card');
      if (!card) return null;
      return {
        title: card.querySelector('.ap-title')?.textContent,
        tool: card.querySelector('.ap-tool')?.textContent,
        detail: card.querySelector('.ap-detail code')?.textContent,
        approve: card.querySelector('.ap-btn.allow')?.textContent,
        reject: card.querySelector('.ap-btn.deny')?.textContent,
      };
    });
    assert.ok(card, 'the approval card must render');
    assert.match(card.title, /Terminal command needs approval/);
    assert.equal(card.tool, 'Shell');
    assert.equal(card.detail, 'npm test', 'the command renders as text, not a bare label');
    assert.equal(card.approve, 'Approve');
    assert.equal(card.reject, 'Reject');
  } finally {
    await app.close();
  }
});

test('approve posts one-shot resolveApproval with no session flag', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootWithApproval(app, shellRequest('7', { suggestion: 'Allow this command for session' }));
    await app.click('.ap-btn.allow');
    assert.deepEqual(await app.sent(), [{ type: 'resolveApproval', requestId: '7', approve: true }]);
  } finally {
    await app.close();
  }
});

test('reject posts a refusal', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootWithApproval(app, shellRequest('7'));
    await app.click('.ap-btn.deny');
    assert.deepEqual(await app.sent(), [{ type: 'resolveApproval', requestId: '7', approve: false }]);
  } finally {
    await app.close();
  }
});

test('a decided card shows what happened and offers nothing to click', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootWithApproval(app, shellRequest('7', { suggestion: 'Allow this command for session' }));
    await app.click('.ap-btn.allow');
    const decided = await app.page.evaluate(() => ({
      card: Boolean(document.querySelector('.approval-card.decided')),
      text: document.querySelector('.approval-card.decided')?.textContent ?? '',
      buttons: document.querySelectorAll('.approval-card.decided .ap-btn').length,
      menus: document.querySelectorAll('.approval-card.decided .ap-menu-item').length,
    }));
    assert.equal(decided.card, true, 'the card stays in place and says what happened');
    assert.match(decided.text, /Approved/);
    assert.equal(decided.buttons, 0, 'history never re-offers the decision');
    assert.equal(decided.menus, 0);
  } finally {
    await app.close();
  }
});

test('a decide click posts exactly one message', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootWithApproval(app, shellRequest('7'));
    await app.click('.ap-btn.allow');
    const posted = await app.sent();
    assert.equal(posted.length, 1, 'the first decision is the only one posted');
    assert.equal(posted[0].type, 'resolveApproval');
  } finally {
    await app.close();
  }
});

test('the session grant is offered only when the host sent a suggestion', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    // No suggestion: the menu holds only Behavior settings, and no grant beyond one-shot.
    await bootWithApproval(app, shellRequest('7'));
    await app.click('.ap-arrow');
    const bare = await app.page.evaluate(() =>
      [...document.querySelectorAll('.ap-menu-item')].map((el) => el.textContent?.trim()),
    );
    assert.deepEqual(bare, ['Behavior settings…']);
    await app.click('.ap-arrow');
  } finally {
    await app.close();
  }
});

test('the session grant posts session:true with the one-shot flag', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootWithApproval(app, shellRequest('7', { suggestion: 'Allow this command for session' }));
    await app.click('.ap-arrow');
    await app.page.evaluate(() => {
      const item = [...document.querySelectorAll('.ap-menu-item')].find((el) =>
        el.textContent?.includes('Allow this command for session'),
      );
      item?.click();
    });
    assert.deepEqual(await app.sent(), [{ type: 'resolveApproval', requestId: '7', approve: true, session: true }]);
  } finally {
    await app.close();
  }
});

test('the session-grant item is labelled with the suggestion the host sent', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootWithApproval(app, shellRequest('7', { suggestion: 'Allow this command for session' }));
    await app.click('.ap-arrow');
    const items = await app.page.evaluate(() =>
      [...document.querySelectorAll('.ap-menu-item')].map((el) => el.textContent?.trim()),
    );
    assert.deepEqual(items, ['Allow this command for session', 'Behavior settings…']);
  } finally {
    await app.close();
  }
});
