/**
 * Windowing behaviour in the real, shipped sidebar bundle.
 *
 * The transcript used to mount every turn of a conversation: a 1,000-turn chat
 * built ~63,000 DOM nodes and blocked the main thread for ~600 ms on open. It now
 * mounts only the band around the viewport, with height-preserving spacers for the
 * rest. These run against the built bundle because the failure mode is layout, not
 * logic: a wrong spacer height silently breaks scrolling in a way unit tests on the
 * arithmetic cannot see.
 *
 * Requires `npm run build` first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar } from '../scripts/webview-harness.mjs';

const TOTAL = 400;

function transcript(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', text: `Question ${i}` });
    out.push({ role: 'assistant', blocks: [{ kind: 'text', text: `Answer ${i}` }] });
  }
  return out;
}

async function load(app, turns) {
  await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Windowing' }] });
  await app.page.evaluate(items => {
    window.postMessage({ type: 'loadConversation', activeId: 'c1', turns: items, usedTokens: 0, running: false, workspaceRoot: '/tmp/workspace' }, '*');
  }, turns);
  // Two frames: one to commit the window, one to measure and re-window.
  await app.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function counts(app) {
  return app.page.evaluate(() => ({
    mounted: document.querySelectorAll('.chat-turn-group').length,
    nodes: document.getElementsByTagName('*').length,
    spacers: document.querySelectorAll('.turn-spacer').length,
    last: document.querySelector('.chat-turn-group[data-live]')?.textContent ?? '',
  }));
}

test('a long transcript mounts only a window, not every turn', async () => {
  const app = await openSidebar({ width: 460, height: 820 });
  try {
    await load(app, transcript(TOTAL));
    const state = await counts(app);
    assert.ok(state.mounted < 60, `expected a windowed list, mounted ${state.mounted} groups`);
    assert.ok(state.mounted > 0, 'something must be on screen');
    assert.equal(state.spacers, 1, 'the unrendered head is standing in for by exactly one spacer');
    assert.ok(state.nodes < 3000, `expected a small DOM, got ${state.nodes} nodes`);
  } finally {
    await app.close();
  }
});

test('the tail is what opens, so the newest answer is visible', async () => {
  const app = await openSidebar({ width: 460, height: 820 });
  try {
    await load(app, transcript(TOTAL));
    const state = await counts(app);
    assert.match(state.last, new RegExp(`Answer ${TOTAL - 1}`), 'the live group is the newest turn');
  } finally {
    await app.close();
  }
});

test('scrolling to the top reaches the first turn without breaking the window', async () => {
  const app = await openSidebar({ width: 460, height: 820 });
  try {
    await load(app, transcript(TOTAL));
    // Walk up the way a user would, in chunks, letting the window follow. The wheel
    // event is what unsticks follow-mode; setting scrollTop alone gets snapped back
    // to the bottom by the layout effect, which is correct behaviour, not a bug.
    for (let step = 0; step < 40; step++) {
      await app.page.evaluate(() => {
        const pane = document.querySelector('.chat-messages');
        if (!pane) return;
        pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
        pane.scrollTop = Math.max(0, pane.scrollTop - 4000);
      });
      await app.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const top = await app.page.evaluate(() => ({
      mounted: document.querySelectorAll('.chat-turn-group').length,
      first: document.querySelector('.chat-turn-group')?.textContent ?? '',
      nodes: document.getElementsByTagName('*').length,
    }));
    assert.match(top.first, /Question 0\b/, 'the first turn is reachable after scrolling to the top');
    assert.ok(top.mounted < 60, `the window stays bounded while scrolling, mounted ${top.mounted}`);
    assert.ok(top.nodes < 3000, `scrolling must not grow the DOM, got ${top.nodes} nodes`);
  } finally {
    await app.close();
  }
});

test('a short transcript still renders in full, with no spacers', async () => {
  const app = await openSidebar({ width: 460, height: 820 });
  try {
    await load(app, transcript(5));
    const state = await counts(app);
    assert.equal(state.mounted, 5, 'small chats keep exactly the behaviour they had before windowing');
    assert.equal(state.spacers, 0);
  } finally {
    await app.close();
  }
});
