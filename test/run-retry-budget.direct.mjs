import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_RUN_RETRIES, createRetryBudget, retryBackoffMs, retryKindForStatus, retryMessage } from '../src/retry-core.ts';

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');

/** Body of the run loop, from the attempt loop to its catch, as source text. */
function retryLoopSource() {
  const start = agent.indexOf('const baseStreamPrompt = streamPrompt;');
  const end = agent.indexOf('} catch (error) {', start);
  assert.ok(start > 0 && end > start, 'run loop not found');
  return agent.slice(start, end);
}

function fetchLayerSource() {
  const start = agent.indexOf('fetch: async (input, init) =>');
  assert.ok(start > 0, 'request layer not found');
  return agent.slice(start, start + 5_000);
}

test('a retry attempt starts from an empty message accumulator', () => {
  // The loop restarts the stream from baseStreamPrompt each attempt. Carrying the
  // previous attempt's messages re-stacked the whole turn onto structured history on
  // every retry until the request overflowed the context window.
  const loop = retryLoopSource();
  const resetAt = loop.indexOf('runMessages = [];');
  assert.ok(resetAt >= 0, 'runMessages must be reset per attempt');
  const resumeAt = loop.indexOf('retryBudget.take(');
  assert.ok(resumeAt > resetAt, 'the reset must happen inside the loop, before the retry resumes');
});

test('the SDK does not retry behind the run loop’s classification gate', () => {
  // maxRetries on the agent compounded with MAX_RUN_RETRIES in the loop, so a payload
  // the loop would classify as non-retryable was still sent up to 2x times.
  const agentConfig = agent.slice(agent.indexOf('new ToolLoopAgent({'));
  const match = agentConfig.slice(0, 600).match(/maxRetries:\s*(\d+)/);
  assert.ok(match, 'ToolLoopAgent maxRetries not found');
  assert.ok(Number(match[1]) <= 2, `SDK retries (${match[1]}) must not multiply the run loop's attempts`);
});

test('one retry budget is created per turn and both layers draw from it', () => {
  const created = agent.match(/createRetryBudget\(\)/g) ?? [];
  assert.equal(created.length, 1, 'exactly one budget is created per turn, not one per layer or per kind');
  const loop = retryLoopSource();
  const layer = fetchLayerSource();
  for (const [name, source] of [['run loop', loop], ['request layer', layer]]) {
    assert.match(source, /retryBudget\.take\(/, `${name} must spend from the shared budget`);
    assert.match(source, /decision\.attempt/, `${name} must report the shared attempt number`);
    assert.match(source, /decision\.max/, `${name} must report the shared maximum`);
  }
  assert.match(loop, /retryBudget\.spent/, 'the run loop must close the shared retry row');
});

test('retry policy is not declared twice', () => {
  const loop = retryLoopSource();
  assert.match(loop, /classifyAgentError|retryKindForStatus/, 'the run loop owns retry classification');
  for (const gone of ['MAX_AUTH_RECOVERIES', 'MAX_NOT_FOUND_RETRIES', 'maxRunRetries', 'authRecoveries']) {
    assert.ok(!agent.includes(gone), `${gone} must be gone: the policy lives in retry-core`);
  }
});

test('a 403 is recovered, a 404 waits, and everything else is left alone', () => {
  const first = { replayable: true, isFirstParty: true };
  assert.equal(retryKindForStatus(403, first), 'auth');
  assert.equal(retryKindForStatus(401, first), 'auth');
  assert.equal(retryKindForStatus(404, first), 'not_ready');
  for (const status of [408, 409, 429, 500, 503]) assert.equal(retryKindForStatus(status, first), 'transient');
  // A prompt or tool call must never be replayed on a 404.
  assert.equal(retryKindForStatus(404, { replayable: false, isFirstParty: true }), undefined);
  // Only first-party credentials are rotated; a third-party 401 is the user's key.
  assert.equal(retryKindForStatus(403, { replayable: true, isFirstParty: false }), undefined);
  assert.equal(retryKindForStatus(403, { replayable: true, isFirstParty: true }), 'auth');
  for (const status of [400, 402, 422, 200, 201]) assert.equal(retryKindForStatus(status, first), undefined);
});

test('the budget is spent once per retry and then refuses', () => {
  const budget = createRetryBudget(3);
  assert.equal(budget.spent, 0);
  assert.equal(budget.max, 3);
  const kinds = ['auth', 'not_ready', 'transient', 'auth'];
  const taken = kinds.map(kind => budget.take(kind, 'x'));
  assert.deepEqual(taken.map(d => d?.attempt), [1, 2, 3, undefined]);
  assert.deepEqual(taken.map(d => d?.kind), ['auth', 'not_ready', 'transient', undefined]);
  assert.equal(budget.spent, 3);
  assert.equal(createRetryBudget().max, MAX_RUN_RETRIES);
});

test('backoff grows and stays capped', () => {
  assert.equal(retryBackoffMs(1), 500);
  assert.ok(retryBackoffMs(2) > retryBackoffMs(1));
  for (let attempt = 1; attempt <= 20; attempt++) assert.ok(retryBackoffMs(attempt) <= 15_000);
});

test('every retry says what failed and what happens next', () => {
  assert.match(retryMessage({ kind: 'auth', status: 403, recovered: true }), /HTTP 403: SleepyAI session refreshed/);
  assert.match(retryMessage({ kind: 'auth', status: 401, recovered: false }), /refresh unavailable/);
  assert.match(retryMessage({ kind: 'not_ready', status: 404 }), /not ready yet/);
  assert.match(retryMessage({ kind: 'transient', status: 503, detail: 'Service Unavailable' }), /HTTP 503: Service Unavailable/);
  assert.ok(retryMessage({ kind: 'transient', detail: 'socket hang up' }).length > 0);
});