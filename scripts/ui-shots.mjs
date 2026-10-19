/**
 * Visual regression harness for the chat webview.
 *
 * The webview is plain browser JS (src/webview/runtime.ts) wrapped in a shell
 * (src/webview.ts), so it can be rendered outside VS Code: bundle the runtime, take
 * the real stylesheet and real body markup, stub `acquireVsCodeApi`, then drive it
 * with sample messages. What this screenshots is the shipping UI, not a mock of it.
 *
 * Usage:
 *   node scripts/ui-shots.mjs            # write screenshots to .ui-shots/
 *   node scripts/ui-shots.mjs --check    # fail on overflow/console errors (for CI)
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPage, root } from './webview-harness.mjs';

const check = process.argv.includes('--check');
const outDir = join(root, '.ui-shots');
const work = join(tmpdir(), 'sleepycode-ui-shots');

const WIDTHS = [
  { tag: 'sm', width: 360, height: 780 },
  { tag: 'md', width: 460, height: 900 },
  { tag: 'lg', width: 720, height: 900 },
];

const SAMPLE = [
  { role: 'user', text: 'Why is the auth refresh loop firing twice on startup?', timestamp: 1 },
  { role: 'assistant', timestamp: 2, model: 'claude-sonnet', text:
    "Because `refreshIfStale()` is called from two independent paths during activation, and neither marks the token as refreshed until the HTTP call returns.\n\n"
    + "In `src/sleepyai.ts:212` the activation handler awaits the refresh, while the provider constructor at `:340` fires the same call without awaiting. Both see a stale token, both refresh, and the second races the first write:\n\n"
    + "```ts\nasync refreshIfStale() {\n  if (!this.stale()) return;\n  await this.refresh();   // not idempotent\n}\n```\n\n"
    + "Make the refresh idempotent so both callers collapse into one:\n\n"
    + "```ts\nprivate inflight?: Promise<void>;\nrefresh(): Promise<void> {\n  return (this.inflight ??= this.doRefresh()\n    .finally(() => { this.inflight = undefined; }));\n}\n```\n\n"
    + 'Want me to apply that?' },
  // An error always follows a user turn, which is the shape renderConversation expects.
  { role: 'user', text: 'Now run the tests.', timestamp: 3 },
  { role: 'assistant', kind: 'error', timestamp: 4,
    errorInfo: { code: 'provider_error', title: 'Request failed', message: 'The model stopped because the provider reported a generation error.' },
    text: 'The model stopped because the provider reported a generation error.' },
];

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
if (!check) { rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true }); }

const html = await buildPage();
const browser = await chromium.launch();
const failures = [];

for (const { tag, width, height } of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));

  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  // The shipped HTML carries a static empty placeholder that only the runtime's
  // emptyState() replaces, and that runs when a conversation renders with no items.
  // Drive that path so the screenshot shows the real empty screen (starter cards,
  // project intelligence) rather than the shell fallback.
  await page.evaluate(() => {
    window.__emit({ type: 'project', name: 'sleepycode', path: '/repo' });
    window.__emit({ type: 'conversations', conversations: [
      { id: 'c1', title: 'Empty', status: 'empty', running: false, messageCount: 0, changeCount: 0, pinned: false, archived: false },
    ] });
    window.__emit({ type: 'conversation', conversationId: 'c1', items: [], running: false, label: '' });
  });
  await page.waitForTimeout(400);
  if (!check) await page.screenshot({ path: join(outDir, `${tag}-empty.png`) });

  await page.evaluate(items => {
    window.__emit({ type: 'project', name: 'sleepycode', path: '/repo' });
    window.__emit({ type: 'conversations', conversations: [
      { id: 'c1', title: 'Auth refresh loop', status: 'done', running: false, messageCount: 3, changeCount: 0, pinned: false, archived: false },
    ] });
    window.__emit({ type: 'conversation', conversationId: 'c1', items, running: false, label: '' });
  }, SAMPLE);
  await page.waitForTimeout(400);
  if (!check) await page.screenshot({ path: join(outDir, `${tag}-conversation.png`) });

  // Horizontal overflow is the failure mode this harness exists to catch: a composer
  // control that clips its own label is invisible in review but obvious to a user.
  const overflow = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        const style = getComputedStyle(el);
        // text-overflow:ellipsis truncating its own text is intentional, not a bug.
        const intentional = style.textOverflow === 'ellipsis' || style.overflowX === 'auto' || style.overflowX === 'scroll';
        if (intentional) continue;
        const name = typeof el.className === 'string' ? el.className : el.tagName;
        if (name) out.push(name);
      }
    }
    return [...new Set(out)];
  });

  if (errors.length) failures.push(`${tag}: console error ${errors[0]}`);
  if (overflow.length) failures.push(`${tag}: horizontal overflow on ${overflow.join(', ')}`);
  console.log(`${tag} (${width}px)  errors:${errors.length || 0}  overflow:${overflow.length ? overflow.join(', ') : 'none'}`);
  await page.close();
}

await browser.close();

if (failures.length) {
  console.error('\nui-shots failures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n${check ? 'ui-shots: clean' : `ui-shots: written to ${outDir}`}`);
