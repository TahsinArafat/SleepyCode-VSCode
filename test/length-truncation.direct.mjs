import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resumeFromLastAssistant } from '../src/session-core.ts';

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/webview/runtime.ts', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

test('a response cut off by the output limit is not committed as a clean success', () => {
  // The run loop only threw for 'error' and 'content-filter'. 'length' committed the
  // truncated answer as an ordinary success item with no interrupted marker, which is
  // the "it just stopped midway and looks fine" symptom.
  assert.match(agent, /const truncated = finishReason === 'length';/);
  assert.match(agent, /else if \(truncated\) \{\s*assistantItem\.paused = true;\s*assistantItem\.pauseReason = 'max_tokens';/);
});

test('the truncated answer is preserved so Continue resumes from it', () => {
  assert.match(agent, /if \(truncated && !paused\) assistantItem\.partialText = finalAnswer;/);
});

test('the pause reason distinguishes the step limit from the output limit', () => {
  assert.match(types, /pauseReason\?: 'max_steps' \| 'max_tokens';/);
  // Resume must not tell the model it "reached the N-step limit" for a token cut-off.
  assert.match(agent, /truncatedPause\s*\?\s*'The previous response reached the model output limit/);
});

test('resume derives a max_tokens reason and does not build an error card', () => {
  const items = [
    { role: 'user', text: 'Write the report', messages: [{ role: 'user', content: 'Write the report' }] },
    { role: 'assistant', text: 'Here is the first half of', paused: true, pauseReason: 'max_tokens' },
  ];
  const found = resumeFromLastAssistant(items);
  assert.ok(found, 'a paused truncated turn is resumable');
  assert.equal(found.resume.reason, 'max_tokens');
  assert.equal(found.resume.kind, undefined, 'a truncated turn is not an error card');
});

test('the pause card explains a truncation instead of a step limit', () => {
  assert.match(runtime, /item\.pauseReason==='max_tokens'/);
  assert.match(runtime, /Response truncated/);
});
