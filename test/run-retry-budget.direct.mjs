import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');

/** Body of the run loop, from the attempt loop to its catch, as source text. */
function retryLoopSource() {
  const start = agent.indexOf('while (true) {', agent.indexOf('const maxRunRetries'));
  const end = agent.indexOf('} catch (error) {', start);
  assert.ok(start > 0 && end > start, 'run loop not found');
  return agent.slice(start, end);
}

test('a retry attempt starts from an empty message accumulator', () => {
  // The loop restarts the stream from baseStreamPrompt each attempt. Carrying the
  // previous attempt's messages re-stacked the whole turn onto structuredHistory on
  // every retry until the request overflowed the context window.
  const loop = retryLoopSource();
  const resetAt = loop.indexOf('runMessages = [];');
  assert.ok(resetAt >= 0, 'runMessages must be reset per attempt');
  const streamAt = loop.indexOf('streamPrompt = baseStreamPrompt;');
  assert.ok(streamAt > resetAt, 'the reset belongs inside the loop, before the retry resumes');
});

test('the SDK does not retry behind the run loop’s classification gate', () => {
  // maxRetries on the agent compounded with MAX_RUN_RETRIES in the loop, so a payload
  // the loop would classify as non-retryable was still sent up to 20 times.
  const agentConfig = agent.slice(agent.indexOf('new ToolLoopAgent({'));
  const match = agentConfig.slice(0, 600).match(/maxRetries:\s*(\d+)/);
  assert.ok(match, 'ToolLoopAgent maxRetries not found');
  assert.ok(Number(match[1]) <= 2, `SDK retries (${match[1]}) must not multiply the run loop's attempts`);
});

test('retry policy is not declared twice', () => {
  const loop = retryLoopSource();
  assert.match(loop, /reportRetry|classifyAgentError|attemptInfo/, 'the run loop owns retry classification');
});
