// A mid-chat 401/403 is recovered by rotating the token and resending, and a
// transient 404 on a read waits for the edge to settle — both before anything is
// reported. Every one of those retries is spent from the single per-turn budget.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MAX_RUN_RETRIES, retryBackoffMs } from '../src/retry-core.ts';
import { classifyAgentError, isAuthRejection, statusCodeOf } from '../src/util.ts';

const SLEEPY = { id: 'sleepyai', name: 'SleepyAI', baseURL: 'https://www.sleepyai.org/api/v1', isSleepy: true };
const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const sleepyai = readFileSync(new URL('../src/sleepyai.ts', import.meta.url), 'utf8');

function fetchLayer() {
  const start = agent.indexOf('fetch: async (input, init) =>');
  assert.ok(start > 0, 'request layer not found');
  return agent.slice(start, start + 5_000);
}

function streamCatch() {
  const start = agent.indexOf('} catch (attemptError) {');
  assert.ok(start > 0, 'attempt catch not found');
  return agent.slice(start, agent.indexOf('} catch (error) {', start));
}

test('a 403 on the first-party provider is retryable, not a forced sign-in', () => {
  for (const status of [401, 403]) {
    const info = classifyAgentError(Object.assign(new Error(`HTTP ${status}`), { statusCode: status }), SLEEPY);
    assert.equal(info.code, 'auth_required');
    assert.equal(info.retryable, true, `${status} must be retried before prompting sign-in`);
    assert.equal(info.primaryAction, 'retry');
    assert.equal(info.secondaryAction, 'signin');
    assert.doesNotMatch(info.title, /expired|logged out/i);
  }
});

test('a third-party 401/403 still points at provider settings', () => {
  const info = classifyAgentError(Object.assign(new Error('Unauthorized'), { status: 401 }), { id: 'custom', name: 'Custom', baseURL: 'https://example.test' });
  assert.equal(info.code, 'auth_required');
  assert.equal(info.primaryAction, 'settings');
  assert.equal(info.retryable, false);
});

test('auth rejections are detected from nested provider error shapes', () => {
  assert.equal(isAuthRejection({ statusCode: 403 }), true);
  assert.equal(isAuthRejection({ response: { status: 401 } }), true);
  assert.equal(isAuthRejection({ cause: { statusCode: 403 } }), true);
  assert.equal(isAuthRejection(new Error('401 Unauthorized')), false, 'only a structured status counts');
  assert.equal(statusCodeOf({ status: 404 }), 404);
});

test('backoff stays short enough to keep a turn alive without hammering', () => {
  assert.equal(retryBackoffMs(1), 500);
  for (let attempt = 1; attempt <= MAX_RUN_RETRIES; attempt++) assert.ok(retryBackoffMs(attempt) <= 15_000);
});

test('the request layer asks the shared policy what to do, then rotates and resends', () => {
  const layer = fetchLayer();
  assert.match(layer, /retryKindForStatus\(response\.status, \{ replayable, isFirstParty: providerConfig\.isSleepy \}\)/);
  assert.match(layer, /retryBudget\.take\(kind,/, 'the request layer spends from the turn budget');
  assert.match(layer, /refreshSleepyToken\(\)/, 'the token must be rotated before the resend');
  assert.ok(
    layer.indexOf('retryKindForStatus(') < layer.indexOf('retryBudget.take('),
    'the status must be classified before budget is spent',
  );
  assert.ok(layer.indexOf('refreshSleepyToken()') < layer.indexOf('withAuthorization(renewed)'), 'rotate, then apply');
  assert.match(layer, /authHeaders\.set\('Authorization', `Bearer \$\{bearer\}`\)/, 'the resent request needs the new token');
  assert.match(layer, /if \(!decision\) return response;/, 'a spent budget surfaces the response untouched');
});

test('a spent budget ends the turn instead of inventing another attempt', () => {
  const layer = fetchLayer();
  assert.match(layer, /if \(!decision\) throw error;/, 'a transport failure with no budget left is surfaced');
});

test('a 404 waits for the edge, but only on a request that can be replayed', () => {
  const layer = fetchLayer();
  assert.match(layer, /const replayable = method === 'GET' \|\| method === 'HEAD';/);
  assert.match(layer, /retryKindForStatus\(/, 'the 404 rule lives in the shared policy, not here');
  // A duplicate local policy is exactly what unified: no status is judged twice.
  assert.ok(!/response\.status === (401|403|404|408|409|429)/.test(layer), 'status classification must not be re-implemented');
});

test('a stream rejected mid-answer resumes instead of reporting a logout', () => {
  const block = streamCatch();
  assert.match(block, /isAuthRejection\(attemptError\)/, 'stream-level auth rejections must be recovered');
  assert.match(block, /retryBudget\.take\(kind,/, 'the run loop spends from the same budget');
  assert.match(block, /refreshSleepyToken\(\)/);
  assert.match(block, /carriedText/, 'the partial answer must be carried into the resumed prompt');
  assert.match(block.slice(block.indexOf('carriedText')), /answer\.trim\(\) \|\| partialAnswer\.trim\(\)/);
});

test('a refresh is only attempted when refresh credentials exist', () => {
  const fn = sleepyai.slice(sleepyai.indexOf('export async function refreshSleepyToken'));
  assert.match(fn.slice(0, 300), /refresh_token/, 'without a refresh token there is nothing to rotate');
  assert.match(sleepyai, /getSleepyToken\(options: \{ forceRefresh\?: boolean \} = \{\}\)/);
  assert.match(sleepyai, /force \|\| Date\.now\(\) >= expiresAt/, 'a forced refresh must ignore the stored expiry');
});

test('HTTP 404 from server maintenance is retryable and does not claim model unavailable', () => {
  const maintenanceError = Object.assign(new Error('Cannot POST /api/v1/chat/completions (503 Service Unavailable / 404 Not Found)'), { status: 404 });
  const info = classifyAgentError(maintenanceError, SLEEPY);
  assert.equal(info.code, 'service_unavailable');
  assert.equal(info.retryable, true);
  assert.equal(info.primaryAction, 'retry');
  assert.match(info.title, /404/);
  assert.doesNotMatch(info.title, /Selected model is unavailable/);

  // A genuine model-not-found message is classified as model_unavailable
  const modelNotFoundError = Object.assign(new Error('The model `claude-opus` does not exist or is not found'), { status: 404 });
  const modelInfo = classifyAgentError(modelNotFoundError, SLEEPY);
  assert.equal(modelInfo.code, 'model_unavailable');
  assert.equal(modelInfo.retryable, false);
  assert.equal(modelInfo.primaryAction, 'models');
});

test('continuation messages resume from partial output and preserve context', () => {
  assert.match(agent, /isContinuation = \/\^\(\?:continue\|keep going\|go on\|please continue\|continue from where you stopped\|proceed\|finish\)\\\.\?\$\/i/);
  // Both catch branches fold the streamed answer into history, including the deliberate stop.
  assert.match(agent, /function appendPartialAnswer\(/);
  // Anchored on the catch branch, which also guards against the abort that now
  // precedes the commit path (so this cannot latch onto that earlier check).
  const catchStart = agent.indexOf('} catch (error) {\n      if (run.controller.signal.aborted) {');
  assert.ok(catchStart > 0, 'the run catch branch is present');
  assert.match(agent.slice(catchStart, catchStart + 600), /appendPartialAnswer\(runMessages, partialAnswer \|\| resume\?\.partialText\)/);
  assert.match(agent, /appendPartialAnswer\(runMessages, fields\.partialText \|\| partialAnswer \|\| resume\?\.partialText\)/);
  assert.match(agent, /const historyUserText = resume \? \(resume\.originalUserText \|\| userText\) : userText;/);
});