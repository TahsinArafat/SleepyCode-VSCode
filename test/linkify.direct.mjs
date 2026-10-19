/**
 * Phase 5 — linkify developer references in prose.
 *
 * Before this, `inlineMarkdown` only turned `[label](https://…)` into an anchor. Every other way a
 * developer writes a reference — a bare URL, a `file://` URI, a workspace-relative path, a
 * `path:line` or `path:line:col` — rendered as inert text.
 *
 * The hazard is not "add more regexes", it is *where not to fire*. Two places must stay completely
 * inert, and both are silent failures rather than loud ones:
 *
 *   - Inside a fenced block. `sed -n '30p' src/a.ts` is a command, not a reference. Linkifying it
 *     produces a command with an anchor in the middle of it.
 *   - Inside an inline code span. Same reasoning, and it is the case people hit constantly, because
 *     that is how a path is normally written when talking about it.
 *
 * Inline code is already placeholder-protected upstream (`inlineMarkdown` swaps spans for sentinel
 * tokens before substituting them back), so a new pass that runs on the same protected string cannot
 * corrupt it. Fenced blocks never reach `inlineMarkdown` at all. Both are asserted below rather
 * than assumed.
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

const root = fileURLToPath(new URL('..', import.meta.url));
const MODELS = {
  type: 'models', selected: 'gpt-5',
  groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] }],
};

async function openComposer() {
  const bundled = await esbuild.build({
    entryPoints: [join(root, 'src/webview/runtime.ts')],
    bundle: true, format: 'cjs', platform: 'neutral', write: false, target: 'es2022',
  });
  const cjsModule = { exports: {} };
  new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(cjsModule, cjsModule.exports, createRequire(import.meta.url));
  const runtime = cjsModule.exports.getWebviewRuntime('MARK_URI.svg', true);
  const css = readFileSync(join(root, 'src/webview/styles.ts'), 'utf8').match(/String\.raw`([\s\S]*?)`/)?.[1];
  const wv = readFileSync(join(root, 'src/webview.ts'), 'utf8');
  const body = wv.slice(wv.indexOf('<body>') + 6).split('<script')[0].replace(/\$\{[^}]*\}/g, 'X');
  const html = `<!doctype html><html><head><meta charset="UTF-8">
<style>${css}</style></head><body>${body}
<script>
window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted?.push(m),getState:()=>undefined,setState:()=>{}});
window.__posted=[];
window.__emit=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));
window.__frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
</script><script>${runtime}</script></body></html>`;

  const dir = join(tmpdir(), `sleepycode-linkify-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('file://' + file);
  return { browser, page, dir, errors };
}

const cleanup = (t, browser, dir) => t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

/** Render one assistant turn and read back every developer reference the renderer produced. */
async function refs(page, markdown) {
  return page.evaluate(async ({ markdown, MODELS }) => {
    window.__emit(MODELS);
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
    window.__emit({
      type: 'conversation', id: 'c1', items: [
        { id: 'u1', role: 'user', text: 'go' },
        { id: 'a1', role: 'assistant', text: markdown },
      ]
    });
    await window.__frame();
    const answer = document.querySelector('.assistant');
    return {
      refs: [...answer.querySelectorAll('[data-devref]')].map(el => ({
        text: el.textContent,
        path: el.getAttribute('data-path'),
        line: el.getAttribute('data-line'),
        column: el.getAttribute('data-column'),
      })),
      anchors: [...answer.querySelectorAll('a')].map(el => el.getAttribute('href')),
      fenceText: [...answer.querySelectorAll('pre code')].map(el => el.textContent),
      inlineCode: [...answer.querySelectorAll('p code')].map(el => el.textContent),
      text: answer.innerText,
    };
  }, { markdown, MODELS });
}

test('a bare URL in prose becomes a link', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  const out = await refs(page, 'See https://example.com/docs for details.');
  assert.deepEqual(out.anchors, ['https://example.com/docs'], `expected one anchor, got ${JSON.stringify(out.anchors)}`);
  assert.deepEqual(errors, []);
});

