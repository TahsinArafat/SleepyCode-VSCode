import test from 'node:test';
import assert from 'node:assert/strict';
import * as roles from '../src/subagent-roles.ts';

/*
 * A run delegates to three fixed roles, and the model per role is already stored
 * and already used. What never existed was a page to set it: the settings section
 * was called "Subagents & Teams" and edited a store that was not persisted and
 * that the host never read.
 */

test('an unset role inherits the conversation model, and the page says so', () => {
  const effective = roles.effectiveModel({}, 'explorer', 'gpt-x');
  assert.deepEqual(effective, { model: 'gpt-x', inherited: true });
  // Blank is inherit, not "the empty model".
  assert.equal(roles.effectiveModel({ explorer: '' }, 'explorer', 'gpt-x').inherited, true);
  const chosen = roles.effectiveModel({ explorer: 'cheap-model' }, 'explorer', 'gpt-x');
  assert.deepEqual(chosen, { model: 'cheap-model', inherited: false });
});

test('the stored map keeps known roles and drops the rest', () => {
  const parsed = roles.normalizeSubagentModels({ explorer: ' a ', reviewer: '', worker: 7, bogus: 'x' });
  assert.deepEqual(parsed, { explorer: 'a' });
  assert.deepEqual(roles.normalizeSubagentModels(null), {});
  assert.deepEqual(roles.normalizeSubagentModels(['a']), {});
});

test('a stored model that is no longer offered is reported, not silently broken', () => {
  // It would fail when the subagent starts, where the symptom is an empty result.
  assert.match(roles.roleModelProblem({ worker: 'gone' }, 'worker', ['a', 'b']) ?? '', /not in the current model list/);
  assert.equal(roles.roleModelProblem({ worker: 'a' }, 'worker', ['a', 'b']), null);
  // Nothing chosen is not a problem.
  assert.equal(roles.roleModelProblem({}, 'worker', ['a']), null);
  // A catalog that has not loaded yet must not flag every stored model.
  assert.equal(roles.roleModelProblem({ worker: 'a' }, 'worker', []), null);
});

test('only the worker may edit files, and the page says which roles write', () => {
  assert.equal(roles.ROLE_META.explorer.writes, false);
  assert.equal(roles.ROLE_META.reviewer.writes, false);
  assert.equal(roles.ROLE_META.worker.writes, true);
  // Every role the tool accepts is described.
  assert.deepEqual([...roles.SUBAGENT_ROLES], ['explorer', 'reviewer', 'worker']);
});

test('a role picker offers inherit first, then the catalog', () => {
  const options = roles.roleOptions(['m1', 'm2']);
  assert.equal(options[0].id, '');
  assert.match(options[0].label, /Same as the conversation/);
  assert.deepEqual(options.slice(1).map(option => option.id), ['m1', 'm2']);
});