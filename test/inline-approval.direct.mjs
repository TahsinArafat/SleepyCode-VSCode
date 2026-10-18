/**
 * Inline approval cards — the trust-critical slice.
 *
 * These drive the real webview in Chromium rather than a stub, because the thing under test is
 * exactly the seam: the card must answer over the *same* `notifyResponse` channel the modal used,
 * so moving the prompt into the transcript cannot change what is allowed to execute.
 *
 * The agent-side gate (`approve` / `reviewEdit`) is unchanged by this work, so these tests assert the
 * property that actually matters: whichever path renders, the reply is one of the same three
 * choices, and nothing renders as actionable after it is decided.
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

  const dir = join(tmpdir(), `sleepycode-approval-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + file);
  return { browser, page, file, dir };
}

const NOTIFY = {
  type: 'notify', id: 7, title: 'Run command', detail: 'This runs the test suite.',
  okLabel: 'Allow once', secondaryLabel: 'Allow this command for session', cancelLabel: 'Deny',
  danger: false, risk: 'medium',
  approval: { id: 7, conversationId: 'c1', kind: 'command', command: 'npm test' },
};

async function prime(page, id = 'c1') {
  await page.evaluate(id => {
    window.__emit({ type: 'conversations', conversations: [{ id, title: 'T', running: false }], activeId: id });
    window.__emit({ type: 'conversation', id, items: [] });
    window.__emit({ type: 'user', conversationId: id, item: { id: id + 'u', role: 'user', text: 'go' } });
  }, id);
}

const choices = page => page.evaluate(() =>
  window.__posted.filter(m => m && m.type === 'notifyResponse').map(m => m.choice));

/** Replay a finished turn that contains a recorded approval. A user message must precede it. */
async function replayApproval(page, decision) {
  await page.evaluate(decision => {
    window.__emit({ type: 'conversations', conversations: [{ id: 'c1', title: 'T', running: false }], activeId: 'c1' });
    window.__emit({
      type: 'conversation', id: 'c1', items: [
        { id: 'u1', role: 'user', text: 'go' },
        {
          id: 'a1', role: 'assistant', text: 'Run command', kind: 'approval',
          approval: { title: 'Run command', kind: 'command', command: 'npm test', risk: 'medium', decision },
        },
      ],
    });
  }, decision);
  await page.evaluate(() => window.__frame());
}

test('an approval renders inline with the real command and all three actions', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
  await prime(page);
  await page.evaluate(m => window.__emit(m), NOTIFY);
  await page.evaluate(() => window.__frame());

  const card = await page.evaluate(() => {
    const card = document.querySelector('.approval-card');
    if (!card) return null;
    return {
      pending: card.classList.contains('pending'),
      live: card.getAttribute('aria-live'),
      title: card.querySelector('.approval-title')?.textContent,
      kind: card.querySelector('.approval-kind')?.textContent,
      risk: card.querySelector('.approval-risk')?.textContent,
      buttons: [...card.querySelectorAll('.approval-actions button')].map(b => b.textContent),
      // The command must be shown as text, not a label — that was the whole point.
      code: card.querySelector('.code-block code')?.textContent,
    };
  });
  assert.ok(card, 'inline approval card should render');
  assert.equal(card.pending, true);
  assert.equal(card.live, 'assertive', 'a blocking decision is not chatter');
  assert.equal(card.title, 'Run command');
  assert.equal(card.kind, 'Command');
  assert.equal(card.risk, 'Review required');
  assert.deepEqual(card.buttons, ['Allow once', 'Allow this command for session', 'Deny']);
  assert.equal(card.code, 'npm test');
});

test('each action replies with the same choice vocabulary the modal used', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  for (const [selector, expected] of [['.approval-ok', 'ok'], ['.approval-secondary', 'secondary'], ['.approval-cancel', 'cancel']]) {
    await page.evaluate(() => { window.__posted.length = 0; });
    await prime(page);
    await page.evaluate(m => window.__emit(m), NOTIFY);
    await page.evaluate(() => window.__frame());
    await page.click(selector);
    await page.evaluate(() => window.__frame());
    assert.deepEqual(await choices(page), [expected], `${selector} should answer '${expected}'`);
    const decided = await page.evaluate(() => {
      const card = document.querySelector('.approval-card');
      return {
        decided: card?.classList.contains('decided'),
        stillActionable: Boolean(card?.querySelector('.approval-actions button')),
        label: card?.querySelector('.approval-decision')?.textContent,
        attribute: card?.dataset.approvalDecision,
      };
    });
    assert.equal(decided.decided, true);
    assert.equal(decided.stillActionable, false, 'a decided card must not stay clickable');
    assert.ok(decided.label, 'the decision must be visible afterwards');
    assert.ok(decided.attribute);
  }
});

test('Escape rejects without executing anything', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
  await prime(page);
  await page.evaluate(m => window.__emit(m), NOTIFY);
  await page.evaluate(() => window.__frame());
  await page.focus('.approval-ok');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__frame());
  assert.deepEqual(await choices(page), ['cancel']);
  const label = await page.evaluate(() => document.querySelector('.approval-card .approval-decision')?.textContent);
  assert.equal(label, 'Rejected');
});

test('a double click cannot resolve the same approval twice', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
  await prime(page);
  await page.evaluate(m => window.__emit(m), NOTIFY);
  await page.evaluate(() => window.__frame());
  await page.evaluate(() => {
    const card = document.querySelector('.approval-card');
    const ok = card.querySelector('.approval-ok');
    const cancel = card.querySelector('.approval-cancel');
    ok.click();
    cancel.click(); // detached with the buttons, but the handler is still attached to it
  });
  // The reply is posted from the awaited continuation, so let the microtask drain before reading.
  await page.evaluate(() => window.__frame());
  assert.deepEqual(await choices(page), ['ok'], 'the first decision wins and the promise resolves once');
});

test('the modal stays the fallback when the card cannot be placed in this transcript', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
  await prime(page, 'c1');
  // Same prompt, but it belongs to a different conversation than the one on screen.
  await page.evaluate(m => window.__emit({ ...m, approval: { ...m.approval, conversationId: 'other' } }), NOTIFY);
  await page.evaluate(() => window.__frame());
  const state = await page.evaluate(() => ({
    inline: Boolean(document.querySelector('.approval-card')),
    modal: document.getElementById('notifyBackdrop')?.classList.contains('open') === true,
  }));
  assert.equal(state.inline, false, 'must not place a card in the wrong transcript');
  assert.equal(state.modal, true, 'must fall back to the modal');
});

test('a persisted approval replays read-only, showing what was granted', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
  await replayApproval(page, 'once');
  const card = await page.evaluate(() => {
    const card = document.querySelector('.approval-card');
    return card ? {
      decided: card.classList.contains('decided'),
      label: card.querySelector('.approval-decision')?.textContent,
      buttons: card.querySelectorAll('.approval-actions button').length,
      code: card.querySelector('.code-block code')?.textContent,
    } : null;
  });
  assert.ok(card, 'a persisted approval must replay');
  assert.equal(card.decided, true);
  assert.equal(card.buttons, 0, 'history must never offer to re-approve something already decided');
  assert.equal(card.label, 'Allowed once');
  assert.equal(card.code, 'npm test');
});

test('a replayed approval grants nothing: nothing was posted back to the host', async t => {
  const { browser, page, dir } = await openComposer();
  t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
  await replayApproval(page, 'rejected');
  // The whole point of recording the decision separately from authorising it: replaying a turn
  // that once contained a granted approval must not re-answer it.
  assert.deepEqual(await choices(page), []);
  const label = await page.evaluate(() => document.querySelector('.approval-card .approval-decision')?.textContent);
  assert.equal(label, 'Rejected');
});