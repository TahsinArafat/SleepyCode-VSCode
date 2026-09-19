import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'katex', 'dist');
const out = join(root, 'media', 'katex');

if (!existsSync(src)) {
  console.error('KaTeX dist not found at node_modules/katex/dist. Run: npm install katex');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'fonts'), { recursive: true });

cpSync(join(src, 'katex.min.js'), join(out, 'katex.min.js'));

const fontsDir = join(src, 'fonts');
for (const file of readdirSync(fontsDir)) {
  if (!file.endsWith('.woff2')) continue;
  cpSync(join(fontsDir, file), join(out, 'fonts', file));
}

const css = readFileSync(join(src, 'katex.min.css'), 'utf8');
writeFileSync(join(out, 'katex.min.css'), css);

console.log('Copied KaTeX assets to media/katex');
