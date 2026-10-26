import test from 'node:test';
import assert from 'node:assert/strict';

const goal = await import('../src/goal-core.ts');

// A conversation goal is an objective plus an optional token budget, shown in a
// banner and carried into the system prompt so the run pursues it.

test('a new goal starts active with nothing spent', () => {
  const created = goal.createGoal('Ship the migration', 50_000);
  assert.equal(created.objective, 'Ship the migration');
  assert.equal(created.status, 'active');
  assert.equal(created.tokenBudget, 50_000);
  assert.equal(created.tokensUsed, 0);
  assert.ok(created.updatedAt > 0);
});

test('a goal with no budget is unbounded, not zero', () => {
  const created = goal.createGoal('Explore', undefined);
  assert.equal(created.tokenBudget, undefined);
  // Zero would read as "cannot spend anything".
  assert.equal(goal.overBudget(created), false);
});

test('an empty objective is refused', () => {
  assert.equal(goal.createGoal('   ', 100), undefined);
  assert.equal(goal.createGoal('', 100), undefined);
});

test('tokens accumulate and trip the budget once', () => {
  let current = goal.createGoal('T', 100);
  current = goal.addTokens(current, 40);
  assert.equal(current.tokensUsed, 40);
  assert.equal(current.status, 'active');
  current = goal.addTokens(current, 70);
  assert.equal(current.tokensUsed, 110);
  // Reaching the budget limits it; it does not silently stay active.
  assert.equal(current.status, 'budgetLimited');
});

test('a finished or paused goal does not resume by spending tokens', () => {
  let current = goal.createGoal('T', 100);
  current = goal.withStatus(current, 'complete');
  const after = goal.addTokens(current, 500);
  assert.equal(after.status, 'complete', 'a completed goal must not flip to budgetLimited');
});

test('status changes are explicit, and an unknown status is refused', () => {
  const current = goal.createGoal('T');
  assert.equal(goal.withStatus(current, 'paused').status, 'paused');
  assert.equal(goal.withStatus(current, 'complete').status, 'complete');
  assert.equal(goal.withStatus(current, 'nonsense').status, 'active');
});

test('the objective goes into the prompt so the run pursues it', () => {
  const text = goal.goalGuidance(goal.createGoal('Ship the migration', 50_000));
  assert.match(text, /Ship the migration/);
  assert.match(text, /50,?000|budget/i);
  // No goal means no prompt noise.
  assert.equal(goal.goalGuidance(undefined), '');
});

test('a budget-limited goal tells the model to stop rather than keep spending', () => {
  assert.match(goal.goalGuidance({ ...goal.createGoal('T', 10), status: 'budgetLimited', tokensUsed: 10 }), /budget|limit/i);
});
