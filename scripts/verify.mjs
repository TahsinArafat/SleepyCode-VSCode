import { readFileSync } from 'node:fs';

const raw = readFileSync('src/webview.ts', 'utf8');
const runtimeRaw = readFileSync('src/webview/runtime.ts', 'utf8');
const runtimeMatch = runtimeRaw.match(/return String\.raw`([\s\S]*?)`;\r?\n}/);
if (!runtimeMatch) throw new Error('webview runtime template not found');
// The template interpolates a few identifiers at build time. The syntax check works on
// the template source, so substitute them here too — otherwise the checker sees raw
// `${NAME}` and reports a syntax error that the real build never produces.
const { ESCAPE_HTML_SOURCE } = await import('../src/webview/runtime-core.ts');
const { STREAM_RENDER_SOURCE, STREAM_FRAME_SOURCE } = await import('../src/webview/stream-render.ts');
const { HIGHLIGHT_SOURCE } = await import('../src/webview/highlight.ts');
const js = runtimeMatch[1]
  .replaceAll('${gitTracked}', () => 'true')
  .replaceAll('${markUri}', () => 'mark')
  .replaceAll('${ESCAPE_HTML_SOURCE}', () => ESCAPE_HTML_SOURCE)
  .replaceAll('${STREAM_RENDER_SOURCE}', () => STREAM_RENDER_SOURCE)
  .replaceAll('${STREAM_FRAME_SOURCE}', () => STREAM_FRAME_SOURCE)
  .replaceAll('${HIGHLIGHT_SOURCE}', () => HIGHLIGHT_SOURCE);
await import('node:child_process').then(({ execFileSync }) => {
  execFileSync(process.execPath, ['--check', '--input-type=module', '-'], { input: js, stdio: 'pipe' });
  console.log('webview JS: syntax OK');
});
const webviewCode = raw + '\n' + runtimeRaw;

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

if (!webviewCode.includes('projectIndicatorName.textContent=editorContext.activeFile||projectIndicatorFolder')) {
  throw new Error('project indicator does not prefer the active file path');
}
if (!webviewCode.includes('includeActiveFile=true') || !webviewCode.includes('data-context-toggle="active"')) {
  throw new Error('active-file context toggle is missing');
}
if (!/const context\s*=\s*\{\s*includeProjectIndex\s*,\s*includeActiveFile\s*,\s*includeSelection/.test(webviewCode)) {
  throw new Error('composer context toggles are not sent with requests');
}
if (!webviewCode.includes('id="contextSummaryButton"') || !webviewCode.includes('id="contextPanel"')) {
  throw new Error('explicit context manager UI is missing');
}
if (!webviewCode.includes('Project intelligence') || !webviewCode.includes('reindexProject')) throw new Error('project intelligence context UI is missing');
console.log('context manager UI: project index, active file, selection, attachments, and request delivery OK');
