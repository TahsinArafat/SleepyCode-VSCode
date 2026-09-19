import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPACTION_OUTPUT_BUDGET } from '../src/compaction-core.ts';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const agent = read('src/agent.ts');
const runtime = read('src/webview/runtime.ts');
const webviewHtml = read('src/webview.ts');
const compactionCore = read('src/compaction-core.ts');
const util = read('src/util.ts');
const git = read('src/git.ts');
const styles = read('src/webview/styles.ts');
const tools = read('src/tools.ts');
const skills = read('src/skills.ts');
const types = read('src/types.ts');
const pkg = JSON.parse(read('package.json'));

test('SleepyCode rebrand removes the legacy product identity from primary surfaces', () => {
  const primary = [
    JSON.stringify(pkg),
    read('README.md'),
    read('src/extension.ts'),
    agent,
    runtime,
    styles,
  ].join('\n');
  assert.equal(pkg.name, 'sleepycode-agent');
  assert.equal(pkg.displayName, 'SleepyCode');
  assert.equal(new RegExp(['Sleepy', 'IDE'].join('') + '|' + ['sleepy', 'ide'].join('')).test(primary), false);
});

test('subagent events have explicit lifecycle and child-parent routing', () => {
  assert.match(agent, /type: 'subagent'.*phase: 'start'/s);
  assert.match(agent, /parentId: subagentId/);
  assert.match(agent, /subagentSequence/);
  assert.match(runtime, /case'subagent'/);
  assert.match(runtime, /const parentId=m\.parentId/);
  assert.doesNotMatch(runtime, /startsWith\(['"]subagent-['"]\)/);
});

test('subagents cannot recurse and failures propagate to the parent agent', () => {
  assert.match(agent, /delete subagentTools\.delegate_task/);
  assert.match(tools, /Subagents cannot recursively delegate/);
  assert.match(agent, /throw new Error\(`Subagent \(\$\{role\}\) failed:/);
});

test('message history scrolls independently from a bounded composer', () => {
  assert.match(styles, /html,body\{[^}]*overflow:hidden/);
  assert.match(styles, /#messages\{[^}]*flex:1 1 0[^}]*overflow-y:auto/);
  assert.match(styles, /\.composer\{[^}]*flex:0 0 auto/);
  assert.match(styles, /max-height:min\(180px,28vh\)/);
  assert.match(runtime, /ResizeObserver/);
});

test('run preflight failures still reach structured error handling and cleanup', () => {
  assert.match(agent, /try \{[\s\S]*?if \(!providerConfig\) throw new Error/);
  // Chat preflight must not scan the workspace or enumerate skills before the request.
  assert.match(agent, /run\.fastlane\.ready/);
  assert.doesNotMatch(agent, /run\.skills\.start/);
  assert.doesNotMatch(agent, /captureGitTree\(root\.fsPath/);
  assert.match(agent, /await this\.refreshModels\(\);\s*configuredModel = this\.selectionFor\(conversation\)\.model/);
  assert.match(agent, /if \(!sleepyToken\) throw new Error\('SleepyAI session is missing or expired/);
  assert.match(agent, /finally\s*\{[\s\S]*this\.runs\.delete\(conversationId\)/);
});

test('chat text breaks pathological long words without wrapping code blocks', () => {
  assert.match(styles, /\.user-text\{[^}]*overflow-wrap:anywhere[^}]*word-break:break-word/);
  assert.match(styles, /\.assistant\{[^}]*overflow-wrap:anywhere[^}]*word-break:break-word/);
  assert.match(styles, /\.assistant pre,\.assistant pre code\{[^}]*overflow-wrap:normal[^}]*word-break:normal/);
});

test('agent iterations default to 200 steps and expose a resumable max-step pause', () => {
  assert.equal(pkg.contributes.configuration.properties['sleepycode.maxSteps'].default, 200);
  assert.match(agent, /config\.get<number>\('maxSteps', 200\)/);
  assert.match(agent, /config\.update\('maxSteps', 200/);
  assert.match(agent, /pausedByStepLimit\(maxSteps, lastIterationStepCount, finishReason\)/);
  assert.match(agent, /message\.type === 'continueIteration'/);
  assert.match(types, /paused\?: boolean/);
  assert.match(runtime, /Continue iteration/);
});

test('sending during an active run queues without rendering a fake first send', () => {
  assert.match(runtime, /if\(wasRunning\)\{const list=queuedByConversation\.get\(activeConversationId\)\|\|\[\];list\.push\(\{id:'tmp-'\+Date\.now\(\),text:optimisticText\}\);queuedByConversation\.set\(activeConversationId,list\);updateQueuedVisibility\(\);vscode\.postMessage\(\{type:'send'/);
  const queuedBranch = runtime.match(/if\(wasRunning\)\{([\s\S]*?)updateSendMode\(\);return\}/)?.[1] ?? '';
  assert.doesNotMatch(queuedBranch, /beginTurn\(/);
  assert.doesNotMatch(queuedBranch, /runningSet\.add/);
});

test('queue keeps every follow-up sent during a run (multi-message queue)', () => {
  // Server keeps one entry per queued prompt instead of replacing the previous one.
  assert.match(agent, /this\.queue\.push\(\{ id: `q\$\{\+\+this\.queueSeq\}`, text, conversationId, context, promptContext \}\)/);
  assert.doesNotMatch(agent, /this\.queue = this\.queue\.filter\(entry => entry\.conversationId !== conversationId\);\n\s*this\.queue\.push/);
  assert.match(agent, /prompts: entries\.map\(entry => entry\.text\), ids: entries\.map\(entry => entry\.id\)/);
  assert.match(runtime, /case'queuedPrompt':\{const ids=m\.ids\|\|\[\],texts=m\.prompts\|\|\[\]/);
});

test('installed marketplace skills can be read and explicitly used', () => {
  assert.match(skills, /export async function readInstalledSkill/);
  assert.match(tools, /tools\.skillsmp_read_installed = tool/);
  assert.match(agent, /call skillsmp_read_installed/);
  assert.match(runtime, /data-use-skill/);
  assert.match(runtime, /Use the .* skill to/);
});

test('composer slash commands expose extension actions and dynamic installed-skill invocation', () => {
  assert.match(runtime, /const SLASH_COMMANDS=\[/);
  for (const command of ['/skill', '/new', '/settings', '/usage', '/skills', '/marketplace', '/memory', '/reindex', '/context', '/model', '/agent', '/permissions']) {
    assert.ok(runtime.includes(`command:'${command}'`), `${command} is present`);
  }
  assert.match(runtime, /installedSkills\.filter\(skill=>/);
  assert.match(runtime, /The user explicitly invoked the installed skill/);
  assert.match(runtime, /vscode\.postMessage\(\{type:'requestMarketplaceInstalled'\}\)/);
});

test('system instructions actively discover and load installed skills before use', () => {
  assert.match(agent, /skillsmp_list_installed \/ skillsmp_read_installed/);
  assert.match(agent, /inspect the Installed skills inventory included in your instructions/);
  assert.match(agent, /If the user explicitly invoked \/skill/);
  assert.match(agent, /Skill instructions are subordinate to SleepyCode safety/);
  assert.match(skills, /Installed skills inventory \(metadata only/);
  assert.match(skills, /Actively consider this list for every substantive request/);
});

test('context occupancy is measured from provider prompt_tokens, never from cumulative counters', () => {
  // The pre-fix "5.33M / 1M" bug summed per-item lifetime token counters and
  // displayed the total as context-window usage. That pattern must not return.
  assert.doesNotMatch(agent, /sessionMetricsForConversation/);
  const sessionMetrics = runtime.match(/function sessionMetrics\(\)\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(sessionMetrics, 'sessionMetrics exists in the webview runtime');
  assert.doesNotMatch(sessionMetrics, /contextTokens\s*=\s*inTok\+outTok/);
  // Measured prompt_tokens (item.contextTokens) is preferred over the chars/4
  // estimate, which remains only as a fallback for fresh/compacted sessions.
  assert.match(sessionMetrics, /contextTokens=t;measured=true/);
  assert.match(sessionMetrics, /contextTokens=1500\+Math\.ceil\(chars\/4\)/);
  assert.match(runtime, /statContext\.textContent=\(s\.measured\?'':'~'\)\+fmt\(s\.contextTokens\)/);
  assert.match(compactionCore, /export function contextOccupancy/);
  assert.match(compactionCore, /export function estimateContextTokens/);
});

test('auto-compaction runs after the run leaves this.runs, with a cooldown', () => {
  const finallyBlock = agent.match(/\} finally \{[\s\S]*?await mcpConnection\?\.close\(\);[\s\S]*?this\.postQueued/)?.[0] ?? '';
  assert.ok(finallyBlock, 'run() finally block found');
  assert.match(finallyBlock, /this\.runs\.delete\(conversationId\);[\s\S]*?maybeAutoCompact\(conversation/);
  assert.match(agent, /lastAutoCompactAt\.get\(conversation\.id\) \?\? 0\) < 120_000/);
  assert.doesNotMatch(agent, /if \(providerConfig\.id === 'sleepyai'\) \{\s*const session/);
});

test('compaction progress replaces the modal protocol and supports cancellation', () => {
  assert.doesNotMatch(agent + runtime + types, /compactStatus/);
  assert.match(types, /type: 'compactProgress'/);
  assert.match(types, /type: 'cancelCompact'/);
  assert.match(runtime, /case'compactProgress':handleCompactProgress\(m\)/);
  assert.match(runtime, /vscode\.postMessage\(\{type:'cancelCompact'/);
  assert.match(agent, /compactionControllers\.get\(compactTargetId\)\?\.abort\(\)/);
  // The raw signal is wrapped with a per-attempt timeout; user cancellation must
  // still be detected against the ORIGINAL signal, never fail over to the next model.
  assert.match(agent, /AbortSignal\.any\(\[signal, AbortSignal\.timeout\(/);
  assert.match(agent, /abortSignal: attemptSignal/);
  assert.match(agent, /if \(signal\.aborted\) throw error; \/\/ cancellation must not fall through/);
  assert.match(webviewHtml, /id="compactionOverlay"/);
  assert.match(styles, /\.compaction-overlay\{/);
});

test('summary items record only the compaction call usage, not pre-compaction totals', () => {
  const summarize = agent.match(/private async summarizeConversation\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(summarize, 'summarizeConversation found');
  assert.doesNotMatch(summarize, /items\.reduce\(\(sum, item\)/);
  assert.match(summarize, /usage = attemptUsage/);
  assert.match(summarize, /if \(usage\?\.inputTokens\) summary\.inputTokens = usage\.inputTokens/);
  assert.match(summarize, /compactionPromptInput\(items\)/);
});

test('compaction candidates get real output headroom, not the reasoning-starving 1024 cap', () => {
  const summarize = agent.match(/private async summarizeConversation\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(summarize, 'summarizeConversation found');
  // Reasoning models spend output tokens on thinking before text: the old fixed
  // maxOutputTokens: 1024 made every reasoning model return EMPTY text while the
  // provider dashboard showed a valid completion, so compaction hopped model
  // after model. The budget must come from the shared helper with headroom.
  assert.doesNotMatch(summarize, /maxOutputTokens:\s*1024/);
  assert.match(summarize, /maxOutputTokens:\s*budget/);
  assert.match(summarize, /compactionOutputBudget\(/);
  assert.ok(COMPACTION_OUTPUT_BUDGET >= 4096, 'budget leaves room for reasoning + summary');
});

test('compaction summarizer uses streamText, not generateText (relay always streams SSE)', () => {
  // The SleepyAI relay answers every request with an SSE stream even when the
  // client sends stream:false. generateText parses the body as JSON, throws
  // "Invalid JSON response", and compaction hops model after model while the
  // dashboard shows a valid completion. streamText requests stream:true and
  // parses that same SSE — the same transport the main run loop uses.
  const summarize = agent.match(/private async summarizeConversation\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(summarize, 'summarizeConversation found');
  assert.doesNotMatch(summarize, /generateText\(/);
  assert.match(summarize, /await streamText\(\{ model: provider\(candidateId\)/);
  assert.match(summarize, /await result\.usage/);
  assert.match(summarize, /await result\.text/);
  assert.doesNotMatch(agent, /import \{ ToolLoopAgent, generateText/);
  assert.match(agent, /import \{ ToolLoopAgent, streamText/);
});

test('compaction fails loudly with per-candidate reasons instead of a placeholder summary', () => {
  const summarize = agent.match(/private async summarizeConversation\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(summarize, 'summarizeConversation found');
  // The placeholder fallback ("Compacted context. Original message count: N.")
  // replaced the whole transcript with garbage and reported success.
  assert.doesNotMatch(summarize, /Original message count/);
  assert.match(summarize, /failures\.push/);
  assert.match(summarize, /No model could summarize the conversation/);
  // Every completed attempt (even a rejected empty one) burns tokens: record it.
  assert.match(summarize, /recordUsage\(this\.context/);
  // A hung candidate must fail over, and usage must not be double-recorded by the caller.
  assert.match(summarize, /AbortSignal\.timeout/);
  const compact = agent.match(/private async compactConversation\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(compact, 'compactConversation found');
  assert.doesNotMatch(compact, /recordUsage\(/);
});

test('/compact fires immediately and only as an exact command', () => {
  assert.match(runtime, /case'\/compact':handleCompactProgress\(\{conversationId:activeConversationId,phase:'start'\}\)/);
  assert.match(runtime, /if\(trimmed\.toLowerCase\(\)===first&&runDirectSlash\(first\)\)/);
});

test('context window updates live from the latest step prompt_tokens, not only after the run', () => {
  // The context pill must reflect the provider's prompt_tokens for the CURRENT
  // run as it progresses. The liveUsage message carries the latest step's
  // prompt_tokens (not the cumulative liveInput, which is lifetime spend).
  assert.match(agent, /type: 'liveUsage'.*contextTokens: input/s);
  // The webview stores the live context tokens and prefers them over the last
  // committed assistant item (which reflects the previous run).
  assert.match(runtime, /contextTokens:m\.contextTokens\|\|0/);
  const sessionMetrics = runtime.match(/function sessionMetrics\(\)\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(sessionMetrics, 'sessionMetrics exists in the webview runtime');
  assert.match(sessionMetrics, /live\.contextTokens/);
  assert.match(sessionMetrics, /contextTokens=live\.contextTokens;measured=true/);
});

test('compaction emits a divider marker, not a synthetic continuation message', () => {
  // The old "Continue from the compacted context above." user message was sent to
  // the model as a fake turn and cluttered the transcript. It must be gone, replaced
  // by an empty-text divider marker that is never sent to the model.
  assert.doesNotMatch(agent, /Continue from the compacted context above\./);
  assert.match(agent, /createTranscriptItem\('user', '', 'divider'\)/);
  assert.match(types, /kind\?: 'error' \| 'divider'/);
  assert.match(util, /kind\?: 'error' \| 'divider'/);
});

test('divider markers are excluded from the run prompt and summarizer input', () => {
  assert.match(agent, /\.filter\(item => item\.kind !== 'divider'\)/);
  assert.match(compactionCore, /\.filter\(item => item\.kind !== 'divider'\)/);
  assert.match(compactionCore, /if \(item\.kind === 'divider'\) continue/);
});

test('compaction is undoable and redoable via divider boundary snapshots', () => {
  assert.match(agent, /compactionUndoStacks = new Map/);
  assert.match(agent, /compactionRedoStacks = new Map/);
  assert.match(agent, /private undoCompaction\(conversation/);
  assert.match(agent, /private redoCompaction\(conversation/);
  assert.match(agent, /before: before\.slice\(\), after: summarized\.items\.slice\(\)/);
  assert.match(agent, /kind === 'divider'\) \{\s*if \(!this\.undoCompaction\(conversation\)\) return;/s);
  assert.match(agent, /if \(this\.redoCompaction\(conversation\)\)/);
  assert.match(agent, /compactionUndoable, compactionRedoable/);
});

test('webview renders the compaction divider and adapts undo/redo copy', () => {
  assert.match(runtime, /item\.kind==='divider'\)\{messages\.appendChild\(dividerRow\(\)\)/);
  assert.match(runtime, /compactionUndoable\?\{title:'Undo compaction\?'/);
  assert.match(runtime, /compactionRedoable\?\{title:'Redo compaction\?'/);
  assert.match(runtime, /compactionUndoable=Boolean\(m\.compactionUndoable\)/);
  assert.match(styles, /\.compaction-divider\{/);
});

test('error item preserves partial streamed text for retry continuation', () => {
  // TranscriptItem type has partialText field
  assert.match(types, /partialText\?: string/);
  // normalizeTranscriptItem passes through partialText
  assert.match(util, /partialText: item\.partialText/);
  // Agent captures the longest partial answer during streaming
  assert.match(agent, /let partialAnswer = '';/);
  assert.match(agent, /partialAnswer = answer/);
  // Error item stores the partial text
  assert.match(agent, /errorItem\.partialText = partialAnswer/);
  // Retry handler carries partialText in the resume payload
  assert.match(agent, /partialText: last\.partialText/);
  // Resume context includes partial text for the model
  assert.match(agent, /resume\?\.partialText \?/);
  assert.match(agent, /Continue it from exactly where it stops/);
  // Final answer prepends the preserved partial
  assert.match(agent, /resume\?\.partialText \? resume\.partialText.+answer : answer/);
  // Continue-iteration also carries the half-written text
  assert.match(agent, /partialText: last\.text/);
  assert.match(agent, /pausePlaceholder/);
  // Webview shows the partial text on error instead of removing it
  assert.match(runtime, /current\.classList\.remove\('streaming'\)/);
  assert.match(runtime, /interruptedMarker/);
  assert.match(runtime, /interrupted-note/);
  // Webview renders partial text in conversation re-render
  assert.match(runtime, /next\.partialText/);
  // Webview injects partial text on resume
  assert.match(runtime, /m\.partialText\|\|''/);
  assert.match(runtime, /current\.dataset\.raw=m\.partialText/);
  // CSS for the interrupted marker
  assert.match(styles, /interrupted-note/);
  // Resume message includes partialText
  assert.match(agent, /type: 'resume'.*partialText: resume\.partialText/);
});

test('structured model history persists across turns instead of flattening to text', () => {
  // Conversation stores the real model-visible message array alongside display items.
  assert.match(types, /messages\?: ModelMessage\[\]/);
  assert.match(types, /export const MAX_STORED_MESSAGES/);
  // The run seeds the provider with real messages when structured history exists.
  assert.match(agent, /const history = resume \? \[\] : this\.structuredHistory\(conversation\)/);
  assert.match(agent, /messages: agentMessages/);
  // Response messages (assistant tool calls + tool results) are captured and kept.
  assert.match(agent, /runMessages\.push\(\.\.\.\(responseMessages as ModelMessage\[\]\)\.filter\(message => message\.role !== 'system'\)\)/);
  assert.match(agent, /this\.appendConversationMessages\(conversation, userText, runMessages\)/);
  // History must never start with a tool result: strict providers reject it.
  assert.match(agent, /let start = stored\.findIndex\(message => message\.role === 'user'\)/);
  // Legacy conversations without structured history still use the text fallback.
  assert.match(agent, /const structured = this\.structuredHistory\(conversation\)/);
});

test('compaction and rollbacks keep structured history in sync with the transcript', () => {
  // Compaction replaces the structured history with the summary, never replays it.
  assert.match(agent, /conversation\.messages = \[/);
  assert.match(agent, /summaryText: string/);
  assert.match(agent, /summaryText: summary\.text/);
  // Undo/redo and checkpoint restores drop stale structured history.
  assert.match(agent, /conversation\.messages = undefined;/);
});

test('an interrupted run keeps its partial work instead of losing it', () => {
  // Partial structured messages are checkpointed after every completed iteration.
  assert.match(agent, /conversation\.pending = \{ userText, messages: runMessages\.slice\(\), startedAt:/);
  assert.match(types, /pending\?: \{ userText: string; messages: ModelMessage\[\]; startedAt: number \}/);
  // The abort branch folds the partial turn into history and clears pending.
  assert.match(agent, /if \(run\.controller\.signal\.aborted\) \{[\s\S]{0,400}appendConversationMessages\(conversation, userText, runMessages\)/);
  // The error branch does the same so a retry continues rather than re-reading.
  assert.match(agent, /conversation\.pending = undefined;/);
  // A reload/crash recovers the pending turn into structured history on load.
  assert.match(agent, /const pending = conversation\.pending;/);
  assert.match(agent, /carried\.slice\(-MAX_STORED_MESSAGES\)/);
  // Exactly one declaration, in the outer run scope so catch/finally can reach it.
  assert.equal((agent.match(/let runMessages: ModelMessage\[\] = \[\];/g) || []).length, 1);
});

test('no destructive truncation remains in tool output paths', () => {
  // The destructive helper is gone entirely; oversized output is archived instead.
  assert.doesNotMatch(tools, /truncate\(content\)/);
  assert.doesNotMatch(agent, /truncate\(content\)/);
  assert.doesNotMatch(git, /truncate\(output/);
  // Skill reads and marketplace previews no longer silently shorten content.
  assert.match(tools, /capObservation\(ctx\.observationsDir\(\), 'skillsmp_get_skill'/);
  assert.match(tools, /capObservation\(ctx\.observationsDir\(\), 'skillsmp_read_installed'/);
  assert.match(agent, /not shown in this preview/);
  // Command output keeps head and a rolling tail while streaming, and says so.
  assert.match(git, /bytes elided from an earlier part of the output/);
  // Archival is the single non-destructive path.
  assert.match(tools, /import \{ capObservation, readObservationPage \} from '\.\/observations'/);
});
