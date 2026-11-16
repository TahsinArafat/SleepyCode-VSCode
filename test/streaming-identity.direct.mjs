/**
 * The incremental DOM build and a fresh mount must produce the same markup.
 *
 * Note what this test is NOT. It is not a comparison of two renderers -- there is only one
 * (`renderMarkdownBlocks`), and both paths call it, so a bug *inside* it (a wrong `dir`, a
 * missing attribute) is invisible here. That is covered by `test/open-fence.direct.mjs`
 * (open vs closed chrome) and `test/markdown-blocks.direct.mjs` (block-splitting rules).
 *
 * What differs between the two paths is how the DOM is built:
 *   - streamed:  deltas accumulate through `applyEvent`, and `MarkdownView` updates a live
 *                root with `patchMarkdownBlocks` (reuse mounted nodes, rebuild only the tail);
 *   - replayed:  a fresh mount appends every block.
 * If those disagree by one attribute, the reader sees the message reflow the moment they
 * reopen the conversation. Verified to catch exactly that class: mutating
 * `patchMarkdownBlocks` to drop the last block on update makes this test FAIL while every
 * other suite passes.
 *
 * The fixtures are the shapes an incremental DOM patcher historically broke on: unterminated
 * fences, blank lines inside a fence, tables, setext headings, display math, a fence
 * lookalike inside math, lists across blank lines. They are the same set the vanilla webview
 * used in `test/streaming-render.direct.mjs`.
 *
 * Two capture rules that matter for honesty: each fixture keys its own conversation, and the
 * selector is scoped to `.msg.assistant` -- during streaming there is no user turn, so a global
 * "last `.markdown-content`" reads the assistant node only after the reload, and silently
 * compares the answer against the question.
 *
 * Everything runs inside ONE page evaluation. A per-fixture round trip costs two React commits
 * plus the harness's settle delays, which exceeds the test timeout.
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSidebar } from '../scripts/webview-harness.mjs';

const FIXTURES = [
  ['plain paragraphs', 'First para.\n\nSecond para.\n\nThird para.\n'],
  ['no trailing newline', 'Only one paragraph, still streaming'],
  ['unterminated fence', 'intro\n\n```ts\nconst a = 1;\nconst b = 2;\n'],
  ['closed fence', 'intro\n\n```ts\nconst a = 1;\n```\n\nafter\n'],
  ['blank lines inside a fence', '```sh\nnpm test\n\nnpm run build\n```\n\ntail\n'],
  ['list across blank lines', '- one\n\n- two\n\ntext\n'],
  ['table then text', '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter table\n'],
  ['heading interrupt', 'para line\n## Heading\n\nbody\n'],
  ['blockquote', '> quoted\n> more\n\nafter\n'],
  ['horizontal rule', 'a\n\n---\n\nb\n'],
  ['display math block', 'before\n\n$$\nx^2\n$$\n\nafter\n'],
  ['single-line display math', '$$x^2$$\n\nafter\n'],
  ['fence lookalike inside math', '$$\n```\n$$\n\nafter\n'],
  ['inline math', 'Energy is $E = mc^2$ exactly.\n'],
  ['prices are not math', 'It costs $5.00 and $10.00 today.\n'],
  ['code reference', 'See src/app.ts:42 for the parser.\n'],
  ['html-ish payload', '<script>alert(1)</script>\n\n<b>bold</b>\n'],
  ['bare url', 'Read https://example.com/docs now.\n'],
  ['empty', ''],
  // Captured MID-STREAM, so a fence is still open at the moment of the capture. This is the
  // case the completed fixtures cannot reach: an open fence renders as escaped text and a
  // closed one as highlighted code, and the two must carry identical chrome or the block
  // reflows when the delimiter lands. `stopAt` is the byte offset to stop feeding deltas.
  ['open fence, captured mid-stream', 'intro\n\n```ts\nconst a = 1;\nlet b = 2;\n', 20],
  ['open fence with no trailing newline', '```sh\nnpm test\n', 12],
  ['open fence after prose', 'Here is the fix:\n\n```ts\nconst a = 1;\n', 30],
  ['open tilde fence mid-stream', '~~~\ncode here\n', 10],
  ['open fence with blank lines', '```sh\nnpm test\n\nnpm run build\n', 24],
  ['text only, captured mid-stream', 'Second para.\n\nThird para still coming\n', 15],
  ['list captured mid-stream', '- one\n\n- two\n\ntext\n', 12],
];

/**
 * For every fixture: stream it as deltas, capture the markup, reload it from history, capture
 * again, and report both plus whether they agree.
 *
 * `stopAt` captures the streamed side PART-WAY through, which is the case that matters for the
 * open-fence path: an unterminated fence renders as escaped text while streaming and as
 * highlighted code once closed, and those two must produce the same chrome or the block
 * reflows the instant the delimiter arrives. A fixture streamed to completion never leaves a
 * fence open, so every check here passed while that branch was untested -- it is why the
 * mid-stream fixtures exist.
 *
 * Each fixture gets its OWN conversation id, so a previous fixture's tab cannot be what the
 * selector reads.
 */
async function compareAll(app) {
  return app.page.evaluate(async (fixtures) => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Scope BOTH captures to the assistant message. While streaming there is no user turn yet,
    // so the transcript holds one `.markdown-content`; after a history reload it holds two (the
    // prompt and the answer). Reading the last node was right only for the reload.
    const assistantMarkup = () => document.querySelector('.msg.assistant .markdown-content')?.innerHTML ?? '';
    const results = [];
    for (let index = 0; index < fixtures.length; index++) {
      const [label, body, stopAt] = fixtures[index];
      const id = 'cmp' + index;
      // A fresh conversation per fixture, so nothing from the previous one is on screen.
      window.postMessage({ type: 'conversations', list: [{ id, title: 'T', updatedAt: 1, archived: false, pinned: false, hasMessages: true, messageCount: 1, changeCount: 0, status: 'done', running: false }], activeId: id, runningConvIds: [] }, '*');
      window.postMessage({ type: 'loadConversation', activeId: id, turns: [], usedTokens: 0, running: false, workspaceRoot: '/repo' }, '*');
      await frame();

      const end = typeof stopAt === 'number' ? Math.min(stopAt, body.length) : body.length;
      // Clamp each slice to `end`. Slicing a full 5 characters past the stop point fed the
      // streamed side a character the replayed side never had, and the mismatch looked like a
      // renderer bug rather than an off-by-five in the probe.
      for (let at = 0; at < end; at += 5) {
        window.postMessage({ type: 'agentEvent', convId: id, event: { type: 'text-delta', text: body.slice(at, Math.min(at + 5, end)) } }, '*');
      }
      await frame();
      const streamed = assistantMarkup();

      // Replay the same PREFIX, so the comparison is like-for-like: the replayed side must be
      // exactly what the streamed side was showing at that instant.
      window.postMessage({ type: 'loadConversation', activeId: id, turns: [
        { role: 'user', text: 'go' },
        { role: 'assistant', blocks: [{ kind: 'text', text: body.slice(0, end) }] },
      ], usedTokens: 0, running: false, workspaceRoot: '/repo' }, '*');
      await frame();
      const replayed = assistantMarkup();

      results.push({ label, empty: !body.slice(0, end).trim(), streamed, replayed });
    }
    return results;
  }, FIXTURES);
}

test('a streamed answer renders exactly like the same answer replayed', async () => {
  const app = await openSidebar({ width: 460, height: 900 });
  try {
    await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'T' }] });
    const results = await compareAll(app);

    const diverged = results
      .filter(r => r.streamed !== r.replayed)
      .map(r => `${r.label}\n    streamed: ${r.streamed.slice(0, 220)}\n    replayed: ${r.replayed.slice(0, 220)}`);
    assert.deepEqual(diverged, [], `streamed and replayed markup diverged:\n  ${diverged.join('\n  ')}`);

    // The comparison would pass vacuously if both sides were empty for everything.
    const blank = results.filter(r => !r.empty && !r.streamed.trim()).map(r => r.label);
    assert.deepEqual(blank, [], `these fixtures rendered nothing, so the comparison proved nothing: ${blank.join(', ')}`);
  } finally {
    await app.close();
  }
});
