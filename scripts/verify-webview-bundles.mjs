/*
 * Loads the BUILT webview bundles and checks that the app actually starts.
 *
 * ## Why this exists
 *
 * 0.8.0 shipped broken. `loadingId` was declared ~40 lines below a `useEffect`
 * that read it, so the bundle threw `ReferenceError: Cannot access 'Ri' before
 * initialization` while executing — a `const` read before its declaration, in a
 * component body. Nothing caught it:
 *
 *   - `tsc` does not analyse use-before-declaration inside a function body;
 *   - no unit test loads `dist/webview/sidebar.js` at all (`npm test` runs the
 *     pure `.mjs` suites, and the `.test.tsx` files need a vitest that is not
 *     installed here);
 *   - `npm run verify` only syntax-checks the classic webview runtime.
 *
 * The failure also happens at LOAD time, before any host message arrives, so the
 * chat panel came up blank for every user. This script is the missing check: run
 * the bundle the way the webview does, and fail if it throws or never renders.
 *
 * Runs against an opt-in jsdom (installed by CI or locally), because the repo
 * deliberately keeps the shipped dependency set small.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('webview smoke check: "jsdom" is not installed. Run `npm i --no-save jsdom` first.');
  process.exit(2);
}

/** Stand-ins for the APIs a VS Code webview provides and a bare DOM does not. */
function stubWebview(window) {
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  window.matchMedia ||= () => ({
    matches: false, media: '', onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  window.scrollTo = () => {};
  window.Element.prototype.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
}

/**
 * Load one bundle and report what happened.
 *
 * A crashed render is NOT a pass: React's ErrorBoundary catches the throw and
 * leaves its own "Something went wrong" panel in `#root`, so "something
 * rendered" is not "the app started". Both are checked.
 */
async function loadBundle(file) {
  const errors = [];
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root" data-icon=""></div></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  stubWebview(window);
  window.addEventListener('error', event => errors.push(String(event.error ?? event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(`unhandled rejection: ${event.reason}`));

  try {
    window.eval(readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${error.name}: ${error.message}`);
  }
  // Let React's initial render and its effects settle.
  await new Promise(done => setTimeout(done, 500));

  const html = window.document.getElementById('root')?.innerHTML ?? '';
  dom.window.close();

  if (errors.length) return { ok: false, detail: errors.join('\n  ') };
  if (/Something went wrong|eb-title/.test(html)) return { ok: false, detail: 'the app crashed while rendering (ErrorBoundary is showing)' };
  if (!/chat-empty|chat-messages|composer|empty-title|setup-screen|settings|page-title/.test(html)) {
    return { ok: false, detail: `#root has ${html.length} chars but the app shell is absent` };
  }
  return { ok: true, detail: `${html.length} chars rendered` };
}

const root = resolve(import.meta.dirname, '..');
let failed = 0;
for (const entry of ['sidebar', 'settings']) {
  const file = resolve(root, 'dist', 'webview', `${entry}.js`);
  let result;
  try {
    result = await loadBundle(file);
  } catch (error) {
    result = { ok: false, detail: `could not read ${file}: ${error.message} (run \`npm run build\` first)` };
  }
  if (result.ok) console.log(`ok - ${entry} bundle starts (${result.detail})`);
  else { failed++; console.error(`✗ ${entry} bundle failed to start:\n  ${result.detail}`); }
}
if (failed) process.exit(1);
console.log('webview bundles: both start');
