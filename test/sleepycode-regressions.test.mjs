import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const agent = read('src/agent.ts');
const runtime = read('src/webview/runtime.ts');
const webviewHtml = read('src/webview.ts');
const compactionCore = read('src/compaction-core.ts');
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
  assert.match(agent, /try \{\s*if \(!providerConfig\) throw new Error/);
  assert.match(agent, /await this\.refreshModels\(\);\s*configuredModel = this\.selectionFor\(conversation\)\.model/);
  assert.match(agent, /if \(!sleepyToken\) throw new Error\('SleepyAI session is missing or expired/);
  assert.match(agent, /finally\s*\{[\s\S]*this\.runs\.delete\(conversationId\)/);
});

test('chat text breaks pathological long words without wrapping code blocks', () => {
  assert.match(styles, /\.user-text\{[^}]*overflow-wrap:anywhere[^}]*word-break:break-word/);
  assert.match(styles, /\.assistant\{[^}]*overflow-wrap:anywhere[^}]*word-break:break-word/);
  assert.match(styles, /\.assistant pre,\.assistant pre code\{[^}]*overflow-wrap:normal[^}]*word-break:normal/);
});

test('agent iterations default to 50 steps and expose a resumable max-step pause', () => {
  assert.equal(pkg.contributes.configuration.properties['sleepycode.maxSteps'].default, 50);
  assert.match(agent, /config\.get<number>\('maxSteps', 50\)/);
  assert.match(agent, /config\.update\('maxSteps', 50/);
  assert.match(agent, /pausedByStepLimit\(maxSteps, lastIterationStepCount, finishReason\)/);
  assert.match(agent, /message\.type === 'continueIteration'/);
  assert.match(types, /paused\?: boolean/);
  assert.match(runtime, /Continue iteration/);
});

test('sending during an active run queues without rendering a fake first send', () => {
  assert.match(runtime, /if\(wasRunning\)\{queuedByConversation\.set\(activeConversationId,optimisticText\);updateQueuedVisibility\(\);vscode\.postMessage\(\{type:'send'/);
  const queuedBranch = runtime.match(/if\(wasRunning\)\{([\s\S]*?)updateSendMode\(\);return\}/)?.[1] ?? '';
  assert.doesNotMatch(queuedBranch, /beginTurn\(/);
  assert.doesNotMatch(queuedBranch, /runningSet\.add/);
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

test('context occupancy is estimated from transcript text, never from cumulative token counters', () => {
  // The pre-fix "5.33M / 1M" bug summed per-item lifetime token counters and
  // displayed the total as context-window usage. That pattern must not return.
  assert.doesNotMatch(agent, /sessionMetricsForConversation/);
  const sessionMetrics = runtime.match(/function sessionMetrics\(\)\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(sessionMetrics, 'sessionMetrics exists in the webview runtime');
  assert.doesNotMatch(sessionMetrics, /contextTokens\s*=\s*inTok\+outTok/);
  assert.match(sessionMetrics, /contextTokens=1500\+Math\.ceil\(chars\/4\)/);
  assert.match(runtime, /statContext\.textContent=fmt\(s\.contextTokens\)/);
  assert.match(compactionCore, /export function estimateContextTokens/);
});

test('auto-compaction runs after the run leaves this.runs, with a cooldown', () => {
  const finallyBlock = agent.match(/\} finally \{\s*await mcpConnection\?\.close\(\);[\s\S]*?this\.postQueued/)?.[0] ?? '';
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
  assert.match(agent, /abortSignal: signal/);
  assert.match(agent, /if \(signal\.aborted\) throw error; \/\/ cancellation must not fall through/);
  assert.match(webviewHtml, /id="compactionOverlay"/);
  assert.match(styles, /\.compaction-overlay\{/);
});

test('summary items record only the compaction call usage, not pre-compaction totals', () => {
  const summarize = agent.match(/private async summarizeConversation\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(summarize, 'summarizeConversation found');
  assert.doesNotMatch(summarize, /items\.reduce\(\(sum, item\)/);
  assert.match(summarize, /usage = await result\.usage/);
  assert.match(summarize, /if \(usage\?\.inputTokens\) summary\.inputTokens = usage\.inputTokens/);
  assert.match(summarize, /compactionPromptInput\(items\)/);
});

test('/compact fires immediately and only as an exact command', () => {
  assert.match(runtime, /case'\/compact':handleCompactProgress\(\{conversationId:activeConversationId,phase:'start'\}\)/);
  assert.match(runtime, /if\(trimmed\.toLowerCase\(\)===first&&runDirectSlash\(first\)\)/);
});
