import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as agents from '../src/agent-options.ts';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

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

test('the built-in agent gets its short name and role from the picker metadata', () => {
  // `default` is the only built-in agent left: the other five were tone prompts
  // with no model and no tool policy, so they are personas now.
  const options = agents.agentOptions([{ id: 'default', name: 'SleepyCode' }]);
  assert.deepEqual(options.map(o => o.id), ['default']);
  assert.equal(options[0].role, 'Auto');
  assert.equal(options[0].builtIn, true);
  assert.ok(options[0].description.length > 10);
});

test('an id that used to be an agent is a persona, not a built-in agent', () => {
  // A host that still sent one must not have it dressed up as an agent again.
  for (const id of agents.LEGACY_AGENT_PERSONA_IDS) {
    assert.equal(agents.isLegacyPersonaAgent(id), true, `${id} moved to personas`);
    const [option] = agents.agentOptions([{ id, name: id }]);
    assert.equal(option.builtIn, false, `${id} is not a built-in agent any more`);
  }
  assert.equal(agents.isLegacyPersonaAgent('default'), false);
  assert.equal(agents.isLegacyPersonaAgent(undefined), false);
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
  // which is wrong but not obvious. `AGENT_DEFINITIONS` is the source, and it now
  // ships exactly one: the five tone prompts moved to `src/personas.ts`.
  const definitions = read('src/agent.ts').match(/export const AGENT_DEFINITIONS[\s\S]*?\n\];/)?.[0] ?? '';
  const ids = [...definitions.matchAll(/\{\s*id: '([a-z0-9-]+)'/gi)].map(match => match[1]);
  assert.deepEqual(ids, ['default']);
  for (const id of ids) assert.ok(agents.BUILT_IN_AGENT_META[id], `${id} needs picker metadata`);
  assert.deepEqual(Object.keys(agents.BUILT_IN_AGENT_META), ['default']);
});