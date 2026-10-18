/**
 * Code blocks and tool cards, in the real webview (Phase 2).
 *
 * The pure tests prove the highlighter cannot corrupt or inject. This one proves the feature is
 * actually *wired*: that a fence becomes a labelled, highlighted block with working controls, and
 * that a tool row grows real args/result/duration. It drives the bundled runtime in headless
 * Chromium, so a control that exists in markup but is never delegated — the usual failure mode for
 * `innerHTML` that streaming rewrites — fails here rather than in the user's window.
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

  const dir = join(tmpdir(), `sleepycode-code-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + file);
  return { browser, page, dir };
}

/** Boots a conversation and streams one assistant answer, then waits for the paint frame. */
async function stream(page, text) {
  await page.evaluate(async body => {
    window.__posted.length = 0;
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
    window.__emit({ type: 'conversation', id: 'c1', items: [] });
    window.__emit({ type: 'user', conversationId: 'c1', item: { id: 'u1', role: 'user', text: 'go' } });
    window.__emit({ type: 'delta', conversationId: 'c1', text: body });
    await window.__frame();
  }, text);
}

test('a fenced block renders labelled, highlighted, with a working copy button', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  const code = 'const greeting = "hi"; // note\nlet n = 42;\n';
  await stream(page, 'Here:\n\n```ts\n' + code + '```\n');

  const shape = await page.evaluate(() => {
    const block = document.querySelector('.code-block');
    return {
      exists: Boolean(block),
      lang: block?.querySelector('.code-lang')?.textContent ?? '',
      keywords: [...(block?.querySelectorAll('.tok-keyword') ?? [])].map(n => n.textContent),
      comments: [...(block?.querySelectorAll('.tok-com') ?? [])].map(n => n.textContent),
      hasCopy: Boolean(block?.querySelector('.code-copy')),
      codeText: block?.querySelector('code')?.textContent ?? '',
      html: block?.innerHTML ?? '',
    };
  });

  assert.ok(shape.exists, 'the fence did not become a code block');
  assert.equal(shape.lang, 'ts', 'the language label should come from the fence info string');
  assert.ok(shape.keywords.includes('const'), `keywords not highlighted: ${JSON.stringify(shape.keywords)}`);
  assert.ok(shape.comments.some(c => c.includes('note')), 'comment not highlighted');
  assert.ok(shape.hasCopy, 'no copy button on the block');
  assert.ok(!shape.html.includes('<b>'), 'raw markup leaked into the block');
  // The copy target must be the exact rendered source, not the tokenised markup. The trailing
  // newline is stripped, which is what the pre-Phase-2 renderer did too: a closing fence always
  // contributes one, so it is an artefact of the fence syntax rather than part of the code.
  assert.equal(shape.codeText, 'const greeting = "hi"; // note\nlet n = 42;');
});

test('an unknown fence language still renders a copyable block, unhighlighted', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  await stream(page, '```brainfuck\n+++.\n```\n');
  const shape = await page.evaluate(() => {
    const block = document.querySelector('.code-block');
    return { exists: Boolean(block), hasCopy: Boolean(block?.querySelector('.code-copy')), tokens: block?.querySelectorAll('.tok-keyword').length ?? -1 };
  });
  assert.ok(shape.exists, 'unknown-language fences must still become blocks');
  assert.ok(shape.hasCopy, 'unknown-language blocks still need a copy button');
  assert.equal(shape.tokens, 0, 'an unsupported language must not be tokenised');
});

test('copy posts the exact source to the host clipboard', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  const code = 'let a = 1;';
  await stream(page, '```js\nlet a = 1;\n```\n');
  await page.click('.code-copy');
  await page.waitForFunction(() => window.__posted.length > 0);

  const posted = await page.evaluate(() => window.__posted.filter(m => m.type === 'copyText'));
  assert.equal(posted.length, 1, 'clicking copy should post exactly one copyText message');
  assert.equal(posted[0].text, code, 'the host must receive the original code, not the tokenised markup');
});

test('a long block collapses and the expand toggle opens it', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  const lines = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n');
  await stream(page, '```js\n' + lines + '\n```\n');

  const before = await page.evaluate(() => ({
    toggle: Boolean(document.querySelector('.code-toggle')),
    expanded: document.querySelector('.code-block')?.classList.contains('expanded') ?? true,
    label: document.querySelector('.code-toggle')?.textContent ?? '',
  }));
  assert.ok(before.toggle, 'a 40-line block should offer an expand toggle');
  assert.equal(before.expanded, false, 'a tall block must start collapsed');
  assert.match(before.label, /40 lines/);

  await page.click('.code-toggle');
  const after = await page.evaluate(() => ({
    expanded: document.querySelector('.code-block')?.classList.contains('expanded') ?? false,
    label: document.querySelector('.code-toggle')?.textContent ?? '',
    aria: document.querySelector('.code-toggle')?.getAttribute('aria-expanded') ?? '',
  }));
  assert.equal(after.expanded, true, 'the toggle did not expand the block');
  assert.equal(after.aria, 'true', 'aria-expanded must track the state');
  assert.equal(after.label, 'Collapse');

  await page.click('.code-toggle');
  const collapsed = await page.evaluate(() => ({
    expanded: document.querySelector('.code-block')?.classList.contains('expanded') ?? true,
    label: document.querySelector('.code-toggle')?.textContent ?? '',
  }));
  assert.equal(collapsed.expanded, false, 'the toggle did not collapse the block again');
  assert.match(collapsed.label, /40 lines/, 'collapsing must restore the row-count label');
});

test('a tool row shows args, result and a real duration, collapsed until asked', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  await page.evaluate(async () => {
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
    window.__emit({ type: 'conversation', id: 'c1', items: [] });
    window.__emit({ type: 'user', conversationId: 'c1', item: { id: 'u1', role: 'user', text: 'go' } });
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'run_command', name: 'Run npm test', args: '{\n  "command": "npm test"\n}' });
    await window.__frame();
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'end', id: 't1', tool: 'run_command', name: 'Run npm test', result: 'FAIL: 1 test failed', durationMs: 1530 });
    await window.__frame();
  });

  const shape = await page.evaluate(() => {
    const row = document.querySelector('.tool');
    const blocks = [...(row?.querySelectorAll('.task-block') ?? [])];
    return {
      duration: row?.querySelector('.task-duration')?.textContent ?? '',
      hasToggle: Boolean(row?.querySelector('.task-detail-toggle')),
      expanded: row?.classList.contains('expanded') ?? true,
      labels: blocks.map(b => b.querySelector('.task-block-label')?.textContent ?? ''),
      visible: blocks.map(b => getComputedStyle(b).display !== 'none'),
      args: blocks[0]?.querySelector('code')?.textContent ?? '',
      result: blocks[1]?.querySelector('code')?.textContent ?? '',
    };
  });

  assert.equal(shape.duration, '1.5s', 'the measured duration should be shown');
  assert.ok(shape.hasToggle, 'a row with args/result needs a Details toggle');
  assert.deepEqual(shape.labels, ['Args', 'Result']);
  assert.ok(shape.visible.every(v => !v), 'args/result must start collapsed so a long run stays readable');
  assert.match(shape.args, /"command": "npm test"/);
  assert.equal(shape.result, 'FAIL: 1 test failed');

  await page.click('.task-detail-toggle');
  const opened = await page.evaluate(() => {
    const row = document.querySelector('.tool');
    return {
      expanded: row?.classList.contains('expanded') ?? false,
      visible: [...row.querySelectorAll('.task-block')].map(b => getComputedStyle(b).display !== 'none'),
      label: row.querySelector('.task-detail-toggle')?.textContent ?? '',
    };
  });
  assert.equal(opened.expanded, true, 'Details did not expand the row');
  assert.ok(opened.visible.every(Boolean), 'expanded blocks must actually be displayed');
  assert.equal(opened.label, 'Hide details');
});

test('args survive the start-to-end update and stay readable', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  // The end event carries no args, so this is the regression guard: a naive re-render would blank
  // the arguments the user is reading at the exact moment the tool finishes.
  const args = '{\n  "path": "src/agent.ts"\n}';
  await page.evaluate(async payload => {
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
    window.__emit({ type: 'conversation', id: 'c1', items: [] });
    window.__emit({ type: 'user', conversationId: 'c1', item: { id: 'u1', role: 'user', text: 'go' } });
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'read_file', name: 'Read agent.ts', args: payload });
    await window.__frame();
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'end', id: 't1', tool: 'read_file', name: 'Read agent.ts', result: 'ok', durationMs: 12 });
    await window.__frame();
  }, args);

  const after = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.task-block')];
    return { count: blocks.length, args: blocks[0]?.querySelector('code')?.textContent ?? '' };
  });
  assert.equal(after.count, 2, 'the end update dropped the Args block');
  assert.match(after.args, /"path": "src\/agent\.ts"/, 'args were blanked by the end update');
});

test('a tool row stays expanded across a live update', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  await page.evaluate(async () => {
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
    window.__emit({ type: 'conversation', id: 'c1', items: [] });
    window.__emit({ type: 'user', conversationId: 'c1', item: { id: 'u1', role: 'user', text: 'go' } });
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'run_command', name: 'Run npm test', args: '{"command":"npm test"}' });
    await window.__frame();
  });
  await page.click('.task-detail-toggle');

  // Any further tool message for the same row re-renders it; the open state must not collapse.
  await page.evaluate(async () => {
    window.__emit({ type: 'tool', conversationId: 'c1', phase: 'end', id: 't1', tool: 'run_command', name: 'Run npm test', result: 'done', durationMs: 900 });
    await window.__frame();
  });
  const expanded = await page.evaluate(() => document.querySelector('.tool')?.classList.contains('expanded') ?? false);
  assert.equal(expanded, true, 'the row collapsed under the user while it updated');
});
