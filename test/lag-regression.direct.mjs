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

test('the React path escapes an open fence too, rather than highlighting it per delta', () => {
  // The classic webview got this right first (the test above). The React renderer re-ran the
  // whole pipeline per delta with the fence highlighted, which is ~10,000 elements of
  // sanitize work at 64k characters for output the next delta discards. Both paths must agree.
  const markdown = readFileSync('webview-ui/shared/markdown.ts', 'utf8');
  const blocks = readFileSync('src/markdown-blocks.ts', 'utf8');
  assertSource(blocks, /const openFence = last !== undefined && last\.token\?\.type === 'code' && isOpenFence\(last\.token\);/, 'the split reports an unterminated trailing fence');
  assertSource(markdown, /if \(split\.openFence && i === lastIndex\) \{\s*blocks\.push\(openFenceHtml\(block\)\);/, 'the open fence takes the escaped path');
  assertSource(markdown, /content: escapeCodeHtml\(code\),/, 'its body is escaped, not highlighted');
  // Chrome must still match the closed render, or the block reflows when the delimiter lands.
  assertSource(markdown, /function openFenceHtml[\s\S]{0,600}textDirections\(sanitize\(codeBlockHtml\(\{/, 'the open fence carries the same chrome and direction attributes');
});

test('the workspace watcher arms with the view, not with activation', () => {
  // `activationEvents` includes `onUri`, so an MCP OAuth callback used to activate the
  // extension and arm a 45-extension glob watcher for a session that never opens the chat.
  const ctor = agent.slice(agent.indexOf('constructor(private readonly context'), agent.indexOf('private async ensureEngine'));
  assert.doesNotMatch(ctor, /createFileSystemWatcher/, 'the constructor must not create the watcher');
  assertSource(agent, /private startWorkspaceWatcher\(\): void \{\s*if \(this\.workspaceWatcher\) return;/, 'arming is idempotent');
  assertSource(agent, /resolveWebviewView\(view: vscode\.WebviewView\): void \{\s*this\.startWorkspaceWatcher\(\);/, 'the view resolve arms it');
  // Scheduled tasks must keep firing with the chat closed, so they stay on the constructor.
  assertSource(ctor, /this\.schedulerTimer = setInterval\(\(\) => \{ void this\.runDueScheduledTasks\(\); \}, 30_000\);/, 'scheduled tasks are not gated on the view');
});

test('dispose clears every timer the provider owns', () => {
  const body = agent.slice(agent.indexOf('dispose(): void {'), agent.indexOf('private loadProjects()'));
  for (const timer of ['projectIndexTimer', 'editorContextTimer', 'mcpWarmTimer']) {
    assertSource(body, new RegExp(`if \\(this\\.${timer}\\) clearTimeout\\(this\\.${timer}\\);`), `${timer} must be cleared on dispose`);
  }
  assertSource(body, /if \(this\.schedulerTimer\) clearInterval\(this\.schedulerTimer\);/, 'the scheduler interval must be cleared on dispose');
});

test('every per-conversation map is released when a conversation is deleted', () => {
  // These are keyed by conversation id and each grew once per conversation with no way to
  // shrink; `reactItems` holds a full transcript copy. The delete handler cleaned the queue
  // and compaction stacks by hand and left the rest, so this asserts the whole set — a new
  // map added to the class must be added to `forgetConversation` too.
  const start = agent.indexOf('private forgetConversation(id: string): void {');
  assert.ok(start > 0, 'forgetConversation must exist');
  const body = agent.slice(start, agent.indexOf('\n  }', start));
  for (const map of ['reactItems', 'reactChangeTarget', 'reactPendingPaths', 'reactLastToolCall', 'reactStreaming', 'checkpointAtByConversation', 'historyBoundNoticed', 'cliModelNotices', 'mcpNoticeSignatures']) {
    assertSource(body, new RegExp(`this\\.${map}\\.delete\\(id\\);`), `${map} must be released with the conversation`);
  }
  // And that it is actually reached from the delete path.
  const del = agent.slice(agent.indexOf("if (message.type === 'deleteConversation')"), agent.indexOf("if (message.type === 'restoreCheckpoint')"));
  assertSource(del, /this\.forgetConversation\(message\.id\);/, 'deleting a conversation releases its records');
});

test('archiving releases only the transient records, because it is reversible', () => {
  // Un-archiving has to render the conversation as it was, so the transcript copy and the
  // checkpoint clock must survive. Dropping them here would show an empty chat on restore.
  const start = agent.indexOf("if (message.type === 'archiveConversation')");
  const body = agent.slice(start, agent.indexOf("if (message.type === 'deleteConversation')"));
  assertSource(body, /conversation\.archived\) \{[\s\S]{0,400}this\.reactStreaming\.delete\(message\.id\);/, 'streaming state is dropped on archive');
  assert.doesNotMatch(body, /this\.reactItems\.delete\(/, 'the transcript copy must survive archive');
  assert.doesNotMatch(body, /this\.checkpointAtByConversation\.delete\(/, 'the checkpoint clock must survive archive');
});

test('the workspace index is released on a workspace change and on dispose', () => {
  // It is the largest retainer in the extension (~150 MB on a 4,000-file repo). It used to
  // be left in place across a folder change, keeping the previous tree resident.
  assertSource(agent, /private releaseRepoIndex\(\): void \{\s*this\.repoIndexCache = undefined;/, 'there is one way to drop it');
  const changed = agent.slice(agent.indexOf('private onWorkspaceFoldersChanged'), agent.indexOf('private scheduleProjectReindex'));
  assertSource(changed, /this\.releaseRepoIndex\(\);/, 'a folder change must drop the index');
  const dispose = agent.slice(agent.indexOf('dispose(): void {'), agent.indexOf('private loadProjects()'));
  assertSource(dispose, /this\.releaseRepoIndex\(\);/, 'dispose must drop the index');
});

test('a file change updates the index entry rather than leaving stale contents', () => {
  // The index holds full file contents. Before this, an edit left the pre-edit text in the
  // index, so a later search could hand the agent source that no longer existed.
  assertSource(agent, /private refreshRepoIndexEntry\(root: vscode\.Uri, relative: string, uri: vscode\.Uri\): void \{/, 'there is a targeted refresh');
  const refresh = agent.slice(agent.indexOf('private refreshRepoIndexEntry'), agent.indexOf('private async loadRepoIndex'));
  assertSource(refresh, /cached\.index\.upsert\(\{ path: relative, content: readFileSync\(uri\.fsPath, 'utf8'\) \}\);/, 'an edited file is re-read');
  assertSource(refresh, /cached\.index\.remove\(relative\)/, 'a removed or unreadable file is dropped');
  const scheduled = agent.slice(agent.indexOf('private scheduleProjectReindex'), agent.indexOf('private async ensureProjectIntelligence'));
  assertSource(scheduled, /this\.refreshRepoIndexEntry\(root, relative, uri\);/, 'the file watcher calls it');
  assert.doesNotMatch(scheduled, /this\.releaseRepoIndex\(\);/, 'a single save must not force a full rescan');
});

test('the symbol index is built once and reused, not rebuilt per tool call', () => {
  // It costs ~3.5 s and ~120 MB on a 4,000-file repo, and `repo_symbol` called it per
  // invocation. Memoization is what makes a second symbol question free — the tool may
  // still ask for the index, because asking is now cheap.
  const repo = readFileSync('src/repo-index.ts', 'utf8');
  assertSource(repo, /private symbolsStale = true;/, 'staleness is tracked');
  assertSource(repo, /indexSymbols\(\): SymbolEntry\[\] \{\s*if \(!this\.symbolsStale\) return this\.symbols;/, 'a repeat read returns the memoized array');
  assertSource(repo, /symbolCount\(\): number \{/, 'counts do not force the caller to materialize the list');
  // Any write must invalidate, or a search would answer from pre-edit source.
  const invalidate = repo.slice(repo.indexOf('private invalidateDerived()'), repo.indexOf('get files()'));
  assertSource(invalidate, /this\.symbolsStale = true;/, 'an edit marks the symbols stale');
  // The index panel counted symbols; calling the extractor for a count was pure waste.
  assert.doesNotMatch(agent, /const symbols = index\.indexSymbols\(\);/, 'the panel must not extract symbols just to count them');
  assertSource(agent, /index\.symbolCount\(\)/, 'the panel uses the count accessor');
});

