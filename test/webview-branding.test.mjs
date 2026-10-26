import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The ported React UI arrived from OpenCursor, and its rebrand was incomplete:
 * the setup screen said "Build with OpenCursor", the settings rail said
 * "OpenCursor", two privacy paragraphs and the About card named it as the
 * product, and About linked to the upstream repository.
 *
 * The existing rebrand guard (`sleepycode-regressions.test.mjs`) scans
 * package.json, README and a handful of src/ files. It has never looked at
 * `webview-ui/`, which is exactly why this survived a rebrand that was
 * reported as complete.
 *
 * Attribution is NOT a leak. MIT requires the copyright notice to be preserved:
 * every ported file keeps its header, and the About page credits upstream. So
 * the rule is narrow and testable — after comments are removed, "OpenCursor" may
 * only appear on a line that also carries an attribution marker.
 */

// fileURLToPath, not .pathname: this repo's path contains spaces and parens.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEBVIEW = join(ROOT, 'webview-ui');

// `UPSTREAM` lets a constant or variable carry the provenance link without
// restating the licence on that same line.
const ATTRIBUTION = /\bMIT\b|Licensed|based on|upstream|UPSTREAM|Pawan Osman|Copyright/i;

/** Remove `/* … *​/` and `// …` so only code and JSX text remain. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

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

test('the scan found a real webview tree', () => {
  assert.ok(files.length > 40, `only scanned ${files.length} files`);
});

test('the React UI never names OpenCursor as the product', async () => {
  const offenders = [];
  for (const file of files) {
    const code = withoutComments(await readFile(file, 'utf8'));
    for (const line of code.split('\n')) {
      if (!line.includes('OpenCursor')) continue;
      // A licence or provenance line may name it; a product claim may not.
      if (ATTRIBUTION.test(line)) continue;
      offenders.push(`${file.replace(ROOT, '')}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `OpenCursor named outside an attribution line:\n${offenders.join('\n')}`);
});

test('the UI never sends the user to the upstream repository', async () => {
  // Opening upstream's issues page for a SleepyCode bug sends users to people
  // who cannot act on it. Attribution links are allowed only where the row says
  // it is upstream.
  const offenders = [];
  for (const file of files) {
    const code = withoutComments(await readFile(file, 'utf8'));
    for (const line of code.split('\n')) {
      if (!/github\.com\/PawanOsman/.test(line)) continue;
      if (ATTRIBUTION.test(line)) continue;
      offenders.push(`${file.replace(ROOT, '')}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `upstream repo used as our own:\n${offenders.join('\n')}`);
});

test('the scan reads real JSX text and not only comments', async () => {
  // Guards the guard: `withoutComments` must not be so aggressive that it eats
  // the strings this file exists to police. A ported file keeps an OpenCursor
  // header, so a broken stripper would make every assertion above vacuously
  // pass. Check that a known user-visible string survives stripping.
  const source = await readFile(join(WEBVIEW, 'sidebar/App.tsx'), 'utf8');
  const code = withoutComments(source);
  assert.match(source, /This file is part of OpenCursor/, 'the ported header should still be present in the file');
  assert.doesNotMatch(code, /This file is part of OpenCursor/, 'headers must be stripped before scanning');
  assert.match(code, /dataset\.icon/, 'real code must survive stripping');
});
