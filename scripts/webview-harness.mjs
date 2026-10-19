/**
 * Shared scaffolding for running the chat webview outside VS Code.
 *
 * The webview is plain browser JS (`src/webview/runtime.ts`) wrapped in a shell
 * (`src/webview.ts`), so it can be rendered in a real browser: bundle the runtime, take the
 * real stylesheet and real body markup, stub `acquireVsCodeApi`, then drive it.
 * `scripts/ui-shots.mjs` screenshots the result; `scripts/perf-probe.mjs` measures it.
 */
import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** VS Code Dark Modern. The real host injects these; the harness has to supply them. */
export const THEME = `:root{
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

/** Render the shipping webview (real runtime, real CSS, real markup) to a standalone HTML string. */
export async function buildPage() {
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
window.__bootAt=performance.now();
</script><script>${runtime}</script></body></html>`;
}

/** A transcript of `turns` user/assistant pairs, long enough to show superlinear cost. */
export function transcript(turns) {
  const items = [];
  for (let i = 0; i < turns; i++) {
    items.push({ id: `u${i}`, role: 'user', text: `Question ${i}: why does the auth refresh fire twice?`, timestamp: i * 2 });
    items.push({
      id: `a${i}`, role: 'assistant', timestamp: i * 2 + 1, model: 'claude-sonnet',
      text: `Because \`refreshIfStale()\` is called from two paths.\n\n`
        + `In \`src/sleepyai.ts:212\` the handler awaits the refresh, while the provider constructor fires it without awaiting.\n\n`
        + `\`\`\`ts\nasync function refreshIfStale() {\n  if (!isStale()) return;\n  await refresh();\n}\n\`\`\`\n\n`
        + `| path | awaits | result |\n| --- | --- | --- |\n| activation | yes | ok |\n| constructor | no | races |\n`,
      work: [{ kind: 'task', tool: 'read_file', name: `src/sleepyai.ts:${i}`, done: true }],
      seconds: 3,
    });
  }
  return items;
}
