/**
 * The open code fence, in the real React webview.
 *
 * While a reply streams inside a code fence the fence has no closing delimiter yet. The
 * renderer emits it as escaped text instead of highlighted code, because a highlighted
 * fence is ~9,853 DOM elements at 64k characters versus 7 escaped, and `sanitize` pays per
 * element: measured 6,262 ms versus 178 ms to stream the same 64k fence. The highlight is
 * thrown away on the next delta anyway, since the block's cache key is its raw text.
 *
 * What that optimisation must NOT change is the block the reader sees. These tests drive
 * the bundled React webview in headless Chromium and compare the open fence against the
 * same fence once closed: same chrome, same controls, same collapse state. A mismatch here
 * is a visible reflow at the moment the delimiter arrives, which is exactly the bug this
 * pins — the first version of the fix omitted `dir` on `<code>` and failed this comparison.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar } from '../scripts/webview-harness.mjs';

/** Mount an assistant message and describe the code block it renders. */
async function mountAndRead(app, text) {
  await app.send({ type: 'loadConversation', activeId: 'c1', turns: [
    { role: 'user', text: 'show me' },
    { role: 'assistant', blocks: [{ kind: 'text', text }] },
  ], usedTokens: 0, running: false, workspaceRoot: '/repo' }, 320);
  return app.page.evaluate(() => {
    const block = document.querySelector('.code-block');
    if (!block) return null;
    return {
      language: block.getAttribute('data-lang'),
      chip: block.querySelector('.code-block-lang')?.textContent ?? null,
      copy: !!block.querySelector('.code-block-copy'),
      expand: block.querySelector('.code-block-expand')?.textContent ?? null,
      collapsed: block.classList.contains('collapsed'),
      preDir: block.querySelector('pre')?.getAttribute('dir') ?? null,
      codeDir: block.querySelector('code')?.getAttribute('dir') ?? null,
      codeClass: block.querySelector('code')?.getAttribute('class') ?? null,
      codeText: block.querySelector('code')?.textContent ?? null,
      tokens: block.querySelectorAll('span[class^="code-token"]').length,
    };
  });
}

const describe = fields => JSON.stringify(fields);
const OPEN = 'Here is the fix:\n\n```ts\nconst a = 1;\nlet b = 2;\n';

test('an open fence and the same fence closed render the same block chrome', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Fence' }] });
    const open = await mountAndRead(app, OPEN);
    const closed = await mountAndRead(app, `${OPEN}\`\`\`\n`);
    assert.ok(open && closed, 'both shapes must render a code block');

    // Everything the reader sees or interacts with, compared field by field so a failure
    // names the attribute that diverged rather than dumping two blobs.
    for (const field of ['language', 'chip', 'copy', 'expand', 'collapsed', 'preDir', 'codeDir', 'codeClass', 'codeText']) {
      assert.equal(open[field], closed[field], `${field} must not change when the fence closes`);
    }
  } finally {
    await app.close();
  }
});

test('an open fence is escaped text, not highlighted code', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Fence' }] });
    const open = await mountAndRead(app, OPEN);
    const closed = await mountAndRead(app, `${OPEN}\`\`\`\n`);
    assert.equal(open.tokens, 0, 'an open fence must not carry highlight spans');
    assert.ok(closed.tokens > 0, 'a closed fence must be highlighted');
  } finally {
    await app.close();
  }
});

test('a long open fence keeps the collapse control the closed one has', async () => {
  // The collapse threshold is 24 lines. If the open fence omitted the control the block
  // would jump from expanded to collapsed the moment the delimiter landed.
  const body = 'const value = 1;\n'.repeat(40);
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Fence' }] });
    const open = await mountAndRead(app, `\`\`\`ts\n${body}`);
    const closed = await mountAndRead(app, `\`\`\`ts\n${body}\`\`\`\n`);
    assert.match(String(open.expand), /Show all 40 lines/, 'the open fence must offer the collapse control');
    assert.equal(open.expand, closed.expand);
    assert.equal(open.collapsed, closed.collapsed);
  } finally {
    await app.close();
  }
});

test('an open fence stays cheap as it grows, because it is never highlighted', async () => {
  // The regression this guards: re-highlighting a growing fence on every delta is
  // quadratic and was 30-35x the cost of escaping it. Node count is the signal, because
  // `sanitize` pays per element. A short fence and a long one must stay in the same order
  // of magnitude; the highlighted version grows into the thousands.
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Fence' }] });
    const small = await app.page.evaluate(async () => {
      window.postMessage({ type: 'loadConversation', activeId: 'c1', turns: [
        { role: 'user', text: 'q' },
        { role: 'assistant', blocks: [{ kind: 'text', text: '```ts\n' + 'const a = 1;\n'.repeat(5) }] },
      ], usedTokens: 0, running: false, workspaceRoot: '/repo' }, '*');
      await new Promise(r => setTimeout(r, 300));
      return document.querySelector('.code-block')?.getElementsByTagName('*').length ?? 0;
    });
    const big = await app.page.evaluate(async () => {
      window.postMessage({ type: 'loadConversation', activeId: 'c1', turns: [
        { role: 'user', text: 'q' },
        { role: 'assistant', blocks: [{ kind: 'text', text: '```ts\n' + 'const a = 1;\n'.repeat(1200) }] },
      ], usedTokens: 0, running: false, workspaceRoot: '/repo' }, '*');
      await new Promise(r => setTimeout(r, 400));
      return document.querySelector('.code-block')?.getElementsByTagName('*').length ?? 0;
    });
    assert.ok(small > 0 && big > 0, 'both fences must render');
    // Fixed chrome only: the wrapper, head, chip, copy control, pre, code. A 240x larger
    // fence must not multiply the element count, which is what highlighting would do.
    assert.ok(big < 40, `an open fence must stay element-flat, got ${big} elements`);
    assert.ok(big - small < 20, `element count must not grow with fence size (${small} -> ${big})`);
  } finally {
    await app.close();
  }
});
