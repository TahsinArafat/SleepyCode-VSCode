/**
 * Developer references in the React chat, end to end.
 *
 * `src/dev-refs.ts` is already tested directly (`test/dev-refs.direct.mjs`), so this file
 * covers only what that cannot: that the anchors the renderer emits are actually wired to a
 * host message. A reference that renders as a link but does nothing when clicked is the
 * failure mode a pure-module test cannot see, and it is the one a user notices.
 *
 * It replaces `test/linkify.direct.mjs`, which drove the same behaviours through the vanilla
 * webview's DOM. Six of its eight cases duplicated the shared-module tests; the two that did
 * not -- bare-URL linkification and the click-to-host flow -- are covered here against the
 * bundle the extension actually ships.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar } from '../scripts/webview-harness.mjs';

/** Render one assistant message and read back its anchors and references. */
async function render(app, markdown) {
  await app.send({ type: 'loadConversation', activeId: 'c1', turns: [
    { role: 'user', text: 'go' },
    { role: 'assistant', blocks: [{ kind: 'text', text: markdown }] },
  ], usedTokens: 0, running: false, workspaceRoot: '/repo' }, 500);
  return app.page.evaluate(() => {
    const root = document.querySelectorAll('.markdown-content')[1];
    if (!root) return null;
    return {
      anchors: [...root.querySelectorAll('a')].map(a => a.getAttribute('href')),
      refs: [...root.querySelectorAll('[data-open-path]')].map(el => ({
        path: el.getAttribute('data-open-path'),
        line: el.getAttribute('data-line'),
      })),
      code: [...root.querySelectorAll('pre code')].map(el => el.textContent),
    };
  });
}

test('a bare URL in prose becomes a link', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const out = await render(app, 'See https://example.com/docs for details.');
    assert.deepEqual(out.anchors, ['https://example.com/docs']);
  } finally {
    await app.close();
  }
});

test('a markdown link is not wrapped in a second anchor', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const out = await render(app, 'Read [the docs](https://example.com/a) now.');
    assert.equal(out.anchors.length, 1, 'exactly one anchor, not a nested pair');
    assert.equal(out.anchors[0], 'https://example.com/a');
  } finally {
    await app.close();
  }
});

test('a workspace path with a line becomes a reference carrying that line', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const out = await render(app, 'Look at src/app.ts:42 for the parser.');
    assert.deepEqual(out.refs, [{ path: 'src/app.ts', line: '42' }]);
  } finally {
    await app.close();
  }
});

test('a command inside a fenced block stays inert', async () => {
  // `sed -n "30p" src/a.ts` is a command, not a reference. Linkifying inside code would put
  // an anchor in the middle of something the reader is meant to copy.
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const out = await render(app, '```\nsed -n "30p" src/a.ts\n```');
    assert.equal(out.refs.length, 0, 'no reference inside a fence');
    assert.equal(out.anchors.length, 0, 'no anchor inside a fence');
    assert.match(out.code[0] ?? '', /sed -n/);
  } finally {
    await app.close();
  }
});

test('clicking a reference asks the host to open that file at that line', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    await render(app, 'Look at src/app.ts:42 for the parser.');
    await app.sent(); // discard the render traffic

    await app.page.evaluate(() => {
      document.querySelector('[data-open-path]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const posted = await app.sent();
    const open = posted.find(m => m.type === 'openFile');
    assert.ok(open, `a reference click must post openFile, got ${JSON.stringify(posted.map(m => m.type))}`);
    assert.equal(open.path, 'src/app.ts');
    assert.equal(open.startLine, 42, 'the line must survive to the host');
  } finally {
    await app.close();
  }
});

test('a reference is reachable by keyboard, not only by mouse', async () => {
  // `role="link"` with a tabindex is only half a control without Enter. A reader who cannot
  // use a mouse must still be able to open a file the model pointed at.
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const tabindex = await app.page.evaluate(async () => {
      window.postMessage({ type: 'loadConversation', activeId: 'c1', turns: [
        { role: 'user', text: 'go' },
        { role: 'assistant', blocks: [{ kind: 'text', text: 'See src/app.ts:42.' }] },
      ], usedTokens: 0, running: false, workspaceRoot: '/repo' }, '*');
      await new Promise(r => setTimeout(r, 500));
      const ref = document.querySelector('[data-open-path]');
      return { role: ref?.getAttribute('role'), tabindex: ref?.getAttribute('tabindex') };
    });
    assert.equal(tabindex.role, 'link');
    assert.equal(tabindex.tabindex, '0', 'a link that cannot take focus is not a control');
  } finally {
    await app.close();
  }
});