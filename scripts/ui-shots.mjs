/**
 * Visual regression harness for the chat webview.
 *
 * The harness loads `dist/webview/sidebar.{js,css}` -- the React bundle the extension
 * ships -- into real Chromium with only `acquireVsCodeApi` and the message channel
 * stubbed, then drives it with real host payloads. What this screenshots is the
 * shipping UI, not a mock of it. Run `npm run build` first.
 *
 * Usage:
 *   node scripts/ui-shots.mjs            # write screenshots to .ui-shots/
 *   node scripts/ui-shots.mjs --check    # fail on overflow/console errors (for CI)
 *
 * Requires `playwright`: npm i -D playwright && npx playwright install chromium
 */
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openSidebar } from './webview-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const outDir = join(root, '.ui-shots');

const WIDTHS = [
  { tag: 'sm', width: 360, height: 780 },
  { tag: 'md', width: 460, height: 900 },
  { tag: 'lg', width: 720, height: 900 },
];

/** A transcript in the shape the host posts: user turns and assistant blocks. */
const SAMPLE = [
  { role: 'user', text: 'Why is the auth refresh loop firing twice on startup?' },
  { role: 'assistant', blocks: [{ kind: 'text', text:
    "Because `refreshIfStale()` is called from two independent paths during activation, and neither marks the token as refreshed until the HTTP call returns.\n\n"
    + "In `src/sleepyai.ts:212` the activation handler awaits the refresh, while the provider constructor at `:340` fires the same call without awaiting. Both see a stale token, both refresh, and the second races the first write:\n\n"
    + "```ts\nasync refreshIfStale() {\n  if (!this.stale()) return;\n  await this.refresh();   // not idempotent\n}\n```\n\n"
    + "Make the refresh idempotent so both callers collapse into one:\n\n"
    + "```ts\nprivate inflight?: Promise<void>;\nrefresh(): Promise<void> {\n  return (this.inflight ??= this.doRefresh()\n    .finally(() => { this.inflight = undefined; }));\n}\n```\n\n"
    + 'Want me to apply that?' }] },
  { role: 'user', text: 'Now run the tests.' },
  { role: 'assistant', blocks: [{ kind: 'error', text: 'The model stopped because the provider reported a generation error.', errorInfo: { code: 'provider_error', title: 'Request failed', message: 'The model stopped because the provider reported a generation error.' } }] },
];

if (!check) { rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true }); }

const failures = [];

for (const { tag, width, height } of WIDTHS) {
  const app = await openSidebar({ width, height });
  const { page } = app;
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));

  // Empty state: a conversation with no turns renders the starter screen.
  await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'New chat', status: 'empty', messageCount: 0, changeCount: 0 }] });
  await app.send({ type: 'loadConversation', activeId: 'c1', turns: [], usedTokens: 0, running: false, workspaceRoot: '/repo' }, 400);
  if (!check) await app.shot(join(outDir, `${tag}-empty.png`));

  // A real conversation: markdown, a code fence, and an error block.
  await app.send({ type: 'conversations', list: [{ id: 'c1', title: 'Auth refresh loop', updatedAt: Date.now(), archived: false, pinned: false, hasMessages: true, messageCount: 4, changeCount: 0, status: 'done', running: false }], activeId: 'c1', runningConvIds: [] }, 120);
  await app.send({ type: 'loadConversation', activeId: 'c1', turns: SAMPLE, usedTokens: 1200, running: false, workspaceRoot: '/repo' }, 600);
  if (!check) await app.shot(join(outDir, `${tag}-conversation.png`));

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
  await app.close();
}

if (failures.length) {
  console.error('\nui-shots failures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n${check ? 'ui-shots: clean' : `ui-shots: written to ${outDir}`}`);
