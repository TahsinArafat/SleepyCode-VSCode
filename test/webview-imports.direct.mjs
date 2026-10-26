import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A missing import is a runtime crash, not a type error the bundler reports:
// esbuild happily bundles an undefined identifier, and the panel dies with
// "X is not defined" — which is exactly how `planBlockContent is not defined`
// shipped and blanked the chat.
//
// This test catches that class without a browser: for every identifier a file
// uses that is also exported somewhere in the webview tree, require that the
// file imports it.

// fileURLToPath, not .pathname: this repo's path contains spaces and parens.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEBVIEW = join(ROOT, 'webview-ui');

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = await sources(WEBVIEW);

/** Every named export declared across the webview tree and the shared src modules. */
async function exportedNames() {
  const names = new Set();
  const targets = [...files, join(ROOT, 'src/webview-adapter.ts'), join(ROOT, 'src/agent-mode.ts')];
  for (const file of targets) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/export (?:async )?function (\w+)/g)) names.add(match[1]);
    for (const match of text.matchAll(/export const (\w+)/g)) names.add(match[1]);
  }
  return names;
}

const exported = await exportedNames();

test('the scan found a real codebase', () => {
  assert.ok(files.length > 40, `only scanned ${files.length} files`);
  assert.ok(exported.size > 50, `only found ${exported.size} exports`);
});

test('every webview identifier that is exported elsewhere is imported where used', async () => {
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // Only consider files that reference one of our own exports by name.
    for (const name of exported) {
      // A declaration in this very file is not a use.
      if (new RegExp(`export (?:async )?function ${name}\\b`).test(text)) continue;
      if (new RegExp(`export const ${name}\\b`).test(text)) continue;
      // Word-boundary use, excluding the import line itself and member access.
      const useRe = new RegExp(`(?<![.\\w])${name}\\s*[(<,)\\]]`, 'g');
      if (!useRe.test(text)) continue;
      const imported = new RegExp(`import[^;]*\\b${name}\\b[^;]*from`, 's').test(text);
      const local = new RegExp(`(?:const|let|function|class)\\s+${name}\\b`).test(text);
      if (!imported && !local) offenders.push(`${file.replace(ROOT, '')}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `identifiers used but never imported:\n${offenders.join('\n')}`);
});
