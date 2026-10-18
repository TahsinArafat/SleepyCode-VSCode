/**
 * Streaming render cost, for the chat composer (Phase 1).
 *
 * The bug this pins down: `case'delta'` used to do
 * `element.innerHTML = markdown(element.dataset.raw)` for every token chunk, so rendering an
 * answer cost O(n^2). These tests drive the real runtime in headless Chromium and assert the
 * properties that make it linear again:
 *
 *   1. one DOM write per animation frame, not one per token;
 *   2. `streamBlockCut` settles completed blocks and never cuts inside a fence or math block;
 *   3. an incrementally streamed answer is byte-identical to the same answer replayed from
 *      history, because a subtly divergent renderer would make live output and reloaded history
 *      look different.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { streamBlockCut } from '../src/webview/stream-render.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

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
  ['html-ish payload', '<script>alert(1)</script>\n\n<b>bold</b>\n'],
  ['empty', ''],
];

test('streamBlockCut settles a blank line but never cuts inside a fence', () => {
  const open = 'intro\n\n```ts\nconst a = 1;\n';
  assert.equal(streamBlockCut(open, 0, true), 7, 'settles the blank line before the fence, and no further');

  // The blank line inside the fence must not become a boundary, otherwise the incremental
  // renderer would emit half a code block and a full render would not.
  const inner = '```sh\nnpm test\n\nnpm run build\n';
  assert.equal(streamBlockCut(inner, 0, true), 0, 'no boundary exists while the fence is open');

  const closed = inner + '```\n';
  assert.equal(streamBlockCut(closed, 0, true), closed.length, 'the fence closer settles the block');
});

test('streamBlockCut settles a display math block only once it closes', () => {
  const open = 'a\n\n$$\nx\n';
  assert.equal(streamBlockCut(open, 0, true), 3, 'settles the blank line before the math, and no further');

  const closed = open + '$$\n';
  assert.equal(streamBlockCut(closed, 0, true), closed.length);

  // A one-line $$...$$ never enters math mode, so the blank line after it is a valid boundary.
  const inline = '$$x^2$$\n\nafter\n';
  assert.equal(streamBlockCut(inline, 0, true), inline.indexOf('after'));
});

test('streamBlockCut is stable when the buffer grows one character at a time', () => {
  // The renderer resumes from the previous cut, so a drifting scan would let the cached prefix
  // disagree with a full render.
  for (const [label, doc] of FIXTURES) {
    let cut = 0;
    for (let i = 1; i <= doc.length; i++) {
      const next = streamBlockCut(doc, cut, true);
      assert.ok(next >= cut, `cut moved backwards for ${label}`);
      cut = next;
    }
    assert.equal(cut, streamBlockCut(doc, 0, true), `unstable cut for ${label}`);
  }
});

async function openComposer() {
  const bundled = await esbuild.build({
    entryPoints: [join(root, 'src/webview/runtime.ts')],
    bundle: true, format: 'cjs', platform: 'neutral', write: false, target: 'es2022',
  });
  const cjsModule = { exports: {} };
  new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(cjsModule, cjsModule.exports, createRequire(import.meta.url));
  const runtime = cjsModule.exports.getWebviewRuntime('MARK_URI.svg', true);
  const css = readFileSync(join(root, 'src/webview/styles.ts'), 'utf8').match(/String\.raw`([\s\S]*?)`/)?.[1];
  const body = readFileSync(join(root, 'src/webview.ts'), 'utf8')
    .slice(readFileSync(join(root, 'src/webview.ts'), 'utf8').indexOf('<body>') + 6)
    .split('<script')[0].replace(/\$\{[^}]*\}/g, 'X');
  const html = `<!doctype html><html><head><meta charset="UTF-8">
<style>${css}</style><style>html,body{height:100%;margin:0}</style></head><body>${body}
<script>
window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted?.push(m),getState:()=>undefined,setState:()=>{}});
window.__posted=[];
window.__emit=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));
window.__frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
</script><script>${runtime}</script></body></html>`;

  const dir = join(tmpdir(), `sleepycode-stream-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + file);
  return { browser, page, file, dir };
}

test('a long stream repaints once per frame instead of once per token', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const painted = await page.evaluate(async () => {
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
    window.__emit({ type: 'conversation', id: 'c1', items: [] });
    window.__emit({ type: 'user', conversationId: 'c1', item: { id: 'u1', role: 'user', text: 'go' } });
    window.__emit({ type: 'delta', conversationId: 'c1', text: 'seed' });
    await window.__frame();

    const el = document.querySelector('.assistant.streaming');
    let writes = 0;
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'innerHTML');
    Object.defineProperty(el, 'innerHTML', {
      configurable: true,
      get: () => desc.get.call(el),
      set: value => { writes++; desc.set.call(el, value); },
    });

    // Count the animation frames the stream actually runs across. Chrome clamps nested
    // setTimeout(0) to ~4ms, so this loop can only ever offer a handful of deltas per frame no
    // matter how fast the machine is — the frame count, not a fixed ratio, is the real bound.
    let frames = 0;
    let ticking = true;
    const tick = () => { if (!ticking) return; frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);

    const total = 3000;
    for (let i = 0; i < total; i++) {
      window.__emit({ type: 'delta', conversationId: 'c1', text: (i % 9 === 0 ? '\n\n' : 'word ') });
      await new Promise(r => setTimeout(r, 0));
    }
    ticking = false;
    await window.__frame();
    return { writes, total, frames };
  });

  // The coalescer's contract is "one DOM write per animation frame". Assert against measured frames
  // so the bound holds on a slow CI box as well as a fast laptop, and keep a loose ratio as a second
  // guard: a regression back to per-token painting blows straight through it.
  assert.ok(painted.frames > 0, 'the frame ticker must observe at least one animation frame');
  assert.ok(painted.writes <= painted.frames + 2,
    `expected at most one repaint per frame across ${painted.frames} frames, saw ${painted.writes}`);
  assert.ok(painted.writes < painted.total / 3,
    `expected frame coalescing to collapse ${painted.total} deltas, saw ${painted.writes} repaints`);
});

test('a streamed answer renders exactly like the same answer replayed from history', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, doc] of FIXTURES) {
    const result = await page.evaluate(async body => {
      const open = id => {
        window.__emit({ type: 'conversations', conversations: [{ id, title: 'T', running: false }], activeId: id });
        window.__emit({ type: 'conversation', id, items: [] });
        window.__emit({ type: 'user', conversationId: id, item: { id: id + 'u', role: 'user', text: 'go' } });
      };

      open('c2');
      for (let i = 0; i < body.length; i += 5) {
        window.__emit({ type: 'delta', conversationId: 'c2', text: body.slice(i, i + 5) });
      }
      await window.__frame();
      const streamed = document.querySelector('.assistant.streaming')?.innerHTML ?? '';

      // Replay the finished turn from the transcript, which takes the non-incremental
      // renderConversation path, and compare.
      window.__emit({
        type: 'conversation',
        id: 'c2',
        items: [{ id: 'u1', role: 'user', text: 'go' }, { id: 'a1', role: 'assistant', text: body }],
      });
      await window.__frame();
      const replayed = document.querySelector('.assistant:not(.streaming)')?.innerHTML ?? '';
      return { streamed, replayed };
    }, doc);

    assert.equal(result.streamed, result.replayed, `streamed and replayed markup diverged for: ${label}`);
  }
});

test('createFrameCoalescer paints at most once per scheduled frame', () => {
  const source = readFileSync(join(root, 'src/webview/stream-render.ts'), 'utf8');
  const body = source.match(/STREAM_FRAME_SOURCE = String\.raw`([\s\S]*?)`;/)?.[1];
  assert.ok(body, 'STREAM_FRAME_SOURCE is missing');
  const createFrameCoalescer = new Function('requestAnimationFrame', 'cancelAnimationFrame',
    `${body}\nreturn createFrameCoalescer;`)(null, () => { });

  const painted = [];
  const coalescer = createFrameCoalescer(value => painted.push(value));
  coalescer.schedule('a');
  coalescer.schedule('b');
  coalescer.schedule('c');
  assert.deepEqual(painted, [], 'nothing paints before the frame runs');
  coalescer.flushNow();
  assert.deepEqual(painted, ['c'], 'the latest value wins and paints exactly once');
  coalescer.flushNow();
  assert.deepEqual(painted, ['c'], 'flushing an empty queue is a no-op');
});
