import test from 'node:test';
import assert from 'node:assert/strict';
import * as editor from '../src/agent-editor.ts';

/*
 * The settings rail's Agents section was never an agent manager — it rendered
 * text-size controls. The real list existed in the host all along. These are the
 * rules the page validates with, so a mistake is reported where it was made
 * rather than as a notification after the dialog closed.
 */

const builtIns = [
  { id: 'apex', name: 'Apex (Builder)' },
  { id: 'phantom', name: 'Phantom (Debugger)' },
  { id: 'default', name: 'SleepyCode' },
];

test('built-ins come first, read-only, with their role split from the name', () => {
  const rows = editor.agentRows(builtIns, [{ id: 'mine', name: 'My agent', prompt: 'Be brief.' }]);
  assert.deepEqual(rows.map(row => row.id), ['apex', 'phantom', 'default', 'mine']);
  assert.equal(rows[0].builtIn, true);
  // The host stores `Apex (Builder)`; the label is the name and the role apart.
  assert.equal(rows[0].name, 'Apex');
  assert.equal(rows[0].role, 'Build');
  assert.equal(rows[3].builtIn, false);
  assert.equal(rows[3].role, 'Custom');
  assert.equal(rows[3].prompt, 'Be brief.');
});

test('a custom agent cannot shadow a built-in, and is not offered', () => {
  // The host resolves agents by id and built-ins win, so that row could never run.
  const rows = editor.agentRows(builtIns, [{ id: 'apex', name: 'Impostor' }, { id: 'apex', name: 'Impostor again' }]);
  assert.equal(rows.filter(row => row.id === 'apex').length, 1);
  assert.equal(rows.find(row => row.id === 'apex').builtIn, true);
});

test('a draft is refused when it would not save correctly', () => {
  const existing = editor.agentRows(builtIns, [{ id: 'mine', name: 'My agent' }]);
  assert.match(editor.validateAgentDraft({ ...editor.emptyAgentDraft(), id: 'x', name: '' }, existing), /name/);
  assert.match(editor.validateAgentDraft({ ...editor.emptyAgentDraft(), id: '', name: 'X' }, existing), /id/);
  assert.match(editor.validateAgentDraft({ ...editor.emptyAgentDraft(), id: 'has space', name: 'X' }, existing), /letters, numbers/);
  // Saving over a built-in would delete it from the menu.
  assert.match(editor.validateAgentDraft({ ...editor.emptyAgentDraft(), id: 'apex', name: 'X' }, existing), /built-in/);
  // Saving over someone else's agent replaced it, because the host upserts by id.
  assert.match(editor.validateAgentDraft({ ...editor.emptyAgentDraft(), id: 'mine', name: 'X' }, existing, { isNew: true }), /already used/);
  // Editing the agent itself keeps its own id.
  assert.equal(editor.validateAgentDraft({ ...editor.emptyAgentDraft(), id: 'mine', name: 'Renamed' }, existing), null);
});

test('allow and deny together are refused, because the rule contradicts itself', () => {
  const draft = { ...editor.emptyAgentDraft(), id: 'a', name: 'A', allow: 'readFile', deny: 'writeFile' };
  assert.match(editor.validateAgentDraft(draft, []), /contradict/);
  // Either one alone is fine.
  assert.equal(editor.validateAgentDraft({ ...draft, deny: '' }, []), null);
  assert.equal(editor.validateAgentDraft({ ...draft, allow: '' }, []), null);
});

test('a draft becomes a record with its empty fields omitted, not stored blank', () => {
  const agent = editor.agentFromDraft({ id: ' mine ', name: ' My agent ', prompt: '  ', model: '', allow: 'readFile, grep', deny: '' });
  assert.equal(agent.id, 'mine');
  assert.equal(agent.name, 'My agent');
  // A blank prompt would read as "this agent has no instructions", which is not
  // the same as "no prompt was given".
  assert.equal('prompt' in agent, false);
  assert.deepEqual(agent.tools, { allow: ['readFile', 'grep'] });
});

test('tool lists survive a round trip through the text field', () => {
  assert.deepEqual(editor.parseToolList('readFile, grep\n  writeFile '), ['readFile', 'grep', 'writeFile']);
  assert.equal(editor.formatToolList(['readFile', 'grep']), 'readFile, grep');
  assert.equal(editor.formatToolList(undefined), '');
  assert.deepEqual(editor.parseToolList('   '), []);
});

test('an existing agent round-trips through the form unchanged', () => {
  const [row] = editor.agentRows([], [{ id: 'mine', name: 'Mine', prompt: 'Be brief', model: 'm1', tools: { deny: ['writeFile'] } }]);
  const draft = editor.draftFromRow(row);
  assert.equal(draft.allow, '');
  assert.equal(draft.deny, 'writeFile');
  assert.deepEqual(editor.agentFromDraft(draft), { id: 'mine', name: 'Mine', prompt: 'Be brief', model: 'm1', tools: { deny: ['writeFile'] } });
});