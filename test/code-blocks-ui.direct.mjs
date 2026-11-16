/**
 * Fenced code blocks in the real React webview: the fence must become a
 * labelled, highlighted, copyable block — and a long one must collapse.
 *
 * The vanilla webview's version of this test pinned the same wiring for its
 * own renderer; this port pins the React equivalents, in the live bundle.
 *
 * Tool-card rows (durations, Args/Result toggles) are deliberately NOT here:
 * the React tool card was redesigned and those affordances do not exist on
 * this path.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar, conversation } from '../scripts/webview-harness.mjs';

const ROOT = 'c1';

async function bootWithMarkdown(app, text) {
  await app.boot({ activeId: ROOT, conversations: [conversation(ROOT, 'Code')], openTabs: [ROOT] });
  await app.send({
    type: 'loadConversation',
    activeId: ROOT,
    turns: [
      { role: 'user', text: 'show me some code' },
      { role: 'assistant', blocks: [{ kind: 'text', text }] },
    ],
    usedTokens: 0,
    running: false,
    workspaceRoot: '/tmp/workspace',
  }, 160);
}

test('a fence renders a labelled, highlighted block whose code round-trips', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    const code = 'const greeting = "hi"; // note\nlet n = 42;\n';
    await bootWithMarkdown(app, 'Here:\n\n```ts\n' + code + '```\n');
    const shape = await app.page.evaluate(() => {
      const block = document.querySelector('.code-block');
      return {
        exists: Boolean(block),
        lang: block?.getAttribute('data-lang'),
        chip: block?.querySelector('.code-block-lang')?.textContent ?? '',
        keywords: [...(block?.querySelectorAll('.code-token-keyword') ?? [])].map((n) => n.textContent),
        comments: [...(block?.querySelectorAll('.code-token-comment') ?? [])].map((n) => n.textContent),
        copy: Boolean(block?.querySelector('.code-block-copy')),
        codeText: block?.querySelector('code')?.textContent ?? '',
      };
    });
    assert.ok(shape.exists, 'the fence did not become a code block');
    // `ts` is normalized to typescript; the chip shows the display label.
    assert.equal(shape.lang, 'typescript');
    assert.equal(shape.chip, 'TypeScript');
    assert.ok(shape.keywords.includes('const'), `keywords not highlighted: ${JSON.stringify(shape.keywords)}`);
    assert.ok(shape.comments.some((comment) => comment.includes('note')), 'comment not highlighted');
    assert.equal(shape.copy, true, 'no copy button on the block');
    assert.equal(shape.codeText, 'const greeting = "hi"; // note\nlet n = 42;\n');
  } finally {
    await app.close();
  }
});

test('an unknown fence language still renders a copyable block, unhighlighted', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await bootWithMarkdown(app, '```brainfuck\n+++.\n```\n');
    const shape = await app.page.evaluate(() => {
      const block = document.querySelector('.code-block');
      return {
        exists: Boolean(block),
        copy: Boolean(block?.querySelector('.code-block-copy')),
        tokens: block?.querySelectorAll('.code-token-keyword').length ?? -1,
      };
    });
    assert.ok(shape.exists, 'unknown-language fences must still become blocks');
    assert.equal(shape.copy, true);
    assert.equal(shape.tokens, 0, 'an unsupported language must not be tokenised');
  } finally {
    await app.close();
  }
});

test('clicking copy sends the exact rendered source to the clipboard', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    const code = 'let a = 1;\n';
    await bootWithMarkdown(app, '```js\n' + code + '```\n');
    await app.page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (text) => { window.__copied = text; return true; } },
        configurable: true,
      });
    });
    await app.click('.code-block-copy');
    const copied = await app.page.evaluate(() => ({ text: window.__copied, label: document.querySelector('.code-block-copy')?.textContent ?? '' }));
    // The copy target is the rendered source; the fence contributes one trailing newline.
    assert.equal(copied.text, 'let a = 1;\n');
    assert.equal(copied.label, 'Copied');
  } finally {
    await app.close();
  }
});

test('a long block collapses, and the toggle expands and collapses it again', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    const lines = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n');
    await bootWithMarkdown(app, '```js\n' + lines + '\n```\n');
    const before = await app.page.evaluate(() => ({
      collapsed: document.querySelector('.code-block')?.classList.contains('collapsed') ?? false,
      hasToggle: Boolean(document.querySelector('.code-block-expand')),
      label: document.querySelector('.code-block-expand')?.textContent ?? '',
      aria: document.querySelector('.code-block-expand')?.getAttribute('aria-expanded') ?? '',
    }));
    assert.equal(before.collapsed, true, 'a 40-line block must start collapsed');
    assert.equal(before.hasToggle, true, 'a long block must offer a toggle');
    assert.match(before.label, /40 lines/);
    assert.equal(before.aria, 'false');

    await app.click('.code-block-expand');
    const after = await app.page.evaluate(() => ({
      collapsed: document.querySelector('.code-block')?.classList.contains('collapsed') ?? true,
      label: document.querySelector('.code-block-expand')?.textContent ?? '',
      aria: document.querySelector('.code-block-expand')?.getAttribute('aria-expanded') ?? '',
    }));
    assert.equal(after.collapsed, false, 'the toggle did not expand the block');
    assert.equal(after.label, 'Show less');
    assert.equal(after.aria, 'true');

    await app.click('.code-block-expand');
    const collapsed = await app.page.evaluate(() => ({
      collapsed: document.querySelector('.code-block')?.classList.contains('collapsed') ?? false,
      label: document.querySelector('.code-block-expand')?.textContent ?? '',
    }));
    assert.equal(collapsed.collapsed, true, 'the toggle did not collapse the block again');
    assert.match(collapsed.label, /40 lines/);
  } finally {
    await app.close();
  }
});
