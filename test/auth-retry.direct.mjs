// A 401/403 mid-chat is retried with a rotated token before the turn is ever
// reported as a sign-out, and a transient 404 is retried for idempotent reads.
// These assertions pin the recovery path so it cannot silently regress into
// "you are logged out" after a single rejected request.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { authRetryBackoffMs, classifyAgentError, isAuthRejection, statusCodeOf } from '../src/util.ts';

const SLEEPY = { id: 'sleepyai', name: 'SleepyAI', baseURL: 'https://www.sleepyai.org/api/v1', isSleepy: true };
const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const sleepyai = readFileSync(new URL('../src/sleepyai.ts', import.meta.url), 'utf8');

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

test('auth backoff stays short enough to keep a turn alive without hammering', () => {
  assert.equal(authRetryBackoffMs(1), 750);
  assert.equal(authRetryBackoffMs(2), 1500);
  assert.equal(authRetryBackoffMs(9), 5000);
  for (let attempt = 1; attempt <= 10; attempt++) assert.ok(authRetryBackoffMs(attempt) <= 5000);
});

test('the request layer rotates the token and resends instead of giving up', () => {
  const fetchLayer = agent.slice(agent.indexOf('fetch: async (input, init) =>'), agent.indexOf('// Skills and project memory are loaded on demand'));
  assert.ok(fetchLayer.length > 0, 'fetch layer not found');
  assert.match(fetchLayer, /response\.status === 401 \|\| response\.status === 403/, '401/403 must be recognised as recoverable');
  assert.match(fetchLayer, /refreshSleepyToken\(\)/, 'the token must be rotated before the resend');
  assert.match(fetchLayer, /MAX_AUTH_RECOVERIES/, 'auth recovery needs its own budget');
  assert.ok(
    fetchLayer.indexOf('refreshSleepyToken()') < fetchLayer.indexOf('response.status === 404'),
    'auth recovery runs before the generic not-found/transient handling',
  );
});

test('a rejected token is replaced on the resent request', () => {
  // The headers closure captured the old Bearer token; after a rotation the same
  // Request would replay the rejected credential forever.
  assert.match(agent, /withAuthorization/);
  assert.match(agent, /authHeaders\.set\('Authorization', `Bearer \$\{bearer\}`\)/);
  assert.match(agent, /withAuthorization\(renewed\)/, 'a renewed token must be applied to the request');
});

test('transient 404s on idempotent reads retry without replaying a prompt', () => {
  const fetchLayer = agent.slice(agent.indexOf('fetch: async (input, init) =>'), agent.indexOf('// Skills and project memory are loaded on demand'));
  assert.match(fetchLayer, /response\.status === 404 && method === 'GET'/, 'only GETs may be replayed');
  assert.match(fetchLayer, /MAX_NOT_FOUND_RETRIES/);
  assert.doesNotMatch(fetchLayer, /status === 404[\s\S]{0,80}POST/, 'a POST must never be resent on 404');
});

test('a stream rejected mid-answer resumes instead of reporting a logout', () => {
  const catchAt = agent.indexOf('} catch (attemptError) {');
  const streamCatch = agent.slice(catchAt, agent.indexOf('} catch (error) {', catchAt));
  assert.ok(streamCatch.length > 0);
  assert.match(streamCatch, /isAuthRejection\(attemptError\)/, 'stream-level auth rejections must be recovered');
  assert.match(streamCatch, /refreshSleepyToken\(\)/);
  assert.match(streamCatch, /continue;/, 'the attempt must restart with the renewed token');
  const partial = streamCatch.slice(streamCatch.indexOf('carriedText'));
  assert.match(partial, /partialAnswer|answer/, 'the partial answer must be carried into the resumed prompt');
});

test('a refresh is only attempted when refresh credentials exist', () => {
  const fn = sleepyai.slice(sleepyai.indexOf('export async function refreshSleepyToken'));
  assert.match(fn.slice(0, 300), /refresh_token/, 'without a refresh token there is nothing to rotate');
  assert.match(sleepyai, /getSleepyToken\(options: \{ forceRefresh\?: boolean \} = \{\}\)/);
  assert.match(sleepyai, /force \|\| Date\.now\(\) >= expiresAt/, 'a forced refresh must ignore the stored expiry');
});
