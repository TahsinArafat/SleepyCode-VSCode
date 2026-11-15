/**
 * The React markdown render path stays correct as documents repeat and accumulate.
 *
 * `webview-ui/shared/markdown.ts` caches rendered blocks in a module-level `Map` bounded by an
 * entry cap (240), a byte budget (4 MiB) and a per-entry ceiling (512 KB). The vanilla webview
 * had the same concern in a superseded whole-document cache (`src/webview/markdown-cache.ts`),
 * which went with its 8 unit tests; this file is the React-side replacement for the part of
 * that coverage that is observable from outside the module.
 *
 * HONEST SCOPE: the cache is module-private, and its bounds are invisible from outside --
 * removing the eviction loop entirely still passes everything here, because eviction affects
 * memory, not output. These tests therefore prove *correctness* under repetition, eviction and
 * an oversized entry, not that the cache is bounded. The bounds themselves are asserted as
 * source in `test/lag-regression.direct.mjs`; a behavioural memory bound would need a CDP heap
 * measurement, which this harness does not currently expose.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar } from '../scripts/webview-harness.mjs';

/** Render each document as its own assistant message; report the highlight-token count. */
async function renderAll(app, docs) {
  return app.page.evaluate(async (docs) => {
    const tokens = [];
    for (const text of docs) {
      window.postMessage({ type: 'loadConversation', activeId: 'c1', turns: [
        { role: 'user', text: 'q' + Math.random() },
        { role: 'assistant', blocks: [{ kind: 'text', text }] },
      ], usedTokens: 0, running: false, workspaceRoot: '/repo' }, '*');
      await new Promise(r => setTimeout(r, 200));
      const node = document.querySelectorAll('.markdown-content')[1];
      tokens.push(node ? node.querySelectorAll('[class^="code-token-"]').length : 0);
    }
    return tokens;
  }, docs);
}

const fenceDoc = (i) => `Paragraph ${i} explaining step ${i} of the answer.\n\n\`\`\`ts\nconst v${i} = ${i};\n\`\`\`\n`;

test('repeating one document renders it identically every time', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const doc = fenceDoc(1);
    const tokens = await renderAll(app, [doc, doc, doc, doc, doc]);
    assert.ok(tokens[0] > 0, 'the fence must be highlighted at all');
    assert.deepEqual(tokens, Array(5).fill(tokens[0]), 'a repeat render must not drift');
  } finally {
    await app.close();
  }
});

test('thirty distinct documents each render correctly', async () => {
  // Enough distinct keys to exercise the cache's churn. If eviction removed the entry just
  // inserted, or a byte-accounting bug corrupted `cacheBytes`, output would come back empty or
  // unhighlighted partway through rather than at a clean boundary.
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const docs = Array.from({ length: 30 }, (_, i) => fenceDoc(i));
    const tokens = await renderAll(app, docs);
    assert.equal(tokens.length, docs.length);
    assert.ok(tokens.every(n => n > 0), `every fence must stay highlighted, got ${JSON.stringify(tokens)}`);
  } finally {
    await app.close();
  }
});

test('a document over the per-entry ceiling renders correctly without poisoning the next', async () => {
  // Over MAX_ENTRY_BYTES the entry is returned uncached. Rendering must still be correct, and
  // the following document must be unaffected -- the failure it guards is a byte counter left
  // inconsistent by the skipped entry.
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const huge = 'word '.repeat(120_000); // ~600 KB, over the 512 KB ceiling
    const tokens = await renderAll(app, [huge, fenceDoc(9)]);
    assert.equal(tokens.length, 2);
    assert.ok(tokens[1] > 0, 'the document after an oversized one still renders');
  } finally {
    await app.close();
  }
});