import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const agent = read('src/agent.ts');
const runtime = read('src/webview/runtime.ts');
const styles = read('src/webview/styles.ts');
const tools = read('src/tools.ts');
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
  assert.equal(new RegExp(['Sleepy','IDE'].join('') + '|' + ['sleepy','ide'].join('')).test(primary), false);
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
  assert.match(agent, /await this\.refreshModels\(\);\s*\(\{ model: configuredModel, maxSteps, apiKey, baseUrl \} = this\.config\(\)\)/);
  assert.match(agent, /if \(!sleepyToken\) throw new Error\('SleepyAI session is missing or expired/);
  assert.match(agent, /finally\s*\{[\s\S]*this\.runs\.delete\(conversationId\)/);
});
