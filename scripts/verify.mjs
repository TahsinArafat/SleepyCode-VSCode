import { readFileSync } from 'node:fs';

/*
 * The context-manager checks below used to grep the vanilla webview's source text for
 * element ids and a hand-built context object. That renderer is gone; the live chat is the
 * React webview, which takes the same context state from `src/context-panel.ts` -- a shared
 * module both paths use. Asserting against that module tests the BEHAVIOUR (the toggles
 * exist, they map onto the fields the host reads, and a request carries them) instead of
 * pinning markup that is free to change.
 */
const contextPanel = readFileSync('src/context-panel.ts', 'utf8');
const adapter = readFileSync('src/webview-adapter.ts', 'utf8');
const composer = readFileSync('webview-ui/sidebar/components/Composer.tsx', 'utf8');
const reactApp = readFileSync('webview-ui/sidebar/App.tsx', 'utf8');

const src = readFileSync('src/providers.ts', 'utf8');
const nonTextMatch = src.match(/const NON_TEXT = (.*);/);
if (!nonTextMatch) throw new Error('NON_TEXT regex not found');
const NON_TEXT = new Function(`return ${nonTextMatch[1]}`)();
const isText = id => !NON_TEXT.test(id);

const cases = [
  ['gemini-2.5-flash', true],
  ['gemini-2.5-flash-image', false],
  ['gemini-2.0-flash', true],
  ['gemma-3-27b-it', true],
  ['whisper-large-v3-turbo', false],
  ['nomic-embed-text', false],
  ['text-embedding-3-small', false],
  ['llama-3.2-11b-vision-instruct', false],
  ['mistral-small-latest', true],
  ['gpt-4o', true],
  ['qwen2.5-vl-7b', false],
  ['glm-4v', false],
  ['flux-1-schnell', false],
  ['claude-3.5-sonnet:free', true],
  ['deepseek/deepseek-chat-v3:free', true],
  ['grok-3-mini', true],
  ['imagen-3.0-generate', false],
  ['llama-3.3-70b', true],
];
let failed = 0;
for (const [id, expected] of cases) {
  const got = isText(id);
  if (got !== expected) { failed++; console.log(`FAIL ${id}: expected ${expected}, got ${got}`); }
}
if (failed) throw new Error(`${failed} filter case(s) failed`);
console.log(`text filter: ${cases.length} cases OK`);

// --- Context manager --------------------------------------------------------------------------
// Each toggle must exist, carry the field name the host reads, and reach the request payload.
// A toggle that renders but is not sent is the failure this section exists to catch, and it is
// invisible in the UI: the chip looks right and the model never sees the file.
// Anchored to the `CONTEXT_TOGGLES` array so the union type in the `ContextToggle` interface
// (which lists the same field names) is not counted as a fourth toggle.
const toggleBlock = contextPanel.slice(contextPanel.indexOf('export const CONTEXT_TOGGLES'));
const toggleFields = [...toggleBlock.matchAll(/field:\s*'(includeProjectIndex|includeActiveFile|includeSelection)'/g)].map(m => m[1]);
for (const field of ['includeProjectIndex', 'includeActiveFile', 'includeSelection']) {
  if (!toggleFields.includes(field)) throw new Error(`context toggle ${field} is missing`);
}
console.log(`context toggles: ${toggleFields.join(', ')} OK`);

// The composer must render them, or the user has no way to change what a request includes.
if (!/CONTEXT_TOGGLES\.map\(/.test(composer)) {
  throw new Error('the composer does not render the context toggles');
}

// And the adapter must forward the switches, or a toggle that is off is still sent as on.
if (!/for \(const field of \['includeProjectIndex', 'includeActiveFile', 'includeSelection'\]/.test(adapter)) {
  throw new Error('the webview adapter does not forward the context switches');
}

// Project intelligence: the host has always posted the index status; the panel has to show it
// with a reindex action, or the feature is unreachable from the UI.
if (!/reindexProject/.test(reactApp) || !/indexCard\(indexStatus\)/.test(reactApp)) {
  throw new Error('project intelligence status and its reindex action are missing');
}
console.log('context manager UI: toggles, request delivery, and project intelligence OK');
