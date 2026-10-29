import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { COMPACTION_OUTPUT_BUDGET } from '../src/compaction-core.ts';

import { assertSource } from './source-assert.mjs';
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
const cliClient = read('src/cli-client.ts');
const cliServer = read('src/cli-server.ts');
const cliEngine = read('src/cli-engine.ts');
const cliProjection = read('src/cli-projection.ts');
const types = read('src/types.ts');
const iterationCore = read('src/iteration-core.ts');
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
  assertSource(runtime, /case'subagent'/);
  assertSource(runtime, /const parentId=m\.parentId/);
  assert.doesNotMatch(runtime, /startsWith\(['"]subagent-['"]\)/);
});

test('subagents cannot recurse and failures propagate to the parent agent', () => {
  // The tool set variable is now role-filtered before the ceiling is applied;
  // the guarantee is unchanged: a subagent is never offered delegation.
  assert.match(agent, /delete roleTools\.delegate_task/);
  assert.match(tools, /Subagents cannot recursively delegate/);
  // A genuine failure still propagates with the same wording; a user-cancelled
  // subagent is reported as cancelled rather than as a defect.
  assert.match(agent, /throw new Error\(cancelled \?/);
  assert.match(agent, /Subagent \(\$\{role\}\) failed:/);
  assert.match(agent, /Subagent \(\$\{role\}\) was cancelled\./);
});

test('subagent results harvest leftover step text instead of returning empty', () => {
  assert.match(agent, /classifySubagentStep\(stepText, nativeCallCount, xmlCalls\.length\)/);
  assert.match(agent, /leftoverText = rememberVisibleText\(leftoverText, decision\.visibleText\)/);
  assert.match(agent, /harvestSubagentText\(subagentText, leftoverText\)/);
  assert.doesNotMatch(agent, /lastTextOnly/);
});

test('header keeps the conversation switcher first and a quiet action cluster', () => {
  const header = webviewHtml.match(/<div class="top">[\s\S]*?<div class="login-banner"/)?.[0] ?? '';
  assert.ok(header.includes('id="conversationButton"'), 'conversation switcher exists');
  assert.ok(header.includes('class="chat-actions"'), 'secondary header actions are grouped');
  assert.ok(header.indexOf('id="conversationButton"') < header.indexOf('class="chat-actions"'), 'title stays first');
  assert.ok(header.indexOf('id="newConversation"') < header.indexOf('id="settingsButton"'), 'new chat stays before settings');
  assert.match(header, /id="conversationButton"[^>]*aria-expanded="false"/);
  assert.match(header, /id="newConversation"[\s\S]*<path d="M12 5v14"/);
  assert.doesNotMatch(header, /settings-icon/);
  assertSource(runtime, /function setConversationMenuOpen\(open\)/);
  assertSource(runtime, /setAttribute\('aria-expanded',open\?'true':'false'\)/);
  assert.match(styles, /\.chat-actions\{display:flex/);
  assert.match(styles, /\.chat-actions\{[^}]*margin-left:auto/);
  assert.match(styles, /\.conversation-title\{[^}]*font-size:12px/);
  assert.match(styles, /\.chat-bar \.icon,|\.icon\{[^}]*width:26px/);
});

test('composer keeps the writing surface first and a quiet overflow-safe toolbar', () => {
  const composer = webviewHtml.match(/<div class="composer">[\s\S]*?<div class="usage"/)?.[0] ?? '';
  assert.ok(composer.includes('id="composerBox"'), 'composer box exists');
  assert.ok(composer.indexOf('id="sessionMetaRow"') < composer.indexOf('id="composerBox"'), 'status sits above the writing box');
  assert.ok(composer.indexOf('id="input"') < composer.indexOf('class="actions"'), 'textarea sits above the toolbar');
  assert.ok(composer.includes('class="composer-tools"'), 'secondary controls are grouped away from send');
  assert.ok(composer.indexOf('class="composer-tools"') < composer.indexOf('id="send"'), 'send stays last in the toolbar');
  assert.match(styles, /\.composer-tools\{display:flex/);
  assert.match(styles, /\.composer \.actions \.send\{[^}]*margin-left:auto/);
  assert.match(styles, /\.control-pill\{[^}]*background:transparent/);
  assert.match(styles, /\.context-summary\{[^}]*background:transparent/);
});

test('approval control stays a short text pill and send uses discrete idle/ready/stop states', () => {
  const composer = webviewHtml.match(/<div class="composer">[\s\S]*?<div class="usage"/)?.[0] ?? '';
  assert.match(composer, /id="safetyButton"[^>]*>Ask<\/button>/);
  assert.match(composer, /id="safetyDropdown"[\s\S]*class="control-icon"/);
  assert.match(composer, /id="safetyButton"[\s\S]*class="control-caret"/);
  assert.doesNotMatch(styles, /\.safety-button\{[^}]*font-weight:600/);
  assert.doesNotMatch(styles, /safety-button\[data-mode="autonomous"\]/);
  assert.match(styles, /\.safety-button\{[^}]*font-weight:inherit/);
  assert.match(composer, /class="send idle"/);
  assert.match(composer, /class="send-svg"/);
  assert.match(composer, /class="stop-svg"/);
  assertSource(runtime, /function approvalShort\(id\)\{return id==='edits'\?'Auto':id==='autonomous'\?'Open':'Ask'\}/);
  assertSource(runtime, /setSendMode\(isRunning\(\)\?'loading':\(input\.value\.trim\(\)\|\|attachments\.length\?'ready':'idle'\)\)/);
  assertSource(runtime, /if\(!edit&&!wasRunning\)runningSet\.add\(activeConversationId\);input\.value=''/);
  assertSource(runtime, /sSvg\.style\.removeProperty\('display'\)/);
  assert.doesNotMatch(runtime, /xSvg\.style\.display=r\?'block':'none'/);
  assert.match(styles, /\.send\.idle\{/);
  assert.match(styles, /\.send\.ready\{/);
  assert.match(styles, /\.send\.stop,\.send\.loading\{/);
  assert.match(styles, /\.send\.stop \.stop-svg,\.send\.loading \.stop-svg\{display:block!important\}/);
});

test('selector popups clamp inside the viewport instead of overflowing the sidebar', () => {
  assertSource(runtime, /function placeAnchoredMenu\(menu,anchor\)/);
  assertSource(runtime, /function viewportBox\(\)/);
  assertSource(runtime, /function headerSafeTop\(\)/);
  assertSource(runtime, /const safeTop=Math\.max\(vp\.top\+pad,headerSafeTop\(\)\+gap\)/);
  assertSource(runtime, /const preferred=Math\.min\(popupCap,Math\.round\(vh\*0\.5\),height\)/);
  assertSource(runtime, /const top=Math\.max\(safeTop,ar\.top-gap-maxHeight\)/);
  assertSource(runtime, /if\(conversationMenu\?\.classList\.contains\('open'\)\)placeAnchoredMenu\(conversationMenu/);
  assertSource(runtime, /if\(mentionMenu\?\.classList\.contains\('open'\)\)placeAnchoredMenu\(mentionMenu/);
  assertSource(runtime, /if\(slashMenu\?\.classList\.contains\('open'\)\)placeAnchoredMenu\(slashMenu/);
  assert.match(styles, /\.dropdown-menu\{[^}]*position:fixed/);
  assert.match(styles, /\.dropdown-menu\{[^}]*max-height:min\(320px,50vh,calc\(100vh - 16px\)\)/);
  assert.match(styles, /\.mention-menu,\.slash-menu\{[^}]*position:fixed/);
  assert.match(styles, /\.conversation-menu\{[^}]*position:fixed/);
  assert.match(styles, /\.conversation-menu\{[^}]*max-height:min\(320px,50vh,calc\(100vh - 16px\)\)/);
  assert.match(styles, /\.context-panel\{[^}]*position:fixed/);
  assert.match(styles, /\.context-panel\{[^}]*max-height:min\(320px,50vh,calc\(100vh - 16px\)\)/);
});

test('assistant replies show the used model under the message instead of above the composer', () => {
  assertSource(runtime, /modelEl\.className='message-model'/);
  assertSource(runtime, /const modelId=item\.model\|\|selectedModel\|\|''/);
  assertSource(runtime, /actions\.appendChild\(modelEl\)/);
  assert.doesNotMatch(runtime, /updateActiveModelLine/);
  assert.doesNotMatch(webviewHtml, /active-model-line|session-info-model/);
  assertSource(runtime, /session-info-title/);
  assert.match(styles, /\.message-model\{/);
  assert.match(styles, /\.assistant-footer\{align-items:center\}/);
  assert.doesNotMatch(styles, /\.assistant-footer\{flex-direction:column/);
});

test('message history scrolls independently from a bounded composer', () => {
  assert.match(styles, /html,body\{[^}]*overflow:hidden/);
  assert.match(styles, /#messages\{[^}]*flex:1 1 0[^}]*overflow-y:auto/);
  assert.match(styles, /\.composer\{[^}]*flex:0 0 auto/);
  assert.match(styles, /max-height:min\(180px,28vh\)/);
  assertSource(runtime, /ResizeObserver/);
});

test('run preflight failures still reach structured error handling and cleanup', () => {
  assert.match(agent, /try \{[\s\S]*?if \(!providerConfig\) throw new Error/);
  // Chat preflight must not scan the workspace or enumerate skills before the request.
  assert.match(agent, /run\.fastlane\.ready/);
  assert.doesNotMatch(agent, /run\.skills\.start/);
  // Chat preflight must not capture a git tree. The only capture site is the
  // undo handler, which records the post-turn tree so redo can restore files.
  assert.equal((agent.match(/captureGitTree\(root\.fsPath\)/g) || []).length, 1);
  assert.match(agent, /popped\.snapshot\.redoGitTree = await captureGitTree\(root\.fsPath\)/);
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
  assertSource(runtime, /Continue iteration/);
});

test('previous thinking is persisted for later model requests and the budget is configurable', () => {
  const reasoningSetting = pkg.contributes.configuration.properties['sleepycode.maxPersistedReasoning'];
  assert.equal(reasoningSetting.default, 32000);
  assert.equal(reasoningSetting.minimum, 3000);
  assert.equal(reasoningSetting.maximum, 200000);
  assert.match(types, /export const MAX_PERSISTED_REASONING = 32_000/);
  assert.match(types, /maxPersistedReasoning: number/);
  assert.match(agent, /attachReasoningToLatestAssistant\(runMessages/);
  assert.match(agent, /attachReasoningToLatestAssistant\(subagentMessages, stepThinking\)/);
  assert.match(agent, /backfillAssistantReasoning\(selected, reasoningTextsFromItems\(conversation\.items\)\)/);
  assert.match(agent, /Your previous thinking/);
  assert.match(agent, /rememberReasoningText\(reasoningBuffer/);
  assertSource(runtime, /maxPersistedReasoning:Number\(maxPersistedReasoning/);
  assert.match(webviewHtml, /Persisted thinking characters/);
  assert.match(webviewHtml, /data-settings-pane="advanced"/);
});

test('sending during an active run queues without rendering a fake first send', () => {
  assertSource(runtime, /if\(wasRunning\)\{const list=queuedByConversation\.get\(activeConversationId\)\|\|\[\];list\.push\(\{id:'tmp-'\+Date\.now\(\),text:optimisticText\}\);queuedByConversation\.set\(activeConversationId,list\);updateQueuedVisibility\(\);vscode\.postMessage\(\{type:'send'/);
  const queuedBranch = runtime.match(/if\(wasRunning\)\{([\s\S]*?)updateSendMode\(\);return\}/)?.[1] ?? '';
  assert.doesNotMatch(queuedBranch, /beginTurn\(/);
  assert.doesNotMatch(queuedBranch, /runningSet\.add/);
});

test('queue keeps every follow-up sent during a run (multi-message queue)', () => {
  // Server keeps one entry per queued prompt instead of replacing the previous one.
  // One entry per prompt, appended: the queue never replaces what is waiting.
  // Steering rows carry the composer's request id so the echo can name them.
  assert.match(agent, /this\.queue\.push\(\{ id: requestId && requestId\.trim\(\) \? requestId : `q\$\{\+\+this\.queueSeq\}`, text, conversationId, context, promptContext,/);
  assert.doesNotMatch(agent, /this\.queue = this\.queue\.filter\(entry => entry\.conversationId !== conversationId\);\n\s*this\.queue\.push/);
  assert.match(agent, /prompts: entries\.map\(entry => entry\.text\), ids: entries\.map\(entry => entry\.id\)/);
  assertSource(runtime, /case'queuedPrompt':\{const ids=m\.ids\|\|\[\],texts=m\.prompts\|\|\[\]/);
});

test('installed marketplace skills can be read and explicitly used', () => {
  assert.match(skills, /export async function readInstalledSkill/);
  assert.match(tools, /tools\.skillsmp_read_installed = tool/);
  assert.match(agent, /call skillsmp_read_installed/);
  assertSource(runtime, /data-use-skill/);
  assertSource(runtime, /Use the .* skill to/);
});

test('reading an installed skill shows the skill name on the tool card', () => {
  assert.match(util, /record\.path \?\? record\.query \?\? record\.glob \?\? record\.command \?\? record\.source \?\? record\.skill \?\? record\.skills \?\? record\.name/);
  assert.match(util, /skillsmp_read_installed: 'Reading installed skill'/);
});

test('composer slash commands expose extension actions and dynamic installed-skill invocation', () => {
  assertSource(runtime, /const SLASH_COMMANDS=\[/);
  for (const command of ['/skill', '/new', '/settings', '/usage', '/skills', '/marketplace', '/memory', '/reindex', '/context', '/model', '/agent', '/permissions']) {
    assert.ok(runtime.includes(`command:'${command}'`), `${command} is present`);
  }
  assertSource(runtime, /installedSkills\.filter\(skill=>/);
  assertSource(runtime, /The user explicitly invoked the installed skill/);
  assertSource(runtime, /vscode\.postMessage\(\{type:'requestMarketplaceInstalled'\}\)/);
});

test('typing /skill immediately opens the installed skill list', () => {
  assertSource(runtime, /function skillPickerQuery\(value\)\{const match=String\(value\|\|''\)\.match\(\/\^\\\/skill\(\?:\\s\+\(\?:"\(\[\^"\]\*\)\|\(\[\^\\s\]\*\)\)\)\?\$\/i\)/);
  assertSource(runtime, /if\(skillPickerQuery\(value\)!==null\)\{if\(!skillPickerOpen\)vscode\.postMessage\(\{type:'requestMarketplaceInstalled'\}\);skillPickerOpen=true;refreshSkillPicker\(\);return\}/);
  assertSource(runtime, /else if\(item\.command==='\/skill'\)\{input\.value='\/skill ';input\.focus\(\);input\.setSelectionRange\(input\.value\.length,input\.value\.length\);resize\(\);updateSlashMenu\(\);return\}/);
  assertSource(runtime, /case'marketplaceInstalled':installedSkills=m\.skills\|\|\[\];installedSkillsLoaded=true;renderInstalledSkills\(\);if\(marketplaceView\.classList\.contains\('visible'\)\)renderMarketplaceResults\(\);if\(skillPickerOpen\)refreshSkillPicker\(\);break;/);
  assertSource(runtime, /if\(!installedSkillsLoaded\)return\[\{command:'\/skill',label:'Loading installed skills…'/);
  assert.doesNotMatch(runtime, /skillMatch=value\.match\(\/\^\\\/skill\\s\+/);
});

test('slash palette groups Ask, Session, and Workspace and keeps keyboard selection', () => {
  assertSource(runtime, /group:'Ask'/);
  assertSource(runtime, /group:'Session'/);
  assertSource(runtime, /group:'Workspace'/);
  assertSource(runtime, /function groupedSlashHtml\(results\)/);
  assertSource(runtime, /function renderSlashCommandsPalette\(\)\{if\(!slashMenu\)return;renderSlashMenu\(SLASH_COMMANDS\)\}/);
  assertSource(runtime, /class="slash-group"/);
  assert.match(styles, /\.slash-group\{/);
  assert.match(styles, /\.slash-option\.selected\{box-shadow:inset 2px 0 0 var\(--vscode-focusBorder\)\}/);
  assert.match(styles, /\.turn\{[^}]*margin:0 0 16px/);
  assert.match(styles, /\.assistant p\{margin:0 0 8px\}/);
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
  assertSource(runtime, /statContext\.textContent=\(s\.measured\?'':'~'\)\+fmt\(s\.contextTokens\)/);
  assert.match(compactionCore, /export function contextOccupancy/);
  assert.match(compactionCore, /export function estimateContextTokens/);
});

test('auto-compaction runs after the run leaves this.runs, with a cooldown', () => {
  // Anchored on the drain's own call rather than on whichever publisher is in
  // fashion: renaming `postQueued` to `postWorkflow` broke this while the
  // invariant it protects was unchanged.
  const finallyBlock = agent.match(/\} finally \{[\s\S]*?await mcpConnection\?\.close\(\);[\s\S]*?void this\.run\(own\.text/)?.[0] ?? '';
  assert.ok(finallyBlock, 'run() finally block found');
  assert.match(finallyBlock, /this\.runs\.delete\(conversationId\);[\s\S]*?maybeAutoCompact\(conversation/);
  assert.match(agent, /lastAutoCompactAt\.get\(conversation\.id\) \?\? 0\) < 120_000/);
  assert.doesNotMatch(agent, /if \(providerConfig\.id === 'sleepyai'\) \{\s*const session/);
});

test('compaction progress replaces the modal protocol and supports cancellation', () => {
  assert.doesNotMatch(agent + runtime + types, /compactStatus/);
  assert.match(types, /type: 'compactProgress'/);
  assert.match(types, /type: 'cancelCompact'/);
  assertSource(runtime, /case'compactProgress':handleCompactProgress\(m\)/);
  assertSource(runtime, /vscode\.postMessage\(\{type:'cancelCompact'/);
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
  assertSource(runtime, /case'\/compact':handleCompactProgress\(\{conversationId:activeConversationId,phase:'start'\}\)/);
  assertSource(runtime, /if\(trimmed\.toLowerCase\(\)===first&&runDirectSlash\(first\)\)/);
});

test('context window updates live from the latest step prompt_tokens, not only after the run', () => {
  // The context pill must reflect the provider's prompt_tokens for the CURRENT
  // run as it progresses. The liveUsage message carries the latest step's
  // prompt_tokens (not the cumulative liveInput, which is lifetime spend).
  assert.match(agent, /type: 'liveUsage'.*contextTokens: input/s);
  // The webview stores the live context tokens and prefers them over the last
  // committed assistant item (which reflects the previous run).
  assertSource(runtime, /contextTokens:m\.contextTokens\|\|0/);
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
  assert.match(agent, /beforeItems: before\.slice\(\),[\s\S]{0,80}afterItems: summarized\.items\.slice\(\)/);
  assert.match(agent, /beforeMessages: \(conversation\.messages \?\? \[\]\)\.slice\(\)/);
  assert.match(agent, /restoreCompaction\(conversation, snapshot, 'before'\)/);
  assert.match(agent, /kind === 'divider'\) \{\s*if \(!this\.undoCompaction\(conversation\)\) return;/s);
  assert.match(agent, /if \(this\.redoCompaction\(conversation\)\)/);
  assert.match(agent, /compactionUndoable, compactionRedoable/);
});

test('webview renders the compaction divider and adapts undo/redo copy', () => {
  assertSource(runtime, /item\.kind==='divider'\)\{messages\.appendChild\(dividerRow\(\)\)/);
  assertSource(runtime, /compactionUndoable\?\{title:'Undo compaction\?'/);
  assertSource(runtime, /compactionRedoable\?\{title:'Redo compaction\?'/);
  assertSource(runtime, /compactionUndoable=Boolean\(m\.compactionUndoable\)/);
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
  assert.match(agent, /errorItem\.partialText = fields\.partialText/);
  // Retry handler carries partialText in the resume payload
  assert.match(agent, /partialText: resumeFrom\.resume\.partialText/);
  // Resume context includes partial text for the model
  assert.match(agent, /resume\?\.partialText \?/);
  assert.match(agent, /Continue it from exactly where it stops/);
  // Final answer prepends the preserved partial
  assert.match(agent, /resume\?\.partialText \? resume\.partialText.+answer : answer/);
  // Continue-iteration also carries the half-written text
  assert.match(agent, /partialText: last\.text/);
  assert.match(agent, /pausePlaceholder/);
  // Webview shows the partial text on error instead of removing it
  assertSource(runtime, /current\.classList\.remove\('streaming'\)/);
  assertSource(runtime, /interruptedMarker/);
  assertSource(runtime, /interrupted-note/);
  // Webview renders partial text in conversation re-render
  assertSource(runtime, /next\.partialText/);
  // Webview injects partial text on resume
  assertSource(runtime, /m\.partialText\|\|''/);
  assertSource(runtime, /current\.dataset\.raw=m\.partialText/);
  // CSS for the interrupted marker
  assert.match(styles, /interrupted-note/);
  // Resume message includes partialText
  assert.match(agent, /type: 'resume'.*partialText: resume\.partialText/);
});

test('structured model history persists across turns instead of flattening to text', () => {
  // Conversation stores the real model-visible message array alongside display items.
  assert.match(types, /messages\?: ModelMessage\[\]/);
  assert.match(types, /export const MAX_STORED_MESSAGES/);
  // The run seeds the provider with real messages when structured history exists,
  // including the live tool-call slice of the current iteration.
  assert.match(agent, /const history = this\.structuredHistory\(conversation, modelInfo\.contextWindow, modelInfo\.maxOutputLimit\)/);
  // The live slice is handed over as a request-only view: budgeted down when it does
  // not fit, while `runMessages` keeps everything for the saved transcript.
  assert.match(agent, /agentMessages = iterationRequestMessages\(history, liveForRequest as ModelMessage\[\], streamPrompt\)/);
  assert.match(agent, /const liveForRequest = trimmedLive\.messages;/);
  assert.match(agent, /messages: agentMessages/);
  // Response messages (assistant tool calls + tool results) are captured and kept.
  assert.match(agent, /runMessages\.push\(\.\.\.\(responseMessages as ModelMessage\[\]\)\.filter\(message => message\.role !== 'system'\)\)/);
  assert.match(agent, /this\.appendConversationMessages\(conversation, historyUserText, runMessages, Boolean\(resume\)\)/);
  // History must never start with a tool result: strict providers reject it.
  assert.match(iterationCore, /export function safeHistoryStart/);
  assert.match(iterationCore, /export function selectStructuredHistory/);
  // Legacy conversations without structured history still use the text fallback.
  assert.match(agent, /const structured = this\.structuredHistory\(conversation, modelInfo\.contextWindow, modelInfo\.maxOutputLimit\)/);
});

test('compaction and rollbacks keep structured history in sync with the transcript', () => {
  const sessionCore = read('src/session-core.ts');
  // Compaction replaces the structured history with the summary, never replays it.
  assert.match(agent, /afterMessages: ModelMessage\[\] = \[/);
  assert.match(agent, /summaryText: string/);
  assert.match(agent, /summaryText: summary\.text/);
  // Undo/redo and checkpoint restores slice structured history with the transcript.
  assert.match(agent, /sliceMessagesToItems\(conversation\.messages, conversation\.items\)/);
  // Clearing model history anywhere except the CLI display projection would drop
  // real turns. In CLI mode the authoritative record is the CLI's own rows.
  const projectionStart = agent.indexOf('private applyCliProjection');
  const projectionEnd = agent.indexOf('private findConversation');
  assert.ok(projectionStart > 0 && projectionEnd > projectionStart, 'expected the CLI projection method');
  const outsideCliProjection = agent.slice(0, projectionStart) + agent.slice(projectionEnd);
  assert.doesNotMatch(outsideCliProjection, /conversation\.messages = undefined;/);
  assert.match(sessionCore, /export function branchConversationState/);
  assert.match(agent, /this\.createConversation\(slicedItems, sliced\.messages\)/);
  assert.match(agent, /workspaceGitRestoreFromSnapshot\(snapshot, 'redo'\)/);
  assert.match(agent, /checkpointConversation\(conversation, true\)/);
  assert.match(agent, /takeTurnRedo\(conversation\)/);
  // A stopped turn is retryable, never a 'Stopped.' dead end, and the streamed
  // partial stays in partialText so the webview renders it exactly once.
  assert.doesNotMatch(agent, /createTranscriptItem\('assistant', 'Stopped\.'/);
  assert.match(agent, /createTranscriptItem\('assistant', INTERRUPTED_TURN_TEXT, 'error'/);
  assertSource(runtime, /if\(next\.partialText\)\{[\s\S]{0,300}markdown\(next\.partialText\)/);
  assert.match(sessionCore, /export const INTERRUPTED_TURN_TEXT/);
  // A fresh send (no resume) is what invalidates undone/redone turns.
  assert.match(agent, /if \(resume\) \{[\s\S]{0,400}\} else if \(!userAlreadyPersisted\) \{[\s\S]{0,200}clearForwardStacks\(conversation\)/);
  // Checkpointing writes only the dirty project, not every project on flush.
  assert.match(agent, /private persistProject\(/);
  assert.match(agent, /checkpointConversation\(conversation: Conversation, force = false\)[\s\S]{0,600}this\.persistProject\(project\)/);
  assert.doesNotMatch(agent, /checkpointConversation\(conversation: Conversation, force = false\)[\s\S]{0,600}this\.persistProjects\(\)/);
});

test('an interrupted run keeps its partial work instead of losing it', () => {
  // Partial structured messages are checkpointed after every completed iteration.
  assert.match(agent, /conversation\.pending = \{\s*userText: historyUserText,\s*messages: runMessages\.slice\(\),\s*startedAt:/s);
  assert.match(types, /pending\?: \{[\s\S]*userText: string;[\s\S]*messages: ModelMessage\[\];[\s\S]*startedAt: number;[\s\S]*partialText\?: string;/);
  assert.match(agent, /updatePending\(\)/);
  assert.match(agent, /workspaceRestoreFromSnapshot\(snapshot, 'redo'\)/);
  // The abort branch folds the partial turn into history and clears pending.
  assert.match(agent, /if \(run\.controller\.signal\.aborted\) \{[\s\S]{0,400}appendConversationMessages\(conversation, historyUserText, runMessages, Boolean\(resume\)\)/);
  // The error branch does the same so a retry continues rather than re-reading.
  assert.match(agent, /conversation\.pending = undefined;/);
  // A reload/crash recovers the pending turn into structured history on load.
  assert.match(agent, /const pending = conversation\.pending;/);
  assert.match(agent, /recoverPendingHistory\(conversation\.messages, pending, MAX_STORED_MESSAGES\)/);
  // Exactly one declaration, in the outer run scope so catch/finally can reach it.
  assert.equal((agent.match(/let runMessages: ModelMessage\[\] = \[\];/g) || []).length, 1);
  // A mid-run checkpoint writes only the project that owns the dirty conversation.
  assert.match(agent, /private persistProject\(/);
  assert.match(agent, /checkpointConversation\(conversation: Conversation, force = false\)[\s\S]{0,600}this\.persistProject\(/);
  assert.doesNotMatch(agent, /checkpointConversation\(conversation: Conversation, force = false\)[\s\S]{0,600}this\.persistProjects\(\)/);
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

test('file changes persist plus/minus and render expandable line previews', () => {
  const lineDiff = read('src/line-diff.ts');
  assert.match(lineDiff, /export function fileChangeStats/);
  assert.match(lineDiff, /export function compactLinePreview/);
  assert.match(types, /additions\?: number/);
  assert.match(types, /deletions\?: number/);
  assert.match(types, /preview\?: FileChangeLine\[\]/);
  assert.match(tools, /type: 'changed', path: filePath, action: exists \? 'Modified' : 'Created', before, after: content/);
  assert.match(tools, /type: 'changed', path: filePath, action: 'Modified', before: source, after: proposed/);
  assert.match(tools, /type: 'changed', path: filePath, action: 'Deleted', before, after: ''/);
  assert.match(agent, /fileChangeStats\(beforeText, afterText\)/);
  assert.match(agent, /additions: live\.additions, deletions: live\.deletions, preview: live\.preview/);
  assert.match(agent, /additions: net\.additions/);
  assertSource(runtime, /function changeStatHtml\(plus,minus,always\)/);
  assertSource(runtime, /function liveChangedRow\(change,openPreview\)/);
  assertSource(runtime, /className='changed has-preview'/);
  assertSource(runtime, /d\.open=openPreview!==false/);
  assertSource(runtime, /class="change-plus">\+'/);
  assertSource(runtime, /class="change-minus">−'/);
  assertSource(runtime, /details class="change-preview"/);
  assertSource(runtime, /hasStats\?changeStatHtml\(plus,minus,true\):''/);
  assertSource(runtime, /open\.onclick=e=>\{e\.preventDefault\(\);e\.stopPropagation\(\)/);
  assertSource(runtime, /lastPreview/);
  assert.match(styles, /\.change-plus\{/);
  assert.match(styles, /\.change-minus\{/);
  assert.match(styles, /\.change-hunk\{/);
  assert.match(styles, /\.change-line\.ctx\{/);
  assert.match(styles, /\.changes-head \.change-stat\{/);
  assert.match(styles, /\.change-stat\.totals\{/);
});

test('the extension is a client: it never opens the CLI database', () => {
  // The CLI process owns sleepy.db. Opening it from the extension host would put
  // two writers on one history.
  for (const [name, source] of [['cli-client', cliClient], ['cli-server', cliServer], ['cli-engine', cliEngine], ['cli-projection', cliProjection], ['agent', agent]]) {
    assert.doesNotMatch(source, /require\(['"]node:sqlite['"]\)|from ['"]node:sqlite['"]|drizzle|libsql/, `${name} must not open SQLite`);
  }
  assert.doesNotMatch(cliClient, /sleepy\.db/);
});

test('a busy CLI turn keeps the live renderer instead of rebuilding the transcript', () => {
  const start = agent.indexOf('private applyCliProjection');
  // Wide enough to cover the method's comments and the settled-path work added
  // since, so a later edit cannot hide the invariant behind a fixed window.
  const body = agent.slice(start, agent.indexOf('private applyCliLiveEvent'));
  assert.match(body, /if \(busy\) return;/);
  assert.match(agent, /private applyCliLiveEvent/);
  assert.match(cliEngine, /case 'message\.part\.delta'/);
  assert.match(cliEngine, /applyCliPartDelta/);
  // Tokens that arrive before the GET has the new part must still paint.
  assert.match(cliEngine, /Never refresh on a token/);
  assert.match(cliProjection, /Invent the message\/part here/);
  // A mismatch notice must not finish() the live turn, or later tokens vanish.
  assert.match(agent, /keepTurn: true/);
  assertSource(runtime, /if\(!m\.keepTurn\)finish\(\)/);
  // Idle projection replaces the stream; clear its live buffer first or the
  // settled assistant text is appended a second time by renderLive().
  assert.match(agent, /type: 'cliSettled'/);
  assertSource(runtime, /case'cliSettled':\{liveByConversation\.delete/);
  // Full text snapshots and token deltas can describe the same bytes. Only the
  // delta event may feed the text renderer.
  assert.doesNotMatch(cliEngine, /part\.type === 'text'[\s\S]{0,200}kind: 'delta'/);
});

test('new conversation always mints a new extension conversation identity', () => {
  const start = agent.indexOf('private newConversation()');
  const body = agent.slice(start, agent.indexOf('/**', start + 30));
  assert.match(body, /const conversation = this\.createConversation\(\)/);
  assert.doesNotMatch(body, /find\(item =>/);
  assert.match(body, /project\.conversations\.unshift\(conversation\)/);
});

test('the Sleepy CLI is an experimental opt-in, not the default engine', () => {
  const manifest = read('package.json');
  assert.match(manifest, /"sleepycode.useCli"/);
  assert.match(manifest, /"sleepycode.useCli"[\s\S]{0,200}"default": false/);
  assert.match(cliEngine, /export async function resolveEngine\(directory: string, useCli/);
  assert.match(agent, /get<boolean>\('useCli', false\)/);
  assert.match(webviewHtml, /id="useCli"/);
  assertSource(runtime, /useCli:Boolean\(useCli&&useCli.checked\)/);
});

test('CLI mode routes the send path to the CLI instead of the local loop', () => {
  assert.match(cliEngine, /export async function resolveEngine/);
  // A conversation with no history of its own goes to the CLI, so the local
  // ToolLoopAgent must not also run the same send.
  assert.match(agent, /if \(sending && this\.cliOwns\(sending, engine\)\) \{[\s\S]{0,200}sendViaCli/);
  // The local ToolLoopAgent must not also run the same send.
  assert.match(agent, /private async sendViaCli\(/);
});

test('a failed CLI send hands the user their text back', () => {
  // The composer clears itself the moment a send is posted, so if the send
  // never reaches the CLI the typed prompt would vanish with nothing to retry.
  assert.match(agent, /type: 'restoreDraft'/, 'the failure paths must restore the draft');
  // Both the unreachable path and a rejected send must restore it. Bound the
  // slice to the method body so later methods cannot satisfy or break it.
  const start = agent.indexOf('private async sendViaCli');
  const sendViaCli = agent.slice(start, agent.indexOf('private async continueViaCli'));
  const unreachable = sendViaCli.slice(0, sendViaCli.indexOf("if (!chat) {") + 200);
  assert.match(unreachable, /restoreDraft/, 'an unreachable CLI must restore the draft');
  // The send itself is wrapped so a rejection is handled next to the restore.
  assert.match(sendViaCli, /try \{[\s\S]*await chat\.send\(text, model\);[\s\S]*catch[\s\S]*restoreDraft/, 'a rejected send must restore the draft');
  // The webview only restores into the matching conversation, and only when the
  // user has not already typed something newer.
  assertSource(runtime, /case'restoreDraft':/);
  assertSource(runtime, /m\.conversationId===activeConversationId/);
  assertSource(runtime, /!input\.value\.trim\(\)/);
  // Crucially, a failed send must NOT write local history: that would pin a
  // CLI-owned conversation to the local agent forever.
  assert.doesNotMatch(sendViaCli, /conversation\.items\s*=|conversation\.messages\s*=/);
});

test('undo and redo follow the engine that owns the conversation', () => {
  // A CLI conversation's items are only a display mirror. Popping one locally
  // would rewrite a transcript the CLI still holds and leave reverted files
  // unreverted, so both handlers must hand the turn back to the CLI first.
  const undo = agent.slice(agent.indexOf("message.type === 'undoLastTurn'"), agent.indexOf("message.type === 'redoLastTurn'"));
  assert.match(undo, /await this\.undoViaCli\(conversation/, 'undo must route through the CLI when it owns the conversation');
  assert.match(undo, /return;\n\s*\}\n\s*\/\/ A compaction boundary/, 'a CLI undo must return before touching local items');
  const redo = agent.slice(agent.indexOf("message.type === 'redoLastTurn'"), agent.indexOf("message.type === 'requestPanel'"));
  assert.match(redo, /await this\.redoViaCli\(conversation/, 'redo must route through the CLI when it owns the conversation');
  // Both wrappers must check ownership and fall through for local chats, or an
  // offline conversation could never be undone at all.
  assert.match(agent, /private async undoViaCli\([^)]*\): Promise<boolean> \{\s*if \(!this\.cliOwns\(conversation, this\.engineStatus\)\) return false;/);
  assert.match(agent, /private async redoViaCli\([^)]*\): Promise<boolean> \{\s*if \(!this\.cliOwns\(conversation, this\.engineStatus\)\) return false;/);
  // The CLI client already had revert/unrevert; they must actually be used now.
  assert.match(cliClient, /\/revert`/);
  assert.match(cliClient, /\/unrevert`/);
  // The CLI session resolves its own revert target: message ids are the engine's
  // private keys and must not leak into the shared transcript item type.
  assert.match(cliEngine, /async undo\(\): Promise<boolean>/);
  assert.match(cliEngine, /async redo\(\): Promise<void>/);
  assert.doesNotMatch(types, /messageID/);
});

test('local-only history commands refuse to run on a CLI conversation', () => {
  // Every command that rewinds, forks, or summarises `items` is local-only. On a
  // CLI conversation `items` is a display mirror and `messages` is deliberately
  // undefined, so doing any of them edits a transcript the CLI still holds.
  const guard = (handler, label) => {
    const start = agent.indexOf(`message.type === '${handler}'`);
    assert.ok(start > 0, `${handler} handler must exist`);
    const body = agent.slice(start, start + 1600);
    assert.match(body, /refuseIfCliOwned\(conversation, '/, `${label} must be refused on a CLI conversation`);
  };
  guard('editUserMessage', 'editing a past message');
  guard('branchConversation', 'branching');
  guard('restoreCheckpoint', 'restoring a checkpoint');
  // Compaction is the worst of these: the local model would invent a summary
  // that is stored nowhere the CLI can see, so the two disagree about one session.
  assert.match(agent, /refuseIfCliOwned\(conversation, 'Compacting'\)/);
  // The refusal must key off the same routing rule as every other path.
  assert.match(agent, /private refuseIfCliOwned\(conversation: Conversation, action: string\): boolean \{\s*if \(!this\.cliOwns\(conversation, this\.engineStatus\)\) return false;/);
});

test('deleting a conversation releases its CLI session binding', () => {
  // A stale binding would let a later conversation that reuses this id adopt
  // the deleted one's session, and the sidebar would show someone else's chat.
  const start = agent.indexOf("message.type === 'deleteConversation'");
  const body = agent.slice(start, start + 2000);
  assert.match(body, /this\.cliSessions\?\.forget\(message\.id\)/);
  // CliSessionManager.forget owns both persisted binding removal and live/
  // in-flight chat disposal, so deletion cannot leave a posting stream behind.
  const manager = read('src/cli-session-manager.ts');
  assert.match(manager, /this\.registry\.forget\(conversationId\)/);
  assert.match(manager, /this\.chats\.get\(conversationId\)\?\.dispose\(\)/);
  assert.match(manager, /this\.opening\.get\(conversationId\)\?\.then\(chat => chat\?\.dispose\(\)\)/);
  assert.doesNotMatch(body, /client\.deleteSession|session\.delete/, 'the CLI owns its rows; deleting a chat must not delete the session');
});

test('opening a CLI conversation attaches its stream instead of showing a stale mirror', () => {
  // A reloaded window has an empty chat map. Without attaching on open, nothing
  // would ever stream this conversation again and the sidebar would show a
  // persisted mirror that drifts from sleepy.db the moment the CLI does anything.
  const start = agent.indexOf("message.type === 'openConversation'");
  // Wide enough to cover the handler's comments and the model pre-flight that
  // precede the attach, so a later comment edit cannot hide the `.catch` again.
  const body = agent.slice(start, start + 1600);
  assert.match(body, /this\.cliOwns\(opened, this\.engineStatus\)/);
  assert.match(body, /this\.cliChatFor\(message\.id/);
  // A failure to attach is logged, not thrown into the message handler.
  assert.match(body, /catch\(error =>/);
  // Local conversations must not be attached to the CLI on open.
  assert.doesNotMatch(body, /cliChatFor\(message\.id[^)]*\)[^}]*\}\s*return;\s*\}\s*\n\s*if \(!project/);
});

test('continuing a paused iteration is routed to the engine that owns the conversation', () => {
  // A CLI-owned paused card is a projection of an unfinished CLI row, so
  // continuing must resume via the CLI; the local re-run stays the fallback.
  const start = agent.indexOf("message.type === 'continueIteration'");
  // Window must cover the whole handler: `this.run(` now sits ~1676 chars in because
  // the continue path grew reason-aware resume text. Too small a window makes
  // indexOf return -1 and fails for the wrong reason.
  const body = agent.slice(start, start + 2600);
  assert.match(body, /cliOwns\(conversation, this\.engineStatus\)/, 'the CLI-owned path comes first');
  assert.ok(
    body.indexOf('cliOwns') < body.indexOf('this.run('),
    'the CLI route must come before the local re-run',
  );
  assert.match(body, /continueViaCli\(message\.conversationId\)/, 'the CLI resumes its own turn');
  assert.doesNotMatch(body, /refuseIfCliOwned/, 'continuing is no longer refused on CLI conversations');
});

test('a CLI error never renders as a bare category name', () => {
  // One unwrap, used by both the toast and the transcript card. The two copies
  // that drifted are what hid "Model not found: sleepy/auto-best-coding." behind
  // a generic message and a bare "UnknownError".
  assert.match(cliProjection, /export function cliErrorText\(error: unknown\): string \| undefined/);
  assert.match(cliProjection, /data\.message/, 'the unwrap must read data.message, the real field');
  assert.match(cliEngine, /import \{[^}]*cliErrorText,/);
  assert.match(cliEngine, /return cliErrorText\(error\) \?\?/);
  // The projection must not keep its own copy.
  assert.doesNotMatch(cliProjection, /return error\.message \?\?/);
});

test('a recoverable CLI turn is projected as paused exactly once', () => {
  // The paused card is how Continue is offered; the projection must flag the
  // recoverable rows and then trim to the newest idle one, or the sidebar would
  // either hide the button or offer to resume an old turn and fork history.
  assert.match(cliProjection, /export function projectPausedAssistant\(info: CliMessageInfo\)/);
  assert.match(cliProjection, /export function applyPausedProjection\(items: TranscriptItem\[\], busy: boolean\)/);
  assert.match(cliEngine, /applyPausedProjection\(items, busy\)/, 'every publish passes through the trim');
  // The busy pass must actually clear flags, not just skip them, or a streaming
  // turn would keep a stale card until its next refresh.
  const start = cliProjection.indexOf('export function applyPausedProjection');
  const body = cliProjection.slice(start, start + 1400);
  assert.match(body, /if \(busy \|\| index !== lastAssistant\)/, 'busy and stale rows are cleared together');
});

test('a model the CLI does not have is never sent to it', () => {
  // The CLI keeps its own provider registry; the sidebar's ids are SleepyCode's.
  // Passing one the CLI has never heard of fails the turn with
  // ProviderModelNotFoundError, so the send path checks first.
  assert.match(agent, /private async cliProviderCatalog\(\): Promise<CliProviderCatalog \| undefined>/);
  const start = agent.indexOf('private async cliProviderCatalog');
  const body = agent.slice(start, start + 1200);
  assert.match(body, /this\.cliClient\?\.providerCatalog\(\)/, 'the check must ask the CLI what it has');
  assert.match(body, /return undefined;/, 'a failed lookup must not block the send');

  const send = agent.indexOf('private async sendViaCli');
  const sendBody = agent.slice(send, send + 3200);
  assert.match(sendBody, /pickCliModel\(/, 'the send must choose from the catalog');
  // Unvalidated pass-through is exactly what this replaces: the sidebar's pick
  // may become `preferred`, but the model actually sent must be the chosen one.
  assert.doesNotMatch(sendBody, /chat\.send\(text, preferred\)/);
  assert.match(sendBody, /chat\.send\(text, model\)/);
  // The chooser must be the single source of the decision, and it must run
  // before the send rather than after a failure.
  assert.ok(sendBody.indexOf('pickCliModel(') < sendBody.indexOf('chat.send(text, model)'));
});

test('the engine is chosen once and never swapped mid-conversation', () => {
  // Re-resolving per send would let a chat change engines while it is open.
  assert.match(agent, /private engineReady: Promise<void> \| undefined/);
  // The guard may also compare the setting it resolved under, so a useCli flip
  // re-resolves instead of silently returning the previous engine.
  assert.match(agent, /if \(this\.engineReady(?: &&[^{]*)?\) \{\s*await this\.engineReady;\s*return this\.engineStatus;/);
  assert.match(agent, /private engineUseCli: boolean \| undefined/);
  assert.match(agent, /get<boolean>\('useCli'/);
});

test('CLI sends create a real user turn, never a synthetic Continue', () => {
  assert.match(cliClient, /prompt_async/);
  // The body carries a real text part and, separately, the model. The model
  // used to be omitted, which left the CLI resolving its own configured
  // default -- a placeholder that exists in no provider, so every send failed.
  assert.match(cliClient, /\{ parts: \[\{ type: 'text', text \}\]/);
  assert.match(cliClient, /model \? \{ model, providerID: model\.providerID \}/);
  // Continue resumes the interrupted assistant by id, with no new user message.
  assert.match(cliEngine, /resumeTurn\(this\.id, String\(info\.id\)\)/);
  assert.doesNotMatch(cliEngine, /run\('Continue'\)|text: 'Continue'/);
});

test('permission prompts are answered through the CLI so its deferred resolves', () => {
  // The CLI blocks the tool until this lands; a local approval cache would leave
  // the run waiting forever.
  assert.match(cliClient, /permissions\/\$\{encodeURIComponent\(permissionId\)\}/);
  // The CLI rejects `reply`; the accepted key is `response`.
  assert.match(cliClient, /body: JSON\.stringify\(message \? \{ response, message \} : \{ response \}\)/);
  assert.match(agent, /type: 'permission',[\s\S]{0,200}permissionId/);
});

test('CLI undo and redo go through the CLI revert endpoints', () => {
  assert.match(cliClient, /async revert\(sessionId: string, messageId: string\)/);
  assert.match(cliClient, /body: JSON\.stringify\(\{ messageID: messageId \}\)/);
  assert.match(cliClient, /async unrevert\(/);
});

test('the projection keeps the existing card shapes and adds no second loop', () => {
  // Parts map onto the cards the sidebar already draws.
  assert.match(cliProjection, /kind: 'task'/);
  assert.match(cliProjection, /kind: 'reasoning'/);
  assert.match(cliProjection, /kind: 'divider'/);
  // A compaction is a divider, never a synthetic assistant message.
  assert.match(cliProjection, /case 'compaction':[\s\S]{0,400}kind: 'divider'/);
  // No parallel model-visible history is built beside the CLI's rows.
  assert.doesNotMatch(cliProjection, /ModelMessage|conversation\.messages/);
});

test('the CLI server is discovered or started on loopback and owned carefully', () => {
  assert.match(cliServer, /export function parseListeningUrl/);
  assert.match(cliServer, /serve', '--port', '0', '--hostname', '127\.0\.0\.1'/);
  // Only a server this extension started may be killed on deactivate.
  assert.match(agent, /if \(this\.cliServer\?\.owned\) this\.cliServer\.child\?\.kill\(\)/);
  // A server this extension started is flagged owned; an attached one is not.
  assert.match(cliServer, /return \{ url, child, owned: true, stderrLines \};/);
  // Stderr is captured so crash reasons are not lost when the server exits before printing a URL.
  assert.match(cliServer, /stderrLines/);
  // Attaching is conditional on the server actually serving this workspace. A
  // healthy server belonging to another project must never be adopted, or our
  // sessions get filed under their project.
  assert.match(cliServer, /if \(served && canonical\(served\) === wanted\) return \{ url, owned: false, stderrLines: \[\] \};/);
  // The workspace is named per request, not by the spawn arguments.
  assert.match(cliClient, /\[DIRECTORY_HEADER\]: this\.directory/);
  assert.match(agent, /new CliClient\(this\.engineStatus\.url, directory\)/);
});

test('engine routing is decided per conversation, not per workspace', () => {
  // A chat that already holds local history must not be handed to the CLI just
  // because a server started up. Every entry point routes on the conversation.
  assert.match(agent, /this\.cliOwns\(sending, engine\)/, 'sends route by conversation');
  assert.match(agent, /this\.cliOwns\(conversation, this\.engineStatus\)/, 'retries route by conversation');
  assert.match(agent, /this\.cliOwns\(stopping, this\.engineStatus\)/, 'stops route by conversation');
  // The workspace-wide flag may only be read to decide whether a client exists.
  const workspaceWideGates = agent.match(/this\.engineStatus\.mode === 'cli'/g) ?? [];
  assert.equal(workspaceWideGates.length, 1, 'no path may gate a run on workspace mode alone');
});

test('one conversation never inherits another conversation\'s CLI session', () => {
  // A shared "most recent session" hands every chat the newest session, so a
  // second chat opens showing the first chat's history.
  assert.doesNotMatch(cliEngine, /__last__/);
  assert.match(cliEngine, /owns\(conversationId: string\): boolean/);
});

test('refreshes are ordered so a stale snapshot cannot win', () => {
  // A streaming turn fires a burst of events and each starts its own request.
  // Unordered, a slow early request resolves last and republishes an old
  // snapshot on top of the finished one, freezing the sidebar on a partial
  // transcript -- the turn looks stuck although the CLI holds the full answer.
  assert.match(cliEngine, /const ticket = \+\+this\.refreshTicket/);
  assert.match(cliEngine, /if \(ticket !== this\.refreshTicket\) return;/);
  assert.match(cliEngine, /if \(ticket === this\.refreshTicket\) this\.onError/);
  const body = cliEngine.slice(cliEngine.indexOf('async refresh()'), cliEngine.indexOf('private publish'));
  assert.ok(
    body.indexOf('if (ticket !== this.refreshTicket) return;') < body.indexOf('this.publish('),
    'the stale guard must precede the publish it protects',
  );
});

test('a CLI model mismatch is reported once, not on every send', () => {
  // The sidebar lists SleepyCode providers the CLI has never heard of, so the
  // mismatch is permanent. Repeating the notice on every send buried the
  // transcript under a wall of identical errors and read as the turn breaking.
  assert.match(agent, /private readonly cliModelNotices = new Set<string>\(\)/);
  assert.match(agent, /if \(!this\.cliModelNotices\.has\(conversationId\)\) \{\s*this\.cliModelNotices\.add\(conversationId\)/);
  const start = agent.indexOf('if (!this.cliModelNotices.has(conversationId)');
  const guarded = agent.slice(start, start + 600);
  assert.equal(
    (guarded.match(/type: 'error'/g) ?? []).length,
    1,
    'the notice must be posted once, inside the guard',
  );
  assert.ok(
    guarded.indexOf('this.post(') < guarded.indexOf('}'),
    'the post must sit inside the has/add guard',
  );
});

test('a code review starts its own conversation instead of reading the newest turn changes', () => {
  // "Review code" offers scopes — uncommitted, a branch, a commit, custom
  // instructions — and none of them is "the last response". Routing it to
  // `reviewChanges` resolved the newest assistant turn's tracked files, so
  // choosing "Uncommitted changes" on a dirty workspace reported "No workspace
  // file changes were recorded for this response" and reviewed nothing.
  const adapter = read('src/webview-adapter.ts');
  assert.doesNotMatch(adapter, /case 'startReview':\s*return \{ type: 'reviewChanges'/);
  assert.match(adapter, /case 'startReview': \{[\s\S]{0,400}reviewActions\.reviewStart\(/);
  assertSource(agent, /if \(message\.type === 'startReview'\) \{/);
  // A review is read-only: it opens a new conversation in Ask mode and sends the
  // prompt that names the scope.
  assertSource(agent, /conversation\.mode = 'ask';/);
  assert.match(agent, /type: 'send', text: message\.prompt, conversationId: conversation\.id, mode: 'ask'/);
});

test('the context ring is fed occupancy, and the session readout lives on it', () => {
  const adapter = read('src/webview-adapter.ts');
  const cost = read('src/cost-core.ts');
  const composer = read('webview-ui/sidebar/components/Composer.tsx');
  // The end-of-run `liveUsage` reset zeroed the ring after every response, and
  // the field it used was the run total rather than the window in use.
  assert.match(adapter, /if \(!prompt && !completion && !contextTokens\) return null;/);
  assert.match(adapter, /contextTokens,/, 'the live usage event carries context occupancy');
  assert.match(cost, /export function ringReadout/);
  // One control answers both questions; the separate usage pill is gone.
  assert.doesNotMatch(composer, /className=\{"pill session-pill/);
  assert.match(composer, /<ContextRing[\s\S]{0,1400}cost=\{sessionStats\?\.cost\}/);
});

test('a portal popup is positioned where it is anchored', () => {
  // `useAnchoredMenu` places portals with inline left/top, which does nothing
  // without `position: fixed` — the element then lays out in normal flow after
  // #root, below the fold, and the control that opens it looks dead. The session
  // readout shipped that way: clicking the ring appeared to do nothing at all.
  const sidebarCss = read('webview-ui/sidebar/sidebar.css');
  const rule = sidebarCss.match(/\.session-popover\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule, '.session-popover has a rule');
  assert.match(rule, /position:\s*fixed/);
});

test('the webview follows the host when a run suppresses the transcript snapshot', () => {
  const adapter = read('src/webview-adapter.ts');
  const app = read('webview-ui/sidebar/App.tsx');
  // Withholding the snapshot must not withhold the switch: clicking another tab
  // during a run has to move the view.
  assert.match(adapter, /return \{ type: 'conversationActive', activeId: message\.id \}/);
  assertSource(app, /case "conversationActive":/);
  assertSource(app, /setActiveId\(msg\.activeId\)/);
});

test('a conversation whose transcript was never received can be filled', () => {
  const adapter = read('src/webview-adapter.ts');
  const agentSource = read('src/agent.ts');
  const app = read('webview-ui/sidebar/App.tsx');
  // Switching to a mid-run conversation gets identity only, so the webview can be
  // left holding nothing and render its empty state for a chat full of history.
  assert.match(adapter, /case 'requestTranscript': \{/);
  assertSource(app, /post\(\{ type: "requestTranscript", convId: msg\.activeId \}\)/);
  // Answered even while streaming: that request exists precisely for the case the
  // suppression would otherwise keep empty.
  assert.match(agentSource, /const streaming = Boolean\(streamId && this\.reactStreaming\.has\(streamId\)\) && !this\.reactSnapshotOnce;/);
  assertSource(agentSource, /if \(message\.type === 'requestTranscript'\) \{/);
});

test('a turn that changed files publishes its review bar when it ends', () => {
  const agentSource = read('src/agent.ts');
  // The transcript snapshot is withheld mid-run, and the run-end sync skips the
  // active conversation — so with nothing published at the end of a turn the bar
  // only appeared on the next unrelated republish, in practice a restart.
  assertSource(agentSource, /this\.post\(\{ type: 'done', conversationId, item: assistantItem \}\);/);
  // The bar reads a message of its own, so the turn that produced the files has to
  // publish one; nothing did.
  assertSource(agentSource, /this\.publishPendingChanges\(conversationId\);/);
  // It must only publish for the conversation on screen: the message names none,
  // so a background run's files would appear over whichever chat is open.
  assertSource(agentSource, /project\.activeConversationId !== conversationId\) return;/);
  // And it records the turn, because every action on the bar resolves its files
  // through a conversation AND a turn.
  assertSource(agentSource, /this\.reactChangeTarget\.set\(conversationId, target\)/);
});

test('the last known models and account answer before the network does', () => {
  const agentSource = read('src/agent.ts');
  // A fresh window used to be unusable until two round trips came back, and stayed
  // unusable offline: the picker had no models and the sign-in banner knew nothing.
  assertSource(agentSource, /this\.postCachedModelGroups\(\);[\s\S]{0,80}this\.postCachedAccount\(\);/);
  assertSource(agentSource, /globalState\.update\('sleepycode\.cache\.models'/);
  assertSource(agentSource, /globalState\.update\('sleepycode\.cache\.account'/);
  // The cache is only a head start: a fetch that arrives later still wins.
  assertSource(agentSource, /if \(this\.lastModelGroups\.length\) return;/);
  assertSource(agentSource, /if \(this\.lastSleepyAccountRefresh\) return;/);
});

test('a status scrolled out of view stops animating', () => {
  // The thinking shimmer and the matrix loader loop forever. In a long transcript
  // every one of them keeps restyling itself every frame while the reader is
  // looking at the newest message, off the other end of the chat. The status is
  // flagged when it leaves the viewport and the CSS holds the loops; the two
  // halves are useless apart, so both are pinned here.
  const css = read('webview-ui/shared/activity-effects.css');
  const offscreen = css.match(/\[data-offscreen\][^{]*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(offscreen, 'the offscreen flag must have a rule');
  assert.match(offscreen, /animation-play-state:\s*paused/);
  // Both loops, or the matrix keeps running while the text holds.
  assert.match(css, /\[data-offscreen\][^{]*\.t-think-text::before/);
  assert.match(css, /\[data-offscreen\][^{]*\.t-matrix i/);

  const status = read('webview-ui/shared/ThinkingStatus.tsx');
  assert.match(status, /new IntersectionObserver/);
  assert.match(status, /toggleAttribute\("data-offscreen"/);
  // The element must carry the ref the observer watches, and the observer must
  // be disconnected — an observer per re-render leaks on a streaming turn.
  assert.match(status, /<span ref=\{rootRef\} className=\{`activity-status/);
  assert.match(status, /observer\.disconnect\(\)/);
});

test('an update sent mid-run reaches the running task instead of starting a turn', () => {
  // Four hops, and every one of them has to be present or the words are lost:
  // the adapter flags the send, the host queues it as guidance rather than
  // starting a run, the loop consumes it into the request, and the webview shows
  // it where it landed. A hop that exists but is not reached was this codebase's
  // most expensive recurring bug.
  const adapter = read('src/webview-adapter.ts');
  assert.match(adapter, /case 'steerMessage':/);
  assert.match(adapter, /steering: true,\n/);
  assert.match(agent, /if \(steering && this\.runs\.has\(conversationId\)\)/);
  // The composer's request id rides along so the `steered` echo can name the row.
  assert.match(agent, /this\.enqueue\(sendText, conversationId, composerContext, promptContext, true, \(message as \{ requestId\?: string \}\)\.requestId\)/);
  assert.match(agent, /private drainSteering\(conversationId: string\): string\[\]/);
  // Drained BETWEEN steps, in `prepareStep`: the SDK owns the step loop, so that
  // is the only place an update can reach the next model request. Draining it at
  // the top of the outer loop is what made a mid-run message arrive only after
  // the whole turn had finished.
  assert.match(agent, /prepareStep: \(\{ messages: stepMessages \}\) => steeringStep\(stepMessages\)/);
  assert.match(agent, /const taken = this\.drainSteering\(conversationId\);/);
  assert.match(agent, /runGuidance\.push\(\.\.\.taken\)/);
  // Every update so far, every step: the model has to keep steering by them.
  assert.match(agent, /runGuidance\.map\(guidance => \(\{ role: 'user', content: steeringGuidance\(guidance\) \}\)/);
  // Guidance never stops the run. Aborting and restarting was the old behaviour,
  // and it showed the same words twice while throwing away the work so far.
  assert.doesNotMatch(agent, /run\.steering = true/);
  assert.doesNotMatch(agent, /\.controller\.abort\(\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(message\.type === 'steerQueued'/);
  // The queue row says which kind it is, and the webview keeps that flag.
  assert.match(agent, /queues\[entry\.conversationId\] \?\?= \[\]\)\.push\(\{ id: entry\.id, text: entry\.text,/);
  assert.match(adapter, /item\?\.steering === true \? \{ steering: true \}/);
});

test('a mid-run update is shown inside the work it changed, not as a message', () => {
  const app = read('webview-ui/sidebar/App.tsx');
  const css = read('webview-ui/sidebar/sidebar.css');
  // The reducer files it as a block of the running response…
  assert.match(read('src/shared/turns.ts'), /export interface SteeringBlock \{/);
  // Carries the request id so an echoed update is not drawn a second time.
  assert.match(read('src/shared/turns.ts'), /turn\.blocks\.push\(\{ kind: "steering", text: ev\.text, at: Date\.now\(\), \.\.\.\(ev\.requestId \? \{ requestId: ev\.requestId \} : \{\}\) \}\)/);
  // …the transcript renders it there…
  assertSource(app, /if \(block.kind === "steering"\) return <SteeringNote key=\{index\} text=\{block\.text\} \/>;/);
  // …and the note carries its own rule rather than borrowing the user bubble's
  // class, which lives in a stylesheet the settings window does not share.
  const rule = css.match(/\.steering-note\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule, '.steering-note has a rule');
  assert.match(rule, /background:\s*var\(--user-bubble\)/);
});

test('a persona is a prompt layer the host applies, not a label', () => {
  // The chain, end to end: it is stored, resolved for the chat, appended to the
  // system prompt of the turn, republished when it changes, and shown in the
  // composer. A hop that exists but is never reached is this codebase's most
  // expensive recurring bug, so each one is pinned.
  const personaCore = read('src/personas.ts');
  assert.match(personaCore, /export function personaPromptFor/);
  // A persona with no prompt would look active and change nothing.
  assert.match(personaCore, /an empty prompt would change nothing/);
  assert.match(personaCore, /export const DEFAULT_PERSONA_ID = 'default'/);

  assert.match(agent, /const personaText = personas\.personaPromptFor\(this\.allPersonas\(\), personaId\);/);
  assert.match(agent, /How to work here:/);
  // The run passes the conversation's own choice, so a per-chat override wins.
  assert.match(agent, /await this\.systemPrompt\(root, selection\.agentId, this\.personaIdFor\(conversation\)\)/);
  assert.match(agent, /globalState\.update\('sleepycode\.personas'/);
  assert.match(agent, /globalState\.get<string>\('sleepycode\.activePersonaId'/);

  const adapterSource = read('src/webview-adapter.ts');
  assert.match(adapterSource, /personas: Array\.isArray\(input\.personas\) \? input\.personas : \[\]/);
  assert.match(adapterSource, /case 'setPersona':/);

  const composer = read('webview-ui/sidebar/components/Composer.tsx');
  assertSource(composer, /<PersonaPicker value=\{personaId\} options=\{personas\}/);
  assertSource(read('webview-ui/sidebar/App.tsx'), /post\(\{ type: "setPersona", convId: activeId, personaId: id \}\)/);
});

test('the Indexing page controls the index it describes', () => {
  // The page used to be a readout: it described a real index and offered nothing
  // but Rebuild. Every control it now has must reach the thing it names.
  const panel = read('webview-ui/settings/panels/IndexPanel.tsx');
  assertSource(panel, /setFeatures\(\{ indexingEnabled: value \}\)/);
  assert.match(panel, /vscode\.postMessage\(\{ type: "deleteIndex" \}\)/);
  // The toggle's value already had a counterpart: `indexingEnabled` is
  // `repoIndex`, the setting the indexer is actually gated on.
  assert.match(read('src/feature-prefs.ts'), /if \(typeof input\.indexingEnabled === 'boolean'\) patch\.repoIndex = input\.indexingEnabled;/);
  // Deleting must reach the file, or the next read loads the same index back and
  // the button looks inert.
  assert.match(read('src/project-index.ts'), /async clear\(rootPath: string\): Promise<void> \{/);
  assert.match(agent, /await this\.projectIndex\.clear\(root\.fsPath\)/);
  // Off means the cached copy must not answer the next question.
  assert.match(agent, /if \(!enabled\) this\.projectIndex\.invalidate\(\);/);
  // And the readout says which of those two states it is in.
  assert.match(read('src/index-report.ts'), /enabled: boolean;/);
});

test('the web-search switch is the endpoint the tool is registered from', () => {
  // There is no separate flag: `buildTools` adds `web_search` only when
  // `searxngUrl` is set. A switch that stored anything else would be a control
  // that writes nowhere.
  assert.match(tools, /const endpoint = ctx\.config\(\)\.searxngUrl;\n  if \(endpoint\) \{/);
  const app = read('webview-ui/settings/App.tsx');
  assertSource(app, /onChange=\{\(v\) => set\("searxngUrl", v \? s\.searxngUrl \|\| "http:\/\/localhost:8888" : ""\)\}/);
  // Reading and writing it round-trips through the settings shape, and an
  // endpoint that cannot be fetched is refused rather than half-saved.
  assert.match(read('src/settings-adapter.ts'), /export function normalizeSearxngUrl/);
  assert.match(agent, /searxngUrl: this\.context\.globalState\.get<string>\('sleepycode\.searxngUrl', ''\)/);
  assert.match(agent, /if \(patch\.searxngUrl !== undefined\) await this\.context\.globalState\.update\('sleepycode\.searxngUrl', patch\.searxngUrl \|\| undefined\);/);
});

test('a named subagent carries its own instructions, capability and model', () => {
  // The chain: stored → listed to the model → resolved by name at delegate time →
  // its prompt, capability and model used → a read-only one never gets write tools.
  const core = read('src/subagents.ts');
  assert.match(core, /export function findSubagent/);
  assert.match(core, /export function subagentRosterBlock/);
  const toolsSource = read('src/tools.ts');
  assertSource(toolsSource, /subagent: z\.string\(\)\.max\(60\)\.optional\(\)/);
  assertSource(toolsSource, /delegate\(role, task, context, subagent\)/);
  assert.match(agent, /const definition = subagents\.findSubagent\(this\.delegatableSubagents\(\), subagentName\);/);
  // Capability comes from the definition, not from the role it happens to run on.
  assert.match(agent, /const subagentReadonly = definition \? definition\.readonly : role !== 'worker';/);
  assert.match(agent, /const roleTools = subagentReadonly\n/);
  // Model precedence: the definition wins, then the role's model, then the chat's.
  // Each source is trimmed: `provider('')` is a request no provider can serve.
  assert.match(agent, /const subagentModelId = definition\?\.model\?\.trim\(\) \|\| this\.subagentModels\(\)\[role\]\?\.trim\(\) \|\| model;/);
  // The roster is stated up front: a roster the model never sees is one it invents.
  assert.match(agent, /const rosterBlock = subagents\.subagentRosterBlock\(this\.delegatableSubagents\(\)\);/);
});

test('a team narrows the roster, and assigns nothing by default', () => {
  const core = read('src/subagents.ts');
  assert.match(core, /export function resolveTeamSubagents/);
  // No assigned team means everyone: the behaviour that existed before teams.
  assert.match(core, /if \(!active\.length\) return \[\.\.\.all\];/);
  // An assigned team whose members were all deleted falls back to everyone.
  assert.match(core, /return picked\.length \? picked : \[\.\.\.all\];/);
  // Deleting a subagent cannot leave a ghost on a roster.
  assert.match(agent, /await this\.context\.globalState\.update\('sleepycode\.teams', subagents\.normalizeTeams\(this\.context\.globalState\.get<unknown>\('sleepycode\.teams', \[\]\), known\)\);/);
  const panel = read('webview-ui/settings/panels/SubagentsPanel.tsx');
  assertSource(panel, /vscode\.postMessage\(\{ type: "setActiveTeams", ids: next \}\)/);
  assertSource(panel, /vscode\.postMessage\(\{ type: "saveSubagent", draft: subDraft\.value \}\)/);
  assertSource(panel, /vscode\.postMessage\(\{ type: "saveTeam", draft: teamDraft\.value \}\)/);
});

test('a panel nothing renders is deleted, not kept behind a barrel', () => {
  // `ProvidersPanel` and `ModelsPanel` were exported from the settings barrel and
  // never rendered: this build serves those screens from `ProviderKeysPanel` and
  // `ModelOptionsPanel`. A barrel export is enough to keep a dead screen, its
  // tests and its CSS alive for years while reading as live code.
  const barrel = read('webview-ui/settings/FeaturePanels.tsx');
  // The comment above the exports explains what left and why; what matters is
  // that nothing re-exports them.
  assert.doesNotMatch(barrel, /export \{[^}]*ProvidersPanel/);
  assert.doesNotMatch(barrel, /export \{[^}]*ModelsPanel/);
  // The one live component that lived in ProvidersPanel moved out with it.
  assert.match(barrel, /export \{ OAuthAccountCard \} from "\.\/panels\/OAuthAccountCard";/);
  for (const dead of [
    'webview-ui/settings/panels/ProvidersPanel.tsx',
    'webview-ui/settings/panels/ApiProviderCard.tsx',
    'webview-ui/settings/panels/ApiKeyDialog.tsx',
    'webview-ui/settings/panels/ProviderPickerDialog.tsx',
    'webview-ui/settings/panels/ModelsPanel.tsx',
    'webview-ui/settings/DocsSection.tsx',
  ]) {
    assert.equal(existsSync(new URL(`../${dead}`, import.meta.url)), false, `${dead} should be gone`);
  }
  // Their CSS was briefly deleted with them and that was a mistake: the pruner
  // split selector lists on commas without respecting parentheses and produced
  // malformed rules elsewhere in the same file. The stylesheet is whole again;
  // unused rules cost bytes, a broken rule costs the page.
});

test('a host message the webview waits for is translated, not dropped', () => {
  // The failure this pins: the host posts, the adapter's switch has no case, the
  // message becomes null, and the reader that was written for it never fires. The
  // feature looks wired and does nothing.
  const adapterSource = read('src/webview-adapter.ts');
  for (const type of ['approvalResolved', 'fileIcon', 'pasteResolved']) {
    assert.match(adapterSource, new RegExp(`case '${type}':`), `${type} must be translated`);
  }
  // The shapes the readers actually use, not just the type strings.
  assert.match(adapterSource, /convId: message\.conversationId \?\? '',\n        requestId: String\(message\.requestId \?\? ''\),\n        approved: message\.approved === true,/);
  assert.match(adapterSource, /type: 'fileIcon', filename: String\(message\.filename \?\? ''\), icon: message\.icon \?\? null/);
  assert.match(adapterSource, /type: 'pasteResolved', requestId: message\.requestId/);
  // A command that revealed the chat and posted a message nothing reads now opens
  // the page it names.
  assert.match(agent, /if \(this\.reactMode\) \{ void this\.showSettings\(false, 'usage'\); return; \}/);
  assert.match(agent, /if \(this\.reactMode\) \{ void this\.showSettings\(false, 'marketplace'\); return; \}/);
});

test('state that belongs to one conversation is not applied to another', () => {
  const app = read('webview-ui/sidebar/App.tsx');
  // A background run publishes its own stats; the ring belongs to the visible chat.
  assertSource(app, /if \(msg\.convId && activeIdRef\.current && msg\.convId !== activeIdRef\.current\) break;/);
  // The persona a chat runs on travels with the conversation, or a per-chat
  // override silently reverts on every switch.
  assert.match(agent, /personaId: this\.personaIdFor\(active\), compactionUndoable, compactionRedoable \}\);/);
  assert.match(read('src/webview-adapter.ts'), /\.\.\.\(typeof message\.personaId === 'string' \? \{ personaId: message\.personaId \} : \{\}\)/);
  // Steering guidance carries the queue id it consumed, so the optimistic row is
  // cleared rather than re-inserted on every workflow update.
  assert.match(agent, /this\.post\(\{ type: 'steered', conversationId, requestId: entry\.id, text: entry\.text \}\)/);
});

test('the @-mention menu claims its keys before ProseMirror does', () => {
  // ProseMirror binds Enter and the arrows directly on the contenteditable, so a
  // bubble-phase handler never sees them. Choosing a mention with Enter therefore
  // submitted the message instead — the same defect the slash palette had.
  const composer = read('webview-ui/sidebar/components/Composer.tsx');
  // One owner for the decision, called from the capture phase…
  assertSource(composer, /onKeyDownCapture=\{\(e\) => \{/);
  assertSource(composer, /if \(handleMentionKeys\(e\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); return; \}/);
  // …and the capture handler no longer bails out while the mention menu is open.
  assert.doesNotMatch(composer, /if \(!slashOpenNowRef\.current \|\| mentionOpenRef\.current\) return;/);
  // The bubble path stays as a fallback for what capture declines, and it still
  // cannot run the submit branch for a key the menu took.
  assertSource(composer, /if \(handleMentionKeys\(e\)\) \{ e\.preventDefault\(\); return; \}\s*if \(e\.key === "Enter" && \(submitWithCtrlEnter/);
  // Enter, Tab and the arrows are all in the claimed set.
  assert.match(composer, /const handleMentionKeys = \(e: React\.KeyboardEvent\): boolean => \{/);
  for (const key of ['"ArrowDown"', '"ArrowUp"', '"Enter"', '"Tab"', '"Escape"']) {
    assert.ok(composer.includes(key), `the menu must claim ${key}`);
  }
});

test('the small ones: a re-used toast, a re-posted list, a queued edit', () => {
  // A notice replaced under the same id (an approval result reusing the row) is
  // new reading; with only the id in the dependency list the old timer kept
  // running and dismissed it mid-sentence.
  const toast = read('webview-ui/sidebar/components/Toast.tsx');
  assertSource(toast, /}, \[paused, toast\.id, toast\.kind, toast\.title, toast\.message, onDismiss\]\);/);

  // The host re-posts the same conversations on every render. Depending on the
  // array's identity restarted the debounced search each time, bumping the
  // request id and dropping the results on screen — the list flickered while
  // nothing had changed.
  const history = read('webview-ui/sidebar/components/History.tsx');
  assert.match(history, /const listKey = list\.map\(\(c\) => `\$\{c\.id\}:\$\{c\.title\}`\)\.join\('\\u0000'\);/);
  assertSource(history, /}, \[query, archived, listKey\]\);/);
  assert.doesNotMatch(history, /\[query, archived, list\]/);

  // Editing a queued message pulls it back into the composer through
  // `setTabDraft`, which owns the workspace-ready guard and the New Chat tab
  // pinning. Going around it skipped both.
  const app = read('webview-ui/sidebar/App.tsx');
  assert.match(app, /setDraft\(draft\);/);
  assert.match(app, /setTabDraft\(draftKey, draft\);/);
  // The bypass is gone: no direct write to the draft map in this path.
  assert.doesNotMatch(app, /draftsRef\.current\.set\(draftKey, draft\);/);
});

test('mid-run guidance keeps steering, it does not steer once and lapse', () => {
  // The fault: the guidance was appended to that step's messages only. The next
  // iteration rebuilt its request from history + this turn's messages + the
  // prompt, so the update vanished — the model obeyed it for one step and then
  // carried on as before.
  assert.match(agent, /const runGuidance: string\[\] = \[\];/);
  assert.match(agent, /runGuidance\.push\(\.\.\.taken\);/);
  assert.match(agent, /for \(const guidance of runGuidance\) agentMessages\.push\(/);
  // Every step, not just the one that took it.
  assert.doesNotMatch(agent, /const steered = this\.drainSteering\(conversationId\);/);
  // And it survives the turn: persisted with the messages, after the work, so a
  // later turn knows what was asked mid-run. Recorded as an ASSISTANT message —
  // a `user` one there would put two user turns in a row into the next request.
  assert.match(agent, /const flushGuidance = \(\): void => \{/);
  assert.match(agent, /runMessages\.push\(\{ role: 'assistant', content: guidance \}/);
  assert.doesNotMatch(agent, /runMessages\.push\(\{ role: 'user', content: steeringGuidance/);
  const flushes = [...agent.matchAll(/flushGuidance\(\);/g)].length;
  const appends = [...agent.matchAll(/appendConversationMessages\(conversation, historyUserText, runMessages, Boolean\(resume\)\)/g)].length;
  assert.equal(flushes, appends, 'each persistence point must flush the guidance first');
});

test('a steering request the host never answers does not linger on screen', () => {
  const app = read('webview-ui/sidebar/App.tsx');
  // The host's queue is authoritative: a pending marker for an entry it no longer
  // lists has been answered or dropped, and waiting for the event that would clear
  // it leaves a "Steering…" row on screen for the rest of the session.
  assertSource(app, /if \(!rows\.some\(row => row\.id === pendingId\) && !mailbox\.some\(entry => entry\.id === pendingId\)\) pending\.delete\(pendingId\);/);
  assertSource(app, /if \(!pending\.size\) pendingSteeringRef\.current\.delete\(id\);/);
});

test('the loop stops itself before a step can overflow the window', () => {
  // The provider's prompt_tokens for the previous step is measured truth — it
  // includes the system prompt, the tools, the stored history and this turn's tool
  // results. It was collected and only used to stamp a number on the finished item:
  // nothing acted on it, so the first thing to notice a full window was the provider
  // rejecting the request, which loses the turn.
  const guard = read('src/context-guard.ts');
  assert.match(guard, /export function contextPressure/);
  assert.match(guard, /export const CONTEXT_PRESSURE_RATIO = 0\.9/);
  assert.match(agent, /if \(contextPressure\(\{ measuredPromptTokens: lastStepInput, contextWindow: modelInfo\.contextWindow, budgetTokens \}\) === 'near'\)/);
  assert.match(agent, /throw contextLimitReached\(lastStepInput, modelInfo\.contextWindow, budgetTokens\)/);
  // Our own stop is recoverable, unlike a provider rejection: compaction runs before
  // the turn is committed, so the card offers a retry instead of a dead end.
  assert.match(agent, /if \(error instanceof ContextLimitError\) \{/);
  assert.match(agent, /errorInfo\.primaryLabel = 'Retry with compacted history';/);
  // …and it says so out loud rather than stopping silently.
  assert.match(agent, /The work so far is kept; older turns are compacted so continuing fits\./);
});

test('the turn in flight is budgeted for the request but never lost from the transcript', () => {
  const guard = read('src/context-guard.ts');
  // Messages are never removed (a missing tool result is what providers reject) and
  // the caller's array is never mutated (it is what the turn persists).
  assert.match(guard, /export function trimToolResultsForRequest/);
  assert.match(guard, /Messages are never removed, and the caller's array is never mutated/);
  assert.match(agent, /const liveBudget = liveSliceBudget\(\{/);
  assert.match(agent, /const trimmedLive = trimToolResultsForRequest\(runMessages, liveBudget, estimateMessageTokens\);/);
  // The saved transcript keeps the whole slice.
  assert.match(agent, /if \(runMessages\.length\) this\.appendConversationMessages\(conversation, historyUserText, runMessages, Boolean\(resume\)\)/);
  // And the model is told when a result it "read" is no longer in front of it.
  assert.match(agent, /were left out of the request to stay within the model's window/);
  // An empty reply at high pressure is not retried twice: same context, same result.
  assert.match(read('src/util.ts'), /if \(!text\) return !options\.nearLimit;/);
  assert.match(agent, /shouldAutoContinue\(answer, finishReason, continuationCount, \{ nearLimit \}\)/);
});

test('tone is a persona, capability is an agent — one list each', () => {
  // Apex, Phantom, Pivot, Forge and Stack shipped as built-in "agents" while being
  // id + name + a paragraph about how to work: no model, no tool policy. That is a
  // persona, and keeping them in the agent list meant the composer offered the same
  // idea twice, with `default` appearing in both.
  const personaCore = read('src/personas.ts');
  for (const id of ['apex', 'phantom', 'pivot', 'forge', 'stack']) {
    assert.match(personaCore, new RegExp(`id: '${id}'`), `${id} belongs to the persona catalogue`);
  }
  // The agent list keeps only "nothing special"; the rest are user agents, which
  // really do carry a model and a tool allow/deny list.
  const definitions = agent.match(/export const AGENT_DEFINITIONS[\s\S]*?\n\];/)?.[0] ?? '';
  assert.deepEqual([...definitions.matchAll(/\{\s*id: '([a-z0-9-]+)'/g)].map(m => m[1]), ['default']);
  // A chat saved while those ids were agents keeps the tone it was using…
  assert.match(agent, /agentId: isLegacyPersonaAgent\(conversation\.agentId\) \? 'default' : conversation\.agentId \?\? base\.agentId,/);
  assert.match(agent, /if \(isLegacyPersonaAgent\(conversation\?\.agentId\)\) return personas\.personaById\(this\.allPersonas\(\), conversation!\.agentId\)\.id;/);
  // …and a custom agent may not take a persona's name back.
  assert.match(read('src/agent-editor.ts'), /if \(RESERVED_PERSONA_IDS\.has\(id\)\) return `"\$\{id\}" is a persona\./);
  // A single option is not a choice, so the agent picker only appears once there is one.
  assertSource(read('webview-ui/sidebar/components/Composer.tsx'), /!editing && agentOptions\.length > 1 && \(/);
});

test('the persona chip represents the chat on screen, and nothing else resets it', () => {
  // The host used to publish the GLOBAL default as `activePersonaId` on every config
  // message, and the webview adopted it unconditionally on empty chats — so any
  // config change wiped the persona the user had chosen for this conversation.
  assert.match(agent, /activePersonaId: this\.personaIdFor\(active\),/);
  assert.doesNotMatch(agent, /this\.post\(\{ type: 'config', personas: this\.allPersonas\(\), activePersonaId: this\.defaultPersonaId\(\) \}\);/);
  // The settings page still edits the default for NEW chats, so that read keeps it.
  assert.match(agent, /readPersonas: async \(\) => \(\{ personas: this\.allPersonas\(\), activePersonaId: this\.defaultPersonaId\(\) \}\)/);
  const app = read('webview-ui/sidebar/App.tsx');
  assertSource(app, /if \(msg\.activePersonaId\) setPersonaId\(msg\.activePersonaId\);/);
  assert.doesNotMatch(app, /if \(sessionFor\(activeIdRef\.current\)\.turns\.length === 0\) setPersonaId\(msg\.activePersonaId \|\| "default"\);/);
  // The "no persona" row can never be removed, whatever the host labelled it.
  assertSource(read('webview-ui/settings/panels/PersonasPanel.tsx'), /persona\.builtin === true \|\| persona\.id === DEFAULT_PERSONA_ID/);
});

test('a stop that lands while the stream drains still commits as a stop, not a success', () => {
  // The completion path persists the assistant item and posts `done`. It used to
  // run with no abort check, so pressing stop in the window between the last
  // step finishing and the turn being committed produced a "completed" turn for
  // work the user cancelled — and the stop branch that preserves the partial
  // work as a retryable card never ran.
  assertSource(agent, /if \(run\.controller\.signal\.aborted\) \{\s*throw run\.controller\.signal\.reason instanceof Error/);
  const stopCheck = agent.indexOf('if (run.controller.signal.aborted) {\n            throw run.controller.signal.reason');
  const donePost = agent.indexOf("this.post({ type: 'done', conversationId, item: assistantItem });");
  assert.ok(stopCheck > 0 && donePost > stopCheck, 'the abort check must precede the commit');
});

test('a run whose promise rejects is aborted before its entry is dropped', () => {
  // Deleting the entry alone marked the conversation idle while the stream was
  // still writing into it; `run()`'s own finally then cleared `runs` again and
  // drained the queue, and the turn's text kept arriving on a finished chat.
  const start = agent.indexOf("this.log('error', 'run.unhandled', detail);");
  // Window covers the explanatory comment between the log and the abort.
  const body = agent.slice(start, start + 800);
  assert.match(body, /this\.runs\.get\(conversationId\)\?\.controller\.abort\(\);/);
  assert.doesNotMatch(body, /this\.runs\.delete\(conversationId\);/);
});

test('the pre-turn git baseline is captured before the run can edit anything', () => {
  // Captured concurrently, `git add -A` could snapshot the mid-turn state: the
  // turn's first edits became the "before" snapshot and could neither be undone
  // nor be reported as changed.
  const start = agent.indexOf('let runGitTree = gitTracked ? carryTree : undefined;');
  const body = agent.slice(start, start + 1400);
  assert.match(body, /runGitTree = await captureGitTree\(root\.fsPath, \{ signal: run\.controller\.signal, timeoutMs: 15_000 \}\)/);
  assert.doesNotMatch(body, /void captureGitTree\(/);
});

test('a finished run never starts another conversation\'s queued prompt', () => {
  // Falling back to `this.queue[0]` ran a different chat's prompt from this
  // chat's finally block — before that chat's own turn had finished.
  const start = agent.indexOf("// Only THIS conversation's next prompt is drained here.");
  assert.ok(start > 0, 'the drain comment is present');
  // Anchored on the code, not the prose: the comment above it names the old
  // fallback by way of explaining why it is gone.
  const body = agent.slice(start, start + 900);
  assert.match(body, /const own = this\.queue\.find\(entry => entry\.conversationId === conversationId && !entry\.steering\);/);
  assert.doesNotMatch(body, /= own \?\? this\.queue\[0\]/);
  assert.doesNotMatch(body, /queue\.find\(entry => entry\.conversationId === conversationId\) \?\? this\.queue\[0\]/);
});
