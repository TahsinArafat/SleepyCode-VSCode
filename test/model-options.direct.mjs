import test from 'node:test';
import assert from 'node:assert/strict';

const opts = await import('../src/model-options.ts');

// The model picker lets the user edit per-model options. SleepyCode had no such
// store, so saveModelOptions/resetModelOptions were dropped and the editor had
// nothing to read or write.

test('an override replaces the discovered context window', () => {
  const applied = opts.applyOverrides({ contextWindow: 128_000, maxOutputLimit: 8_000 }, { max_context: 200_000 });
  assert.equal(applied.contextWindow, 200_000);
  assert.equal(applied.maxOutputLimit, 8_000);
});

test('a chosen window applies even when the provider reported none', () => {
  const applied = opts.applyOverrides({}, { max_context: 200_000 });
  // Many compatible endpoints report no window at all, and a relay fronting several
  // vendors cannot describe them. The user's choice is the only correct number left,
  // and it is a decision rather than a guess, so it is used.
  assert.equal(applied.contextWindow, 200_000);
  // An output limit still cannot be invented: asking for more than the provider
  // advertises makes strict providers reject the request.
  assert.equal(opts.applyOverrides({}, { max_output: 8_000 }).maxOutputLimit, undefined);
});

test('a zero or negative override is ignored', () => {
  const applied = opts.applyOverrides({ contextWindow: 128_000 }, { max_context: 0 });
  assert.equal(applied.contextWindow, 128_000);
});

test('junk overrides are ignored rather than applied', () => {
  const stored = opts.normalizeOverrides({ a: { max_context: 'lots' }, b: { max_context: 32_000 }, c: 'nope' });
  assert.deepEqual(Object.keys(stored), ['b']);
  assert.equal(stored.b.max_context, 32_000);
});

test('stored overrides survive a round trip', () => {
  const stored = opts.normalizeOverrides({ m1: { max_context: 64_000, max_output: 4_000 } });
  assert.deepEqual(stored.m1, { max_context: 64_000, max_output: 4_000 });
  assert.deepEqual(opts.normalizeOverrides(undefined), {});
});

test('the picker is offered the options a model actually has', () => {
  const list = opts.optionsFor({ contextWindow: 128_000, maxOutputLimit: 8_000 }, {});
  const keys = list.map((o) => o.key);
  assert.deepEqual(keys, ['max_context', 'max_output']);
  assert.equal(list[0].value, '128000');
  assert.equal(list[1].value, '8000');
});

test('an overridden value shows as the current selection', () => {
  const list = opts.optionsFor({ contextWindow: 128_000 }, { max_context: 200_000 });
  assert.equal(list[0].value, '200000');
});

test('a model with no known window still offers the control that sets one', () => {
  const list = opts.optionsFor({}, {});
  assert.deepEqual(list.map(o => o.key), ['max_context']);
  // No current value, but every choice is there to pick from.
  assert.equal(list[0].value, '');
  assert.ok(list[0].values.includes('128000'));
  // Nothing to raise for an output limit nobody advertised, so no row either.
  assert.ok(!list.some(o => o.key === 'max_output'));
});

test('resetting removes only that model', () => {
  const before = opts.normalizeOverrides({ m1: { max_context: 1 }, m2: { max_context: 2 } });
  const after = opts.resetModel(before, 'm1');
  assert.deepEqual(Object.keys(after), ['m2']);
});

test('a worktree name is derived from a conversation title safely', async () => {
  const worktree = await import('../src/worktree-naming.ts');
  assert.match(worktree.worktreeNameFor('Add auth: worktree "test"?'), /^[a-z0-9-]+$/);
  assert.ok(!worktree.worktreeNameFor('///').includes('/'));
  assert.ok(worktree.worktreeNameFor('').length > 0);
  assert.ok(worktree.worktreeNameFor('a'.repeat(200)).length <= 60);
});
