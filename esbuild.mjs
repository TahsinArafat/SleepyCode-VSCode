import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';

const watch = process.argv.includes('--watch');

function copyKatexAssets() {
  execFileSync(process.execPath, ['scripts/copy-katex-assets.mjs'], { stdio: 'inherit' });
}

copyKatexAssets();
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'playwright', 'playwright-core'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !watch,
};

/**
 * The React chat and settings UI are separate browser bundles, loaded by the
 * HTML shell in `src/webview-react.ts` from `dist/webview/<entry>.js|css`.
 *
 * They have to be built here. They used to come from a script no npm task ran,
 * so a clean `npm run package` produced an extension whose chat panel opened to
 * an empty root with no error — the host has no way to detect a missing bundle.
 */
const webviewOptions = {
  entryPoints: {
    sidebar: 'webview-ui/sidebar/main.tsx',
    settings: 'webview-ui/settings/main.tsx',
  },
  bundle: true,
  format: 'iife',
  outdir: 'dist/webview',
  platform: 'browser',
  target: ['es2020'],
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  sourcesContent: false,
  sourcemap: !watch,
  minify: !watch,
};

if (watch) {
  const context = await esbuild.context(options);
  const webview = await esbuild.context(webviewOptions);
  await Promise.all([context.watch(), webview.watch()]);
  console.log('Watching SleepyCode…');
} else {
  await Promise.all([esbuild.build(options), esbuild.build(webviewOptions)]);
}
