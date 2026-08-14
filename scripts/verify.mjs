import { readFileSync } from 'node:fs';

const raw = readFileSync('src/webview.ts', 'utf8');
const runtimeRaw = readFileSync('src/webview/runtime.ts', 'utf8');
const runtimeMatch = runtimeRaw.match(/return String\.raw`([\s\S]*?)`;\n}/);
if (!runtimeMatch) throw new Error('webview runtime template not found');
const js = runtimeMatch[1]
  .replaceAll('${gitTracked}', 'true')
  .replaceAll('${markUri}', 'mark');
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
if (!webviewCode.includes('const context={includeProjectIndex,includeActiveFile,includeSelection')) {
  throw new Error('composer context toggles are not sent with requests');
}
if (!webviewCode.includes('id="contextSummaryButton"') || !webviewCode.includes('id="contextPanel"')) {
  throw new Error('explicit context manager UI is missing');
}
if (!webviewCode.includes('Project intelligence') || !webviewCode.includes('reindexProject')) throw new Error('project intelligence context UI is missing');
console.log('context manager UI: project index, active file, selection, attachments, and request delivery OK');
