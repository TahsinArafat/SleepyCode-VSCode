import test from 'node:test';
import assert from 'node:assert/strict';

const mode = await import('../src/agent-mode.ts');

// The permission ceiling is the guarantee that delegation cannot escalate.
// A depth-n agent must never hand a depth-(n+1) agent more than it has.

const ALL_TOOLS = Object.fromEntries([
  'plan', 'ask_user', 'read_file', 'list_files', 'search_files', 'get_diagnostics',
  'write_file', 'replace_text', 'delete_file', 'run_command',
  'terminal_start', 'terminal_read', 'memory_update', 'memory_read',
  'browser_navigate', 'browser_snapshot', 'delegate_task',
].map((name) => [name, { name }]));

test('a subagent ceiling is a subset of the parent ceiling in every mode', () => {
  for (const parent of ['agent', 'ask', 'plan']) {
    const parentTools = mode.applyCeiling(ALL_TOOLS, parent);
    // A worker would ask for everything; the ceiling must still hold.
    const workerTools = mode.applyCeiling({ ...ALL_TOOLS }, parent);
    for (const name of Object.keys(workerTools)) {
      assert.ok(name in parentTools, `${name} leaked to a subagent in ${parent} mode`);
    }
  }
});

test('ask and plan withhold every writing tool', () => {
  for (const readOnly of ['ask', 'plan']) {
    const tools = mode.applyCeiling(ALL_TOOLS, readOnly);
    for (const name of ['write_file', 'replace_text', 'delete_file', 'run_command', 'terminal_start', 'memory_update', 'browser_navigate']) {
      assert.equal(name in tools, false, `${name} must be withheld in ${readOnly}`);
    }
    for (const name of ['read_file', 'search_files', 'ask_user', 'browser_snapshot', 'delegate_task']) {
      assert.ok(name in tools, `${name} should stay available in ${readOnly}`);
    }
  }
});

test('delegation is still offered in read-only modes, because research is read-only', () => {
  // Withholding it entirely would remove a legitimate capability; the ceiling is
  // what stops a delegated worker from writing.
  assert.ok('delegate_task' in mode.applyCeiling(ALL_TOOLS, 'ask'));
});

test('the ceiling reports what it removed, so the guarantee is inspectable', () => {
  const withheld = mode.withheldByCeiling(ALL_TOOLS, 'ask');
  assert.ok(withheld.includes('write_file'));
  assert.ok(withheld.includes('run_command'));
  assert.equal(withheld.includes('read_file'), false);
  // Sorted, so log lines and assertions are stable.
  assert.deepEqual(withheld, [...withheld].sort());
});

test('an unknown mode is read-only, never agent', () => {
  assert.equal(mode.isToolAllowedInMode('nonsense', 'write_file'), false);
  assert.equal(mode.isToolAllowedInMode(undefined, 'write_file'), false);
  assert.equal(mode.isToolAllowedInMode('nonsense', 'read_file'), true);
});

test('resolveRunMode prefers the message, then the conversation, then the last choice', () => {
  assert.equal(mode.resolveRunMode({ messageMode: 'ask', conversationMode: 'agent', lastMode: 'plan' }), 'ask');
  assert.equal(mode.resolveRunMode({ conversationMode: 'plan', lastMode: 'ask' }), 'plan');
  assert.equal(mode.resolveRunMode({ lastMode: 'ask' }), 'ask');
  assert.equal(mode.resolveRunMode({}), 'agent');
  assert.equal(mode.resolveRunMode(undefined), 'agent');
});

test('a bogus mode falls through rather than becoming agent', () => {
  assert.equal(mode.resolveRunMode({ messageMode: 'nope', lastMode: 'plan' }), 'plan');
});

test('read-only modes are told they cannot write, and that delegation will not help', () => {
  for (const readOnly of ['ask', 'plan']) {
    const text = mode.modeGuidance(readOnly);
    assert.match(text, /read-only/i);
    // The exact workaround the model actually attempted.
    assert.match(text, /delegat/i);
    assert.match(text, /Agent mode/);
  }
});

test('agent mode is told it may act, within approval', () => {
  const text = mode.modeGuidance('agent');
  assert.match(text, /Agent/);
  assert.match(text, /approval/i);
});

test('a subagent in a read-only parent is told its limits explicitly', () => {
  assert.match(mode.subagentGuidance('ask'), /Inherited limits/);
  assert.match(mode.subagentGuidance('plan'), /Inherited limits/);
  // An agent-mode subagent needs no disclaimer.
  assert.equal(mode.subagentGuidance('agent'), '');
});

test('guidance exists for every mode, so none runs unprompted', () => {
  for (const value of ['agent', 'ask', 'plan']) {
    assert.ok(mode.modeGuidance(value).length > 0, `${value} has no guidance`);
  }
});

// ---------------------------------------------------------------- plan mode grant

test('plan mode may save its plan but nothing else', () => {
  assert.equal(mode.isToolAllowedInMode('plan', 'write_plan'), true);
  // The grant is narrow: it does not open general file writing.
  for (const tool of ['write_file', 'replace_text', 'delete_file', 'run_command']) {
    assert.equal(mode.isToolAllowedInMode('plan', tool), false, `${tool} must stay withheld`);
  }
});

test('ask mode still cannot write anything at all', () => {
  assert.equal(mode.isToolAllowedInMode('ask', 'write_plan'), false);
  assert.equal(mode.isToolAllowedInMode('ask', 'write_file'), false);
});

test('the plan grant is never handed to a subagent', () => {
  // A subagent has no plan to save, and the grant would widen the parent's
  // permission through delegation.
  assert.equal(mode.isToolAllowedForSubagent('plan', 'write_plan'), false);
  assert.equal('write_plan' in mode.applySubagentCeiling({ write_plan: {}, read_file: {} }, 'plan'), false);
  assert.deepEqual(mode.withheldFromSubagent({ write_plan: {} }, 'plan'), ['write_plan']);
});

test('a subagent ceiling is still a subset of the parent ceiling', () => {
  const tools = { read_file: {}, write_plan: {}, write_file: {}, delegate_task: {} };
  for (const value of ['agent', 'ask', 'plan']) {
    const parent = mode.applyCeiling(tools, value);
    const child = mode.applySubagentCeiling(tools, value);
    for (const name of Object.keys(child)) {
      assert.ok(name in parent, `${name} leaked in ${value}`);
    }
  }
});

test('ask guidance tells the model not to change any file', () => {
  assert.match(mode.modeGuidance('ask'), /Do NOT try to change any file/);
});

test('plan guidance names write_plan and keeps it to the plan itself', () => {
  const text = mode.modeGuidance('plan');
  assert.match(text, /write_plan/);
  assert.match(text, /\.sleepycode\/plans\//);
});
