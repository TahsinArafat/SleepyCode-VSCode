import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_PERSONAS,
  DEFAULT_PERSONA_ID,
  afterPersonaRemoved,
  allPersonas,
  normalizeCustomPersonas,
  personaById,
  personaFromDraft,
  personaPromptFor,
  validatePersonaDraft,
} from '../src/personas.ts';

/*
 * A persona is a layer of taste on top of everything else: how the agent should
 * write and what to care about, with no tools and no model of its own. It goes
 * into the system prompt of every run in that chat.
 *
 * The rules that matter are quiet ones. A persona whose prompt is empty changes
 * nothing while looking like it does; a custom persona that reuses a builtin id
 * silently replaces the builtin; and deleting the persona you were using must not
 * leave the chat pointing at nothing.
 */

test('there is a default persona, and it changes nothing', () => {
  const fallback = BUILTIN_PERSONAS.find((persona) => persona.id === DEFAULT_PERSONA_ID);
  assert.ok(fallback, 'the default persona must exist');
  assert.equal(fallback.prompt, '', 'the default persona must not add prompt text');
  assert.equal(personaPromptFor(BUILTIN_PERSONAS, DEFAULT_PERSONA_ID), '');
});

test('an unknown or missing persona falls back to the default instead of failing', () => {
  assert.equal(personaById(BUILTIN_PERSONAS, 'nope').id, DEFAULT_PERSONA_ID);
  assert.equal(personaById(BUILTIN_PERSONAS, undefined).id, DEFAULT_PERSONA_ID);
  assert.equal(personaPromptFor(BUILTIN_PERSONAS, 'nope'), '');
});

test('every builtin has a unique id, a name and something to say', () => {
  const ids = BUILTIN_PERSONAS.map((persona) => persona.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  for (const persona of BUILTIN_PERSONAS) {
    assert.match(persona.id, /^[a-z0-9][a-z0-9-]*$/, `id ${persona.id} must be a slug`);
    assert.ok(persona.name.trim().length > 0, `${persona.id} needs a name`);
    assert.ok(persona.description.trim().length > 0, `${persona.id} needs a description`);
    if (persona.id !== DEFAULT_PERSONA_ID) {
      assert.ok(persona.prompt.trim().length > 0, `${persona.id} must have a prompt, or it is a label that does nothing`);
      assert.ok(persona.builtin === true);
    }
  }
});

test('a persona prompt is the text the system prompt gets, trimmed', () => {
  const custom = [{ id: 'terse', name: 'Terse', description: 'Short answers', prompt: '  Answer in one paragraph.  ' }];
  assert.equal(personaPromptFor(allPersonas(custom), 'terse'), 'Answer in one paragraph.');
});

test('custom personas come after the builtins and cannot shadow one', () => {
  const custom = [
    { id: 'mine', name: 'Mine', description: 'x', prompt: 'y' },
    // A custom row claiming a builtin id would replace the shipped persona.
    { id: DEFAULT_PERSONA_ID, name: 'Hijack', description: 'x', prompt: 'y' },
  ];
  const ids = allPersonas(custom).map((persona) => persona.id);
  assert.ok(ids.includes('mine'));
  assert.equal(ids.filter((id) => id === DEFAULT_PERSONA_ID).length, 1);
  assert.equal(personaPromptFor(allPersonas(custom), DEFAULT_PERSONA_ID), '');
});

test('a corrupt stored list is dropped rather than rendered', () => {
  const stored = [
    null,
    'nope',
    { id: '', name: 'no id', prompt: 'x' },
    { id: 'ok', name: 'Fine', description: 'd', prompt: 'p' },
    { id: 'no-prompt', name: 'Empty', description: 'd', prompt: '   ' },
    { id: 'bad id!', name: 'Bad', description: 'd', prompt: 'p' },
  ];
  assert.deepEqual(normalizeCustomPersonas(stored).map((persona) => persona.id), ['ok']);
  assert.deepEqual(normalizeCustomPersonas(undefined), []);
  assert.deepEqual(normalizeCustomPersonas({}), []);
});

test('a new persona needs a usable id, a name and a prompt', () => {
  const empty = { id: '', name: '', prompt: '' };
  const base = { id: 'my-persona', name: 'My persona', prompt: 'Be brief.' };
  assert.equal(validatePersonaDraft(base, [], { isNew: true }), '');
  // An empty prompt is a persona that silently does nothing.
  assert.match(validatePersonaDraft({ ...base, prompt: '   ' }, [], { isNew: true }), /prompt/i);
  assert.match(validatePersonaDraft({ ...base, name: '' }, [], { isNew: true }), /name/i);
  assert.match(validatePersonaDraft({ ...base, id: 'Not A Slug' }, [], { isNew: true }), /id/i);
  assert.match(validatePersonaDraft({ ...base, id: 'a' }, [], { isNew: true }), /id/i);
  // The default persona is the "no persona" case; a custom one may not take it.
  assert.match(validatePersonaDraft({ ...base, id: DEFAULT_PERSONA_ID }, [], { isNew: true }), /reserved|id/i);
});

test('a new persona cannot reuse an existing custom id', () => {
  const existing = [{ id: 'mine', name: 'Mine', description: 'd', prompt: 'p' }];
  assert.match(validatePersonaDraft({ id: 'mine', name: 'Other', prompt: 'p' }, existing, { isNew: true }), /already/i);
  // Editing keeps its own id, so it must not collide with itself.
  assert.equal(validatePersonaDraft({ id: 'mine', name: 'Mine again', prompt: 'p' }, existing, { isNew: false }), '');
});

test('deleting the persona in use returns the chat to the default', () => {
  assert.equal(afterPersonaRemoved('mine', 'mine'), DEFAULT_PERSONA_ID);
  assert.equal(afterPersonaRemoved('other', 'mine'), 'other');
  assert.equal(afterPersonaRemoved('', 'mine'), DEFAULT_PERSONA_ID);
  assert.equal(afterPersonaRemoved(DEFAULT_PERSONA_ID, 'mine'), DEFAULT_PERSONA_ID);
});

test('a saved draft is a plain persona, never a builtin', () => {
  const saved = personaFromDraft({ id: 'mine', name: '  Mine  ', description: ' d ', prompt: ' p ' });
  assert.deepEqual(saved, { id: 'mine', name: 'Mine', description: 'd', prompt: 'p' });
  assert.equal('builtin' in saved, false);
});