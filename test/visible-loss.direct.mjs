import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { droppedMessageCount } from '../src/iteration-core.ts';

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/webview/runtime.ts', import.meta.url), 'utf8');

test('droppedMessageCount reports how much context a cut removed', () => {
  assert.equal(droppedMessageCount([{ role: 'user' }, { role: 'assistant' }], [{ role: 'assistant' }]), 1);
  assert.equal(droppedMessageCount([{ role: 'user' }], [{ role: 'user' }]), 0);
  assert.equal(droppedMessageCount(undefined, []), 0);
  assert.equal(droppedMessageCount([], []), 0);
});

test('a history cut is announced instead of silently narrowing the window', () => {
  // Silently trimming is what makes a long conversation read as the agent forgetting.
  assert.match(agent, /droppedMessageCount\(conversation\.messages, selected\)/);
  assert.match(agent, /type: 'contextNotice'[\s\S]{0,320}still saved in this conversation/);
});

test('a deliberate stop is not reported as a failure', () => {
  assert.match(agent, /code: 'interrupted'/);
  // Sidebar status must distinguish stopped from failed.
  assert.match(agent, /errorInfo\?\.code === 'interrupted' \? 'stopped' : 'failed'/);
  assert.match(runtime, /x\.status==='stopped'\?'Stopped'/);
});

test('an orphaned run failure leaves a persisted, retryable turn', () => {
  const start = agent.indexOf("'run.unhandled'");
  assert.ok(start > 0, 'run.unhandled not found');
  const block = agent.slice(start - 600, start + 1400);
  // The user turn is persisted before the run, so an escaped failure left it unanswered.
  assert.match(block, /conversation\.items\.push\(errorItem\)/);
  assert.match(block, /persistProjects\(\)/);
  assert.match(block, /keepTurn: true/);
});

test('the orphaned error renders with a retry action', () => {
  // addError only draws a retry button when passed the flag; the error case passed none.
  assert.match(runtime, /case'error':[\s\S]{0,400}addError\(m\.text,!!m\.keepTurn\)/);
});

test('a stopped turn still offers retry so its partial work is recoverable', () => {
  assert.match(agent, /stoppedItem\.errorInfo = \{ code: 'interrupted', retryable: true/);
});