test('a markdown link is not double-wrapped by the bare-URL pass', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  const out = await refs(page, 'Read [the docs](https://example.com/a) now.');
  assert.equal(out.anchors.length, 1, 'a markdown link must produce exactly one anchor, not a nested one');
  assert.equal(out.anchors[0], 'https://example.com/a');
  assert.equal(out.text.includes('Read'), true);
});

test('a workspace-relative path, with or without a line and column, becomes a reference', async t => {
  const { browser, page, dir, errors } = await openComposer();
  cleanup(t, browser, dir);
  const out = await refs(page, 'I changed src/util.ts and src/providers.ts:42 and src/agent.ts:42:7 today.');
  // The visible text stays exactly as written -- dropping the ":42" would silently delete something
  // the author typed. The structured position travels in the attributes instead.
  const found = out.refs.map(r => [r.text, r.path, r.line, r.column]);
  assert.deepEqual(found, [
    ['src/util.ts', 'src/util.ts', null, null],
    ['src/providers.ts:42', 'src/providers.ts', '42', null],
    ['src/agent.ts:42:7', 'src/agent.ts', '42', '7'],
  ], `expected the three paths with their positions, got ${JSON.stringify(found)}`);
  assert.deepEqual(errors, []);
});

test('a file:// URI becomes a reference', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  const out = await refs(page, 'See file:///Users/me/project/src/index.ts:9 for the entry point.');
  assert.equal(out.refs.length, 1, `expected one reference, got ${JSON.stringify(out.refs)}`);
  assert.equal(out.refs[0].path, 'file:///Users/me/project/src/index.ts');
  assert.equal(out.refs[0].line, '9');
});

test('a fenced block stays completely inert', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  const out = await refs(page, 'Run this:\n\n```sh\nsed -n "30p" src/a.ts\ncurl https://example.com/api\n```\n\nThat is all.');
  assert.deepEqual(out.refs, [], `a fenced block must produce no references, got ${JSON.stringify(out.refs)}`);
  assert.deepEqual(out.anchors, [], 'a fenced block must produce no anchors');
  assert.equal(out.fenceText.length, 1, 'the fence should still be rendered as one code block');
  assert.match(out.fenceText[0], /sed -n "30p" src\/a\.ts/);
  assert.match(out.fenceText[0], /https:\/\/example\.com\/api/);
});

test('an inline code span stays inert, because that is how a path is normally written', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  const out = await refs(page, 'Wrap the call in `src/util.ts:42` and pass `https://example.com` through.');
  assert.deepEqual(out.refs, [], `inline code must not linkify, got ${JSON.stringify(out.refs)}`);
  assert.deepEqual(out.anchors, [], 'inline code must not linkify');
  assert.match(out.inlineCode.join(' '), /src\/util\.ts:42/);
});

test('ordinary prose with slashes is not turned into a reference', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  const out = await refs(page, 'Use and/or, i.e. whichever you like, e.g. this one, and see foo/bar/baz in the docs.');
  assert.deepEqual(out.refs, [], `prose must not linkify, got ${JSON.stringify(out.refs)}`);
});

test('clicking a reference asks the host to open that file at that position', async t => {
  const { browser, page, dir } = await openComposer();
  cleanup(t, browser, dir);
  await refs(page, 'Look at src/providers.ts:42:7 please.');
  await page.click('.assistant [data-devref]');
  await page.evaluate(() => window.__frame());
  const posted = await page.evaluate(() => window.__posted.filter(m => m && m.type === 'openFile'));
  assert.equal(posted.length, 1, `expected exactly one openFile message, got ${JSON.stringify(posted)}`);
  assert.equal(posted[0].path, 'src/providers.ts');
  assert.equal(posted[0].line, 42);
  assert.equal(posted[0].column, 7);
});