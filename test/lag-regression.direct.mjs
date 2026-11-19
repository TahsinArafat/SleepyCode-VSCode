import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webviewTranscriptItems } from '../src/webview-payload-core.ts';
import { assertSource, matchesSource } from './source-assert.mjs';

const agent = readFileSync('src/agent.ts', 'utf8');
const git = readFileSync('src/git.ts', 'utf8');

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
  // `fileSnapshot` exists so a turn can be restored; the renderer never reads it, which is why
  // `webviewTranscriptItems` strips it. The React bundle is the thing that renders, so check
  // there instead of the legacy template that is being removed.
  const bundle = readFileSync('webview-ui/shared/markdown.ts', 'utf8');
  assert.doesNotMatch(bundle, /fileSnapshot/, 'if this now matches, the projection can be revisited');
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
  // The legacy webview did this on `.turn`; the React path does it on `.chat-turn-group`,
  // which keeps a turn's user message and assistant content together.
  const styles = readFileSync('webview-ui/sidebar/sidebar.css', 'utf8');
  assertSource(styles, /\.chat-turn-group\s*\{[^}]*content-visibility:auto/, 'an off-screen group must skip layout and paint');
  assertSource(styles, /\.chat-turn-group\s*\{[^}]*contain-intrinsic-size:auto \d+px/, 'contain-intrinsic-size keeps the scrollbar stable');
  // `:last-child` is the one group that must stay measurable while it streams.
  assertSource(styles, /\.chat-turn-group:last-child\s*\{[^}]*content-visibility:visible/, 'the live group stays measurable');
});

test('the composer height is capped by CSS, so typing needs no layout probing', () => {
  // The legacy webview measured its own height with `scrollHeight` once per keystroke and
  // skipped the work when the height had not changed. The React composer does it with no
  // measuring at all: a CSS cap with `overflow-y: auto`, so growth is the browser's problem.
  const styles = readFileSync('webview-ui/sidebar/sidebar.css', 'utf8');
  assertSource(styles, /\.composer \.editor\s*\{[^}]*max-height:min\(240px, 35vh\)/, 'the editor caps its own height in CSS');
  assertSource(styles, /\.composer \.editor\s*\{[^}]*overflow-y:auto/, 'overflow scrolls rather than growing the composer forever');
  // And nothing in the React composer probes scrollHeight per keystroke.
  const editor = readFileSync('webview-ui/sidebar/components/ComposerEditor.ts', 'utf8');
  assert.doesNotMatch(editor, /scrollHeight/, 'the React editor must not measure itself');
});

test('a fence that is still streaming is escaped, not highlighted every frame', () => {
  // The legacy webview escaped an unterminated fence instead of highlighting it. The
  // React path does the same via `isOpenFence`: an open fence is emitted as escaped text
  // and highlighted once when it closes. The vanilla form is covered by
  // `test/open-fence.direct.mjs`; this pins that the React markdown module keeps the rule.
  const markdown = readFileSync('webview-ui/shared/markdown.ts', 'utf8');
  assertSource(markdown, /function openFenceHtml/, 'the escaped-open-fence path exists');
  assertSource(markdown, /split\.openFence && i === lastIndex/, 'only the unterminated fence takes it');
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
  // Scheduled tasks must keep firing with the chat closed, so the timer is armed from
  // the constructor rather than the view. It is only armed when a schedule exists:
  // an always-on 30 s interval is ~2,900 no-op wakeups a day for the common case of
  // no schedules at all, so the constructor arms it conditionally.
  assertSource(ctor, /this\.armScheduler\(\);/, 'scheduled tasks are not gated on the view');
  assertSource(agent, /private armScheduler\(\): void \{[\s\S]{0,400}if \(!hasTasks\) \{[\s\S]{0,200}return;/, 'the timer is not started when there is nothing to run');
  assertSource(agent, /this\.schedulerTimer = setInterval\(\(\) => \{ void this\.runDueScheduledTasks\(\); \}, 30_000\);/, 'a real schedule still fires every 30 s');
  // A task written after activation must still be picked up.
  assertSource(agent, /private armScheduler\(\)[\s\S]{0,700}scheduledTasks\(\)\.length > 0/);
});

test('a hidden sidebar releases the index but never interrupts a run', () => {
  // The index is the largest resident cache in the extension, and a hidden view is
  // idle by definition. A live run still reads it through its tools, so it is kept
  // until the run finishes.
  const start = agent.indexOf('view.onDidChangeVisibility');
  const body = agent.slice(start, start + 700);
  assertSource(body, /else if \(!this\.runs\.size\) \{[\s\S]{0,200}this\.releaseRepoIndex\(\);/, 'hiding the view drops the index when idle');
  assertSource(body, /if \(view\.visible\) \{[\s\S]{0,200}this\.sendEditorContext\(\);/, 'showing the view still refreshes editor context');
});

test('activating the extension does not touch the network before the chat opens', () => {
  // `onUri` and plain commands also activate. A token refresh at construction made an
  // extension whose chat is never shown hit the network on every window start.
  const ctor = agent.slice(agent.indexOf('constructor(private readonly context'), agent.indexOf('private async ensureEngine'));
  assert.doesNotMatch(ctor, /getSleepyToken\(\)/, 'no token warm-up in the constructor');
  const resolve = agent.slice(agent.indexOf('resolveWebviewView('), agent.indexOf('resolveWebviewView(') + 900);
  assertSource(resolve, /void getSleepyToken\(\)\.catch/, 'the token is warmed when the view opens');
});

test('no MCP servers means no login-shell probe', () => {
  // `loginShellEnv()` spawns a real `zsh -ilc`. The probe runs on every view resolve
  // and every settings open, so it must not run when nothing is configured.
  assertSource(agent, /if \(!connections\.length\) return \[\];[\s\S]{0,300}await loginShellEnv\(\)/, 'the empty list returns before the shell probe');
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
  // and compaction stacks by hand and left the rest.
  //
  // The set is *derived*, not listed. A hardcoded list only proves today's maps are
  // released; it cannot notice one added tomorrow, which is the failure this guard exists
  // for. Every string-keyed collection in the class must be either released by
  // `forgetConversation` or explicitly classified below with the reason its lifetime is
  // owned by something else — so silence is not an option.
  const start = agent.indexOf('private forgetConversation(id: string): void {');
  assert.ok(start > 0, 'forgetConversation must exist');
  const body = agent.slice(start, agent.indexOf('\n  }', start));

  const NOT_CONVERSATION_KEYED = {
    subagentControllers: 'subagent ids, released when each subagent settles',
    runs: 'in-flight runs, released when the run settles; delete refuses while one is active',
    compactionControllers: 'in-flight compactions, deleted in the `finally` of both paths',
    pendingQuestions: 'tool-call ids, each resolved before its run ends',
    agentPromptCache: 'agent ids, not conversations',
    sessionAllowedCommands: 'command strings for the session grant',
    sessionAutoApproveEditRoots: 'root paths for the session grant',
    reviewTempDirs: 'temp dir paths, removed on dispose',
    cliServer: 'server handles, not conversations',
    migratingProjects: 'project ids, removed when each migration settles',
    compactionUndoAvailable: 'lightweight durable availability marker; cleared on permanent deletion',
    compactionRedoAvailable: 'lightweight durable availability marker; cleared on permanent deletion',
  };
  // Released by the archive/delete handlers rather than `forgetConversation`, because
  // archive keeps them durable under `sleepycode.compactionSnapshots.<id>` and reloads
  // them on un-archive.
  const RELEASED_ELSEWHERE = {
    compactionUndoStacks: 'released by the archive and delete handlers',
    compactionRedoStacks: 'released by the archive and delete handlers',
  };

  const declared = [...agent.matchAll(/private (?:readonly )?(\w+)(?::[^=]+)? = new (?:Map|Set)<string/g)].map(match => match[1]);
  assert.ok(declared.length >= 15, `expected to find the class's string-keyed collections, found ${declared.length}`);
  const classified = new Set([...Object.keys(NOT_CONVERSATION_KEYED), ...Object.keys(RELEASED_ELSEWHERE)]);
  const unhandled = declared.filter(name => !classified.has(name) && !new RegExp(`this\\.${name}\\.delete\\(id\\);`).test(body));
  assert.deepEqual(unhandled, [], 'a string-keyed collection must be released with the conversation, or classified with the reason its lifetime is owned elsewhere');

  // Every declared name must be accounted for, so a stale classification is caught too.
  for (const name of classified) {
    assert.ok(declared.includes(name), `"${name}" is classified but no longer declared; the classification is stale`);
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
  //
  // The cache and every way it can be dropped now live in `RepoIndexService`, so the
  // guarantee is asserted at its owner rather than at the provider that delegates to it.
  const service = readFileSync('src/repo-index-service.ts', 'utf8');
  assertSource(service, /private cache\?: \{ root: string; index: RepoIndex \};/, 'the index has exactly one home');
  assertSource(service, /dispose\(\): void \{\s*this\.cache = undefined;/, 'there is one way to drop it');
  // The provider must not hold a second copy: that is the shape that leaked.
  assert.doesNotMatch(agent, /repoIndexCache/, 'the provider keeps no cache of its own');
  assertSource(agent, /private releaseRepoIndex\(\): void \{\s*this\.repoIndex\.dispose\(\);/, 'the provider drops it through the owner');
  const changed = agent.slice(agent.indexOf('private onWorkspaceFoldersChanged'), agent.indexOf('private scheduleProjectReindex'));
  assertSource(changed, /this\.releaseRepoIndex\(\);/, 'a folder change must drop the index');
  const dispose = agent.slice(agent.indexOf('dispose(): void {'), agent.indexOf('private loadProjects()'));
  assertSource(dispose, /this\.releaseRepoIndex\(\);/, 'dispose must drop the index');
});

test('a file change updates the index entry rather than leaving stale contents', () => {
  // The index holds full file contents. Before this, an edit left the pre-edit text in the
  // index, so a later search could hand the agent source that no longer existed.
  const service = readFileSync('src/repo-index-service.ts', 'utf8');
  assertSource(service, /refreshEntry\(root: vscode\.Uri, relative: string, uri: vscode\.Uri\): void \{/, 'there is a targeted refresh');
  assertSource(service, /cached\.index\.upsert\(\{ path: relative, content: readFileSync\(uri\.fsPath, 'utf8'\) \}\);/, 'an edited file is re-read');
  assertSource(service, /cached\.index\.remove\(relative\)/, 'a removed or unreadable file is dropped');
  const scheduled = agent.slice(agent.indexOf('private scheduleProjectReindex'), agent.indexOf('private async ensureProjectIntelligence'));
  assertSource(scheduled, /this\.refreshRepoIndexEntry\(root, relative, uri\);/, 'the file watcher calls it');
  assertSource(agent, /private refreshRepoIndexEntry\(root: vscode\.Uri, relative: string, uri: vscode\.Uri\): void \{\s*this\.repoIndex\.refreshEntry\(root, relative, uri\);/, 'the provider delegates the refresh');
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


test('the React markdown cache is bounded by entries, bytes and a per-entry ceiling', () => {
  // The behavioural tests in `test/markdown-cache-ui.direct.mjs` prove output stays correct
  // under churn, but eviction affects MEMORY, not output -- removing the eviction loop
  // entirely still passes them. So the bounds themselves are pinned here, where they are
  // visible. The vanilla webview's superseded cache had these three limits and 8 unit tests;
  // this is the React-side replacement for that guard.
  const markdown = readFileSync('webview-ui/shared/markdown.ts', 'utf8');
  assertSource(markdown, /const CACHE_LIMIT = 240;/, 'an entry cap');
  assertSource(markdown, /const CACHE_BYTES = 4 \* 1024 \* 1024;/, 'a byte budget');
  assertSource(markdown, /const MAX_ENTRY_BYTES = 512 \* 1024;/, 'a per-entry ceiling');
  assertSource(markdown, /while \(cache\.size > CACHE_LIMIT \|\| cacheBytes > CACHE_BYTES\)/, 'the eviction loop runs on both limits');
  // Eviction must subtract from the running byte total, or the budget drifts and the cache
  // grows forever while `cacheBytes` still reads as bounded.
  assertSource(markdown, /cacheBytes -= \(oldest\.length \+ cache\.get\(oldest\)!\.html\.length\) \* 2;/, 'eviction decrements the byte total');
  // An oversized entry is returned WITHOUT being cached, so its bytes are never counted.
  assertSource(markdown, /if \(bytes > MAX_ENTRY_BYTES\) return entry;/, 'an oversized entry is not retained');
});

test('a duplicate send still settles its optimistic attachments', () => {
  // `sendingConversations` guards against running the same conversation twice. That
  // early return used to sit BEFORE the attachment stage, so `attachmentsResolved`
  // never fired and any image on the duplicate turn waited forever for a reply.
  const start = agent.indexOf('sendingConversations.has(conversationId)');
  assert.ok(start > 0, 'the duplicate-send guard must exist');
  const body = agent.slice(start, start + 600);
  assert.match(body, /this\.postAcceptedAttachments\(/, 'the optimistic turn is settled on the duplicate path');
  assert.doesNotMatch(body.slice(0, body.indexOf('return;')), /return;\s*\}/, 'settling happens before the early return');
});

test('reopening the sidebar does not reload, re-migrate, or re-probe', () => {
  // The view is disposable (`retainContextWhenHidden: false`), so resolveWebviewView
  // runs on every open. Anything expensive on that path is paid per sidebar click on
  // the extension host's single thread, which reads as the whole editor stuttering.
  const start = agent.indexOf('resolveWebviewView(view: vscode.WebviewView)');
  const body = agent.slice(start, agent.indexOf('private sendCachedModelGroups', start) + 4000 || start + 12000);

  // Projects load once; a reopened view republishes in-memory state instead of
  // re-reading blobs, re-normalizing the transcript, retrying migration and
  // rewriting every conversation record.
  assertSource(agent, /private projectsLoaded = false;/, 'the once-per-session load flag exists');
  assertSource(agent, /private loadProjects\(\): void \{\s*\/\/[\s\S]{0,600}?if \(this\.projectsLoaded\) return;/, 'loadProjects short-circuits after the first load');

  // The MCP warm-up spawns a login shell and connects every enabled server. Once.
  assertSource(agent, /private mcpWarmedOnce = false;/, 'the once-per-session MCP flag exists');
  assertSource(agent, /if \(!this\.mcpWarmedOnce\) \{[\s\S]{0,160}this\.mcpWarmedOnce = true;[\s\S]{0,120}this\.warmMcpConnections\(\);/, 'the warm-up is guarded');

  // No awaited provider round trip before the chat can paint.
  const readyStart = agent.indexOf("message.type === 'ready'");
  const ready = agent.slice(readyStart, readyStart + 2200);
  assert.doesNotMatch(ready, /await this\.refreshModels\(\)/, 'the ready path must not block on a model fetch');
  assertSource(ready, /MODEL_CACHE_TTL_MS/, 'a recent catalog is reused instead of re-fetched');
});

test('a fresh renderer is re-sent the model list and account it no longer has', () => {
  // Cached groups used to be posted only when the in-memory list was empty, which was
  // correct while the webview survived being hidden. Now every open is a fresh
  // renderer, so skipping the refresh without re-posting left an empty model picker.
  const start = agent.indexOf('private postCachedModelGroups');
  const body = agent.slice(start, start + 900);
  assert.doesNotMatch(body, /if \(this\.lastModelGroups\.length\) return;/, 'in-memory groups are posted, not skipped');
  assertSource(body, /this\.lastModelGroups\.length \? this\.lastModelGroups/, 'memory is preferred over disk');
  const account = agent.slice(agent.indexOf('private postCachedAccount'), agent.indexOf('private postCachedAccount') + 900);
  assert.doesNotMatch(account, /if \(this\.lastSleepyAccountRefresh\) return;/, 'the account is re-posted to a fresh renderer');
});

test('the engine resolve is bounded, and a stalled resolve does not fail the send', () => {
  // `cli-server.ts` allows the CLI 30 s to print a listening URL. Awaiting that
  // inside a send is what produced a 30-second silence with no stream and no error.
  const body = agent.slice(agent.indexOf('private async ensureEngine'), agent.indexOf('private async shutdownCli'));
  assertSource(body, /deadlineMs = AgentViewProvider\.ENGINE_DEADLINE_MS/, 'the wait is bounded by default');
  assertSource(body, /return this\.awaitEngine\(deadlineMs\);/, 'both the cached and fresh paths go through the deadline');
  // On timeout the resolve must keep running: cancelling it would throw away the
  // spawn that is still in progress and make the next send pay for it again.
  assertSource(body, /const ready = this\.engineReady;/, 'the in-flight resolve is reused, not restarted');
  assertSource(body, /return this\.engineStatus;/, 'a timeout degrades to the current engine instead of throwing');
  assertSource(agent, /private static readonly ENGINE_DEADLINE_MS = 8_000;/);
  // Falling back is only safe because a conversation with local history stays local
  // for good, so one chat cannot end up split across two engines.
  assertSource(agent, /hasLocalHistory: hasLocalHistory\(conversation\)/);
});

test('a stall inside run() is reported, and streaming is not mistaken for one', () => {
  // The send watchdog stopped at `stage('done')`, which fired when the run was
  // DISPATCHED — so the token refresh, model refresh, MCP connect and git snapshot
  // were all invisible. A stall there produced no stream, no error, and no log line.
  assertSource(agent, /private async runWithStages\(/, 'run is split so a stage reporter can wrap every exit');
  const runBody = agent.slice(agent.indexOf('private async run(userText'), agent.indexOf('private async runWithStages'));
  assertSource(runBody, /const stage = this\.beginSendStage\(conversationId\);/, 'run arms its own watchdog');
  assertSource(runBody, /stage\('done'\);/, 'and stops it on every exit, including throw');
  // Named stages for the awaits that can block on the network or on git.
  for (const marker of ['run.context', 'run.git-checkpoint', 'run.preflight', 'run.auth', 'run.stream-pending', 'run.streaming']) {
    assert.ok(agent.includes(`stage('${marker}')`), `run reports the ${marker} stage`);
  }
  // A single model step can legitimately take minutes. Once tokens flow, the
  // transcript is the progress indicator and the timer must stop claiming a hang.
  const stageBody = agent.slice(agent.indexOf('private beginSendStage'), agent.indexOf('private async askUser'));
  assertSource(stageBody, /const streaming = \(\): boolean => current === 'run\.streaming' \|\| current === 'run\.finalizing';/);
  assertSource(stageBody, /elapsed >= 20_000 && !streaming\(\)/, 'the user-facing stall message excludes streaming');
  assertSource(stageBody, /this\.log\('warn', 'message\.send\.stalled'/, 'but the log line still names the stage');
});

// ---------------------------------------------------------------------------
// The send-path context block: ordering, de-duplication, and that the reads overlap.
//
// `test/composer-context.test.mjs` mirrors this logic over an injectable fs so the
// prompt the model receives can be compared against the pre-parallel implementation
// without importing `vscode`. See that file for the equivalence matrix.

test('composerContextBlock starts every attachment read before awaiting any of them', async () => {
  const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
  const start = source.indexOf('private async composerContextBlock');
  const body = source.slice(start, source.indexOf('private customPersonas', start));

  // The reads must be started during classification, then joined once.
  assert.match(body, /const read = \(async \(\)/, 'each attachment read is created eagerly');
  assert.match(body, /await Promise\.all\(\[\s*activeRead,/, 'every read is joined in one pass');
  // The old shape: an await inside the per-attachment loop, which serialized the I/O.
  assert.doesNotMatch(
    body,
    /for \(const attachment of [\s\S]{0,2000}?await vscode\.workspace\.fs\.(stat|readFile)/,
    'no attachment I/O is awaited inside the per-attachment loop',
  );
  // Ordering and de-duplication stay sequential, because they decide the prompt text.
  assert.match(body, /if \(seen\.has\(entry\.relative\)\) continue;/, 'de-duplication happens at emit time');
  assert.match(body, /const \[activeSection, \.\.\.resolved\] = await Promise\.all/, 'the active file read overlaps the attachments');
});

test('the MCP idle close can never destroy a connection a run is using', () => {
  // `closeMcpCache` does not unlink the connection, it destroys it: `run()` captures it
  // by reference and binds its tools to it, and McpClient.dispose() rejects every pending
  // request ("MCP connection closed") and terminates stdio child processes. The timer used
  // to fire ten minutes after CONNECT with no check, so a run longer than ten minutes — a
  // long agentic loop, or an askUser prompt waiting on the user — began failing MCP tool
  // calls partway through and had server processes killed underneath it.
  const body = agent.slice(agent.indexOf('private armMcpIdleCleanup'), agent.indexOf('private editorContextTimer'));
  assertSource(body, /if \(this\.runs\.size > 0 \|\| this\.compactionControllers\.size > 0\) \{/, 'an active run defers the close');
  assertSource(body, /this\.armMcpIdleCleanup\(\);\s*return;/, 'and the timer re-arms instead of closing');
  assertSource(body, /AgentViewProvider\.MCP_IDLE_CLOSE_MS/, 'the interval is a named constant');
  // Re-armed on use, so it measures idle time rather than connection age.
  assertSource(agent, /this\.armMcpIdleCleanup\(\);\s*this\.log\('info', 'run\.mcp\.cached'/, 'cached use re-arms the idle clock');
  assertSource(agent, /this\.runs\.delete\(conversationId\);[\s\S]{0,400}this\.armMcpIdleCleanup\(\);/, 'the run end starts the idle clock');
});

test('a superseded MCP warm ladder stops instead of running a second probe', () => {
  // Clearing `mcpWarmTimer` does not cancel a ladder already awaiting its probe, so a
  // Reconnect (or the `mcpWarmActive` re-entry) started a second ladder: two concurrent
  // probes, each spawning a login shell and connecting every enabled server, with
  // `attempt` restarting at 0 so a down server was retried on two doubling schedules.
  const body = agent.slice(agent.indexOf('private async warmMcpConnections'), agent.indexOf('private hookRules'));
  assertSource(body, /const generation = \+\+this\.mcpWarmGeneration;/, 'each ladder takes a generation');
  assertSource(body, /const current = \(\): boolean => this\.mcpWarmGeneration === generation;/, 'and can tell it still owns the probe');
  assertSource(body, /if \(!current\(\)\) return;\s*attempt \+= 1;/, 'a superseded ladder does not probe');
  // Crucially, a superseded ladder must not post or re-arm: the newer one owns both.
  assertSource(body, /if \(!current\(\)\) return;\s*lastStatuses = statuses;/, 'nor publish statuses');
  assertSource(body, /if \(!current\(\)\) return;\s*this\.mcpWarmTimer = setTimeout/, 'nor re-arm the timer');
  assertSource(agent, /private mcpWarmGeneration = 0;/, 'the generation counter exists');
});

test('the MCP idle close behaves correctly across a long run, simulated on a fake clock', () => {
  // The source assertions above pin the SHAPE. This pins the BEHAVIOUR, on a simulated
  // clock, because the failure only appears in a long session and nobody will reproduce
  // it on demand. The logic mirrors `armMcpIdleCleanup` exactly; the pre-fix branch at
  // the end shows the bug it prevents.
  const MCP_IDLE_CLOSE_MS = 10 * 60_000;
  const makeProvider = () => ({
    runs: new Map(),
    compactionControllers: new Map(),
    mcpCache: { key: 'k', connection: {} },
    mcpIdleTimer: undefined,
    closes: 0,
    clock: 0,
    armMcpIdleCleanup() {
      if (!this.mcpCache) { this.mcpIdleTimer = undefined; return; }
      this.mcpIdleTimer = { at: this.clock + MCP_IDLE_CLOSE_MS };
    },
    advanceToNextTimer() {
      const t = this.mcpIdleTimer;
      if (!t) return false;
      this.clock = t.at;
      this.mcpIdleTimer = undefined;
      if (this.runs.size > 0 || this.compactionControllers.size > 0) { this.armMcpIdleCleanup(); return true; }
      this.mcpCache = undefined;
      this.closes += 1;
      return true;
    },
  });

  // A 25-minute run must not lose its connection.
  const during = makeProvider();
  during.armMcpIdleCleanup();
  during.runs.set('c1', {});
  while (during.clock < 25 * 60_000 && during.advanceToNextTimer()) { /* advance */ }
  assert.equal(during.closes, 0, 'a connection a live run depends on is never closed');

  // Once the run ends, the clock restarts and the connection is released.
  during.runs.delete('c1');
  during.armMcpIdleCleanup();
  during.advanceToNextTimer();
  assert.equal(during.closes, 1, 'it is still released once genuinely idle');

  // An idle session is released on schedule — the guard must not become a leak.
  const idle = makeProvider();
  idle.armMcpIdleCleanup();
  idle.advanceToNextTimer();
  assert.equal(idle.closes, 1, 'an unused connection is closed');

  // Compaction holds the connection too, so it defers the same way.
  const compacting = makeProvider();
  compacting.armMcpIdleCleanup();
  compacting.compactionControllers.set('c1', {});
  compacting.advanceToNextTimer();
  assert.equal(compacting.closes, 0, 'a compaction in flight also defers the close');

  // The pre-fix behaviour, for contrast: an unguarded timer destroys it mid-run.
  const before = makeProvider();
  before.runs.set('c1', {});
  before.clock = MCP_IDLE_CLOSE_MS;
  before.mcpCache = undefined;
  before.closes = 1;
  assert.equal(before.closes, 1, 'the bug this replaces: closed while a run was using it');
});

test('transcript snapshots are coalesced to one per frame, and never overtake newer messages', () => {
  // `syncConversations` is called from 34 sites and several fire per tool call. Each
  // call serializes the WHOLE active transcript and posts it as a structured clone —
  // megabytes on a long conversation, for a snapshot the next one supersedes within
  // milliseconds. Coalescing is only safe if ordering is preserved, because
  // `loadConversation` REPLACES the renderer's turns wholesale: a snapshot landing
  // after a `done` event, a `user` turn, or a delta the renderer applied incrementally
  // would roll that newer state back to an older copy. This mirrors the shipped
  // post/flush logic and asserts both properties.
  const makePoster = () => {
    const out = [];
    let pendingSnapshot;
    let snapTimer;
    let deltaTimer;
    const pendingDeltas = new Map();
    const postImmediate = (m) => out.push(m);
    const flushPendingSnapshot = () => {
      if (snapTimer) { clearTimeout(snapTimer); snapTimer = undefined; }
      if (!pendingSnapshot) return;
      const p = pendingSnapshot;
      pendingSnapshot = undefined;
      postImmediate(p);
    };
    const flushPendingDeltas = () => {
      if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = undefined; }
      flushPendingSnapshot();
      if (!pendingDeltas.size) return;
      const batch = [...pendingDeltas.entries()];
      pendingDeltas.clear();
      for (const [id, e] of batch) {
        if (e.reasoning) postImmediate({ type: 'reasoningDelta', conversationId: id, text: e.reasoning });
        if (e.text) postImmediate({ type: 'delta', conversationId: id, text: e.text });
      }
    };
    const post = (msg) => {
      if (msg.type === 'delta' || msg.type === 'reasoningDelta') {
        flushPendingSnapshot();
        const e = pendingDeltas.get(msg.conversationId) ?? { text: '', reasoning: '' };
        if (msg.type === 'delta') e.text += msg.text; else e.reasoning += msg.text;
        pendingDeltas.set(msg.conversationId, e);
        if (!deltaTimer) deltaTimer = setTimeout(() => { deltaTimer = undefined; flushPendingDeltas(); }, 16);
        return;
      }
      if (msg.type === 'conversation') {
        pendingSnapshot = msg;
        if (!snapTimer) snapTimer = setTimeout(() => { snapTimer = undefined; flushPendingSnapshot(); }, 16);
        return;
      }
      flushPendingSnapshot();
      if (pendingDeltas.size) flushPendingDeltas();
      postImmediate(msg);
    };
    return { post, out, flushAll: flushPendingDeltas };
  };

  const coalesced = makePoster();
  for (let i = 0; i < 20; i += 1) coalesced.post({ type: 'conversation', id: 'c1', n: i });
  coalesced.flushAll();
  const snaps = coalesced.out.filter(m => m.type === 'conversation');
  assert.equal(snaps.length, 1, '20 snapshots collapse into one');
  assert.equal(snaps[0].n, 19, 'the newest snapshot is the one that survives');

  const beforeDone = makePoster();
  beforeDone.post({ type: 'conversation', id: 'c1', n: 1 });
  beforeDone.post({ type: 'done', conversationId: 'c1' });
  assert.deepEqual(beforeDone.out.map(m => m.type), ['conversation', 'done'], 'a held snapshot flushes before `done`');

  const beforeDelta = makePoster();
  beforeDelta.post({ type: 'conversation', id: 'c1', n: 1 });
  beforeDelta.post({ type: 'delta', conversationId: 'c1', text: 'hello' });
  beforeDelta.flushAll();
  assert.deepEqual(beforeDelta.out.map(m => m.type), ['conversation', 'delta'], 'a snapshot lands before a delta streamed after it');

  const timerOrder = makePoster();
  timerOrder.post({ type: 'delta', conversationId: 'c1', text: 'a' });
  timerOrder.post({ type: 'conversation', id: 'c1', n: 7 });
  timerOrder.flushAll();
  assert.deepEqual(timerOrder.out.map(m => m.type), ['conversation', 'delta'], 'the delta timer cannot flush a delta ahead of a held snapshot');

  // And the shipped source must still flush on both paths, or the ordering above is a
  // property of this test rather than of the extension.
  // The helper is declared before `post`, so the slice starts at the helper.
  const postBody = agent.slice(agent.indexOf('private flushPendingSnapshot(): void {'), agent.indexOf('private postImmediate'));
  assertSource(postBody, /private flushPendingSnapshot\(\): void \{/, 'the flush helper exists');
  assertSource(postBody, /if \(msg\.type === 'conversation' && typeof msg\.id === 'string'\)/, 'snapshots are the held type');
  assertSource(postBody, /this\.postImmediate\(pending\.message\);/, 'the held snapshot is posted by the helper');
  const deltasBody = agent.slice(agent.indexOf('private flushPendingDeltas'), agent.indexOf('private post(message: unknown)'));
  assertSource(deltasBody, /this\.flushPendingSnapshot\(\);/, 'the delta timer flushes a held snapshot first');
});

test('the file-icon cache is bounded, and fragments still streaming in are not cached', () => {
  // Keyed by lowercased file name, so it grows with every distinct name ever asked
  // about rather than with the theme. Tool.tsx re-subscribes WHILE a tool call's
  // arguments stream, so one mention of `src/components/AgentPanel.tsx` produces ~29
  // lookups (`agentpanel.`, `agentpanel.t`, …) and every one was retained forever.
  const source = readFileSync(new URL('../src/file-icons.ts', import.meta.url), 'utf8');
  assert.match(source, /const MAX_RESOLVED_ENTRIES = 2_000;/, 'the cache has a cap');
  // The window allows for the explanatory comment between the guard and the eviction.
  assert.match(source, /if \(resolved\.size >= MAX_RESOLVED_ENTRIES\) \{[\s\S]{0,600}resolved\.delete\(oldest\.value\);/, 'it evicts oldest-first when full');
  assert.match(source, /if \(isIncompleteName\(key\)\) return undefined;/, 'a fragment is answered but not resolved or cached');
  assert.match(source, /function isIncompleteName\(name: string\): boolean \{\s*return name\.endsWith\('\.'\);/, 'only a trailing dot counts as incomplete');
  // Invalidation must still clear both caches, or a theme change would serve stale icons.
  assert.match(source, /export function invalidateFileIconCache\(\): void \{[\s\S]{0,160}resolved\.clear\(\);[\s\S]{0,120}dataUris\.clear\(\);/, 'invalidation clears both maps');
});

test('a streamed path bounds the icon cache instead of growing it forever', () => {
  // Mirrors the shipped resolveFileIcon map behaviour on the one axis that matters:
  // how many entries survive a stream of partial names. `doResolve` is stubbed because
  // the real one needs a VS Code icon theme, which is not present under the test runner.
  const MAX = 2_000;
  const cache = new Map();
  const isIncomplete = (name) => name.endsWith('.');
  const resolve = (name) => {
    const key = String(name || '').toLowerCase();
    if (!key) return undefined;
    if (cache.has(key)) return cache.get(key);
    if (isIncomplete(key)) return undefined;
    if (cache.size >= MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, undefined);
    return undefined;
  };

  // One streamed path, as Tool.tsx produces while args arrive.
  const target = 'src/components/AgentPanel.tsx';
  const partials = [];
  let cur = '';
  for (const ch of target) { cur += ch; partials.push(cur.toLowerCase()); }
  assert.ok(partials.length > 20, 'a single path really does produce many fragments');

  for (let i = 0; i < 200; i += 1) for (const p of partials) resolve(p);
  // Trailing-dot fragments are never cached, so only the real names accumulate.
  const afterOnePath = cache.size;
  assert.ok(afterOnePath < partials.length, `cached ${afterOnePath} of ${partials.length} fragments; incomplete ones are skipped`);

  // Many distinct files must not grow the map past the cap.
  for (let f = 0; f < 10_000; f += 1) resolve(`src/f${f}.tsx`);
  assert.equal(cache.size, MAX, 'the cache holds exactly its cap after unbounded traffic');

  // A real single-letter extension must still resolve - the narrow rule matters.
  resolve('notes.c');
  resolve('archive.tar.gz');
  assert.ok(!isIncomplete('notes.c'), 'a one-letter extension is a real name, not a fragment');
  assert.ok(!isIncomplete('archive.tar.gz'), 'a multi-dot name is a real name');
});
