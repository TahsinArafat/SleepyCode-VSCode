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

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('Watching SleepyCode…');
} else {
  await esbuild.build(options);
}
