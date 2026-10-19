import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webviewTranscriptItems } from '../src/webview-payload-core.ts';
import { assertSource, matchesSource } from './source-assert.mjs';

const agent = readFileSync('src/agent.ts', 'utf8');
const git = readFileSync('src/git.ts', 'utf8');
const runtime = readFileSync('src/webview/runtime.ts', 'utf8');

test('the conversation payload drops file snapshots the renderer never reads', () => {
  const items = [
    { id: 'u1', role: 'user', text: 'do it' },
    {
      id: 'a1', role: 'assistant', text: 'done', gitTree: 'abc123',
      fileSnapshot: [{ path: 'src/a.ts', existed: true, content: 'x'.repeat(50_000) }],
    },
  ];
  const projected = webviewTranscriptItems(items);
  assert.equal(projected.length, 2);
  assert.equal(projected[1].fileSnapshot, undefined, 'snapshot content must not cross to the webview');
  // Everything the renderer does read has to survive.
  assert.equal(projected[1].text, 'done');
  assert.equal(projected[1].gitTree, 'abc123');
  assert.equal(projected[0], items[0], 'items without snapshots are passed through by identity');
  // The source of truth keeps its snapshots for restore/undo.
  assert.equal(items[1].fileSnapshot.length, 1);
});

test('a conversation with no snapshots is republished without copying', () => {
  const items = [{ id: 'a1', role: 'assistant', text: 'done' }];
  assert.equal(webviewTranscriptItems(items), items, 'no allocation on the common path');
  assert.equal(webviewTranscriptItems([]).length, 0);
  assert.equal(webviewTranscriptItems(undefined), undefined);
  // An empty snapshot array is not a snapshot: there is nothing heavy to drop.
  const empty = [{ id: 'a1', role: 'assistant', text: 'done', fileSnapshot: [] }];
  assert.equal(webviewTranscriptItems(empty), empty);
});

test('the snapshot was weight, not signal: the renderer never referenced it', () => {
  assert.doesNotMatch(runtime, /fileSnapshot/, 'if this now matches, the projection can be revisited');
  assertSource(agent, /type: 'conversation'[^}]*items: webviewTranscriptItems\(active\.items\)/, 'the conversation post must publish the projection');
});

/** The body of one webview message handler, up to the next handler. */
function handler(name) {
  const start = agent.indexOf(`if (message.type === '${name}')`);
  assert.ok(start > 0, `${name} handler not found`);
  const next = agent.indexOf("if (message.type === '", start + 10);
  return agent.slice(start, next < 0 ? start + 8000 : next);
}

test('rewinding a turn persists only its own project', () => {
  // Every one of these mutates exactly one conversation in one project, so
  // rewriting every project key is pure duplicated I/O. It is the coarse
  // rewrite that made editing a past message feel slow.
  for (const name of ['editUserMessage', 'branchConversation', 'undoLastTurn', 'redoLastTurn']) {
    const block = handler(name);
    assert.doesNotMatch(block, /await this\.persistProjects\(\)/, `${name} must not rewrite every project key`);
    assert.match(block, /await this\.persistProject\(project\)/, `${name} must persist its own project`);
  }
});

test('the edit rewind scans the transcript tail once instead of copying it repeatedly', () => {
  const block = handler('editUserMessage');
  assert.doesNotMatch(block, /conversation\.items\.slice\(targetIndex\)\.(some|find)\(/, 'each slice copied the whole tail');
  assertSource(block, /for \(let index = targetIndex; index < conversation\.items\.length; index\+\+\)/, 'the tail is walked in place');
  assertSource(block, /if \(snapshotItem\?\.fileSnapshot\?\.length\) await this\.restoreFileSnapshots\(root\.fsPath, snapshotItem\.fileSnapshot\);/, 'restore still uses the first assistant snapshot');
  assertSource(block, /await restoreGitTree\(root!\.fsPath, assistantCheckpoint\.gitTree\);/, 'the Git checkpoint restore is unchanged');
});

test('workspace Git detection is memoized instead of blocking on every call', () => {
  assertSource(git, /const gitTrackedCache = new Map<string, \{ value: boolean; expiresAt: number \}>\(\);/, 'results are cached per root');
  assertSource(git, /if \(cached && cached\.expiresAt > Date\.now\(\)\) return cached\.value;/, 'a warm cache short-circuits the probe');
  assertSource(git, /export function invalidateGitTrackedCache/, 'the memo can be dropped on a workspace change');
  assertSource(agent, /private onWorkspaceFoldersChanged\(\): void \{[\s\S]{0,200}invalidateGitTrackedCache\(\);/, 'a folder change invalidates the memo');
  // The probe itself must still be the same question, not a weakened check.
  assertSource(git, /spawnSync\('git', \['-C', rootPath, 'rev-parse', '--is-inside-work-tree'\]/, 'the underlying probe is unchanged');
});

test('the conversation list sync stops copying and re-filtering per conversation', () => {
  const start = agent.indexOf('private syncConversations');
  const block = agent.slice(start, start + 3000);
  assert.doesNotMatch(block, /\[\.\.\.items\]\.reverse\(\)/, 'copying every item array on every sync is pure churn');
  assertSource(block, /const lastAssistant = findLastAssistant\(items\);/, 'the last assistant is found by walking backwards');
  assertSource(block, /const queueByConversation = new Map<string, typeof this\.queue>\(\);/, 'the queue is grouped once per sync');
  assert.doesNotMatch(block, /this\.queue\.filter\(entry => entry\.conversationId === id\)/, 'per-conversation queue filtering was conversations x queue');
  assertSource(block, /const queued = queueByConversation\.get\(id\) \?\? \[\];/, 'each conversation reads its grouped queue');
});

test('turns that are scrolled off screen are neither laid out nor painted', () => {
  const styles = readFileSync('src/webview/styles.ts', 'utf8');
  assertSource(styles, /\.turn\{[^}]*content-visibility:auto[^}]*contain-intrinsic-size:auto \d+px/, 'a long transcript must not pay for offscreen turns');
});

test('typing in the composer forces layout once, not once per handler', () => {
  assertSource(runtime, /const height = Math\.min\(input\.scrollHeight, viewportCap\)/, 'the composer measures its own height once per keystroke');
  assert.doesNotMatch(runtime, /input\.oninput = resize/, 'a single input handler drives the composer');
  assertSource(runtime, /if \(height === composerInputHeight\) return;/, 'an unchanged composer skips the transcript work');
  assertSource(runtime, /if \(composerEl\.offsetHeight === syncedComposerBoxHeight\) return;/, 'the observer ignores the echo of our own resize');
});

test('a fence that is still streaming is escaped, not tokenized every frame', () => {
  assertSource(runtime, /const closeCode=\(open\)=>\{/, 'the tail knows whether the fence closed');
  assertSource(runtime, /\(open \? esc\(body\) : highlight\(body, fenceLang\)\)/, 'only a closed fence is highlighted');
  assertSource(runtime, /closeCode\(inCode\); return html/, 'an unterminated fence takes the plain-text path');
});