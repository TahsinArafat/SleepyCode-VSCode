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
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const outDir = join(root, '.ui-shots');
const work = join(tmpdir(), 'sleepycode-ui-shots');

const WIDTHS = [
  { tag: 'sm', width: 360, height: 780 },
  { tag: 'md', width: 460, height: 900 },
  { tag: 'lg', width: 720, height: 900 },
];

/** VS Code Dark Modern. The real host injects these; the harness has to supply them. */
const THEME = `:root{
--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe WPC","Segoe UI",system-ui,"Ubuntu","Droid Sans",sans-serif;
--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Consolas,"Liberation Mono",monospace;
--vscode-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#cccccc;
--vscode-sideBar-background:#181818;--vscode-sideBar-foreground:#cccccc;
--vscode-editorWidget-background:#202020;--vscode-editorWidget-foreground:#cccccc;--vscode-editorWidget-border:#313131;
--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-input-placeholderForeground:#7f7f7f;
--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;
--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;
--vscode-focusBorder:#0078d4;--vscode-panel-background:#181818;--vscode-panel-border:#2b2b2b;
--vscode-textLink-foreground:#4daafc;--vscode-textLink-activeForeground:#4daafc;--vscode-textPreformat-foreground:#d7ba7d;
--vscode-textBlockQuote-background:#222222;--vscode-textBlockQuote-border:#454545;--vscode-textCodeBlock-background:#0d0d0d;
--vscode-errorForeground:#f85149;--vscode-descriptionForeground:#9d9d9d;--vscode-errorBackground:#5a1d1d;
--vscode-successBackground:#1c3b20;--vscode-statusBarItem-warningBackground:#7a6400;--vscode-statusBarItem-warningForeground:#fff;
--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;--vscode-scrollbarSlider-background:#79797966;
--vscode-widget-shadow:#0000005c;--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-red:#f14c4c;
--vscode-charts-yellow:#cca700;--vscode-charts-purple:#b180d7;--vscode-dropdown-background:#313131;--vscode-dropdown-border:#3c3c3c;
--vscode-progressBar-background:#0078d4;--vscode-contrastBorder:#fff;--vscode-contrastActiveBorder:#0078d4;
--vscode-menu-background:#1f1f1f;--vscode-menu-foreground:#cccccc;--vscode-menu-selectionBackground:#0078d4;
--vscode-menu-selectionForeground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryHoverBackground:#3c3c3c;
}`;

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

async function buildPage() {
  const bundled = await esbuild.build({
    entryPoints: [join(root, 'src/webview/runtime.ts')],
    bundle: true, format: 'cjs', platform: 'neutral', write: false, target: 'es2022',
  });
  // Evaluating the CJS bundle by hand is deliberate: importing a generated .cjs from an
  // ESM script wraps it in a module namespace, so the named export is not on the top level.
  const cjsModule = { exports: {} };
  new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(cjsModule, cjsModule.exports, createRequire(import.meta.url));
  const { getWebviewRuntime } = cjsModule.exports;
  const runtime = getWebviewRuntime('MARK_URI.svg', true);

  const stylesSrc = readFileSync(join(root, 'src/webview/styles.ts'), 'utf8');
  const css = stylesSrc.match(/String\.raw`([\s\S]*?)`/)?.[1];
  if (!css) throw new Error('could not extract WEBVIEW_STYLES from src/webview/styles.ts');

  const shell = readFileSync(join(root, 'src/webview.ts'), 'utf8');
  let body = shell.slice(shell.indexOf('<body>') + 6);
  body = body.split('<script')[0].replace(/\$\{[^}]*\}/g, 'X');

  return `<!doctype html><html><head><meta charset="UTF-8">
<style>${THEME}</style><style>${css}</style>
<style>html,body{height:100%;margin:0}</style></head><body>${body}
<script>
window.__posted=[];
window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m),getState:()=>undefined,setState:s=>window.__state=s});
window.__emit=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));
</script><script>${runtime}</script></body></html>`;
}

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
