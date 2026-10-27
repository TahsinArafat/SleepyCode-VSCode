import test from 'node:test';
import assert from 'node:assert/strict';
import * as agents from '../src/agent-options.ts';

/*
 * The classic composer had an agent menu; the React one has no selector at all,
 * so the only way to change agent was the Agents panel (a command) or typing
 * `@agent-id` blind. The host has implemented `selectAgent` all along.
 *
 * The presentation lives here because the two sides disagree about names: the
 * host stores `Apex (Builder)` and the menu the user reads says `Apex` with the
 * word `Build` beside it. One module owns that mapping, and a custom agent is
 * passed through rather than forced into the built-in vocabulary.
 */

test('the six built-ins get the short name and role the menu shows', () => {
  const options = agents.agentOptions([
    { id: 'default', name: 'SleepyCode' },
    { id: 'apex', name: 'Apex (Builder)' },
    { id: 'phantom', name: 'Phantom (Debugger)' },
    { id: 'pivot', name: 'Pivot (Prototyper)' },
    { id: 'forge', name: 'Forge (Reviewer)' },
    { id: 'stack', name: 'Stack (Architect)' },
  ]);
  assert.deepEqual(options.map(o => o.id), ['default', 'apex', 'phantom', 'pivot', 'forge', 'stack']);
  // The long parenthesised form is the host's storage name, not the label.
  assert.equal(options[1].name, 'Apex');
  assert.equal(options[1].role, 'Build');
  assert.equal(options[0].role, 'Auto');
  for (const option of options) {
    assert.equal(option.builtIn, true, `${option.id} is built in`);
    assert.ok(option.description.length > 10, `${option.id} needs a description`);
  }
});

test('a custom agent keeps its own name and is marked as custom', () => {
  // Forcing a user agent into the built-in vocabulary would mean inventing a
  // role for it; "Custom" is what is true.
  const options = agents.agentOptions([
    { id: 'default', name: 'SleepyCode' },
    { id: 'my-agent', name: 'Docs Writer', description: 'Writes the docs.' },
  ]);
  assert.equal(options[1].id, 'my-agent');
  assert.equal(options[1].name, 'Docs Writer');
  assert.equal(options[1].role, 'Custom');
  assert.equal(options[1].description, 'Writes the docs.');
  assert.equal(options[1].builtIn, false);
});

test('a custom agent with no description still gets a usable row', () => {
  const options = agents.agentOptions([{ id: 'x', name: 'Bare' }]);
  assert.equal(options[0].description, '');
  assert.equal(options[0].name, 'Bare');
});

test('junk entries are dropped rather than rendered as blank rows', () => {
  // The list comes from global state, which a previous version or a hand edit
  // can have left malformed.
  const options = agents.agentOptions([
    null,
    undefined,
    {},
    { id: '', name: 'no id' },
    { id: 'ok', name: 'Fine' },
    { id: 'noname' },
  ]);
  assert.deepEqual(options.map(o => o.id), ['ok']);
});

test('order is the host order, so the picker matches the Agents panel', () => {
  const options = agents.agentOptions([
    { id: 'default', name: 'SleepyCode' },
    { id: 'aaa', name: 'Aaa' },
    { id: 'apex', name: 'Apex (Builder)' },
  ]);
  assert.deepEqual(options.map(o => o.id), ['default', 'aaa', 'apex']);
});

test('an unknown built-in id is treated as a custom agent', () => {
  // A future built-in added host-side must still render, not vanish.
  const options = agents.agentOptions([{ id: 'future', name: 'Future Agent' }]);
  assert.equal(options[0].name, 'Future Agent');
  assert.equal(options[0].role, 'Custom');
  assert.equal(options[0].builtIn, false);
});

test('the built-in metadata covers every id the host ships', () => {
  // A built-in that gains no metadata would silently render as a custom agent,
  // which is wrong but not obvious. `AGENT_DEFINITIONS` is the source.
  for (const id of ['default', 'apex', 'phantom', 'pivot', 'forge', 'stack']) {
    assert.ok(agents.BUILT_IN_AGENT_META[id], `${id} needs picker metadata`);
  }
  assert.equal(Object.keys(agents.BUILT_IN_AGENT_META).length, 6);
});