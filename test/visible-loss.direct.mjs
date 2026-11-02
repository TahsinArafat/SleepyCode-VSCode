import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertSource } from './source-assert.mjs';

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/webview/runtime.ts', import.meta.url), 'utf8');

test('a conversation is never shrunk by cutting messages out of the request', () => {
  // Cutting stored messages to fit a budget is the loss itself: the model repeats work
  // it already did, or edits a file it can no longer see, and the transcript on screen
  // stops matching what it was told. Compaction is the only reducer.
  assert.doesNotMatch(agent, /droppedMessageCount/);
  assert.doesNotMatch(agent, /left this request to stay within/);
  assert.match(agent, /await this\.compactForRun\(conversation, 'stored history exceeds the window'\)/);
});

test('a deliberate stop is not reported as a failure', () => {
  assert.match(agent, /code: 'interrupted'/);
  // Sidebar status must distinguish stopped from failed.
  assert.match(agent, /errorInfo\?\.code === 'interrupted' \? 'stopped' : 'failed'/);
  assertSource(runtime, /x\.status==='stopped'\?'Stopped'/);
});

test('an orphaned run failure leaves a persisted, retryable turn', () => {
  const start = agent.indexOf("'run.unhandled'");
  assert.ok(start > 0, 'run.unhandled not found');
  // Wide enough to include the abort that now runs before the persisted error
  // (a rejected run promise must stop the stream, not just drop its entry).
  const block = agent.slice(start - 600, start + 2400);
  // The user turn is persisted before the run, so an escaped failure left it unanswered.
  assert.match(block, /conversation\.items\.push\(errorItem\)/);
  assert.match(block, /persistProjects\(\)/);
  assert.match(block, /keepTurn: true/);
});

test('the orphaned error renders with a retry action', () => {
  // addError only draws a retry button when passed the flag; the error case passed none.
  assertSource(runtime, /case'error':[\s\S]{0,400}addError\(m\.text,!!m\.keepTurn\)/);
});

test('a stopped turn still offers retry so its partial work is recoverable', () => {
  assert.match(agent, /stoppedItem\.errorInfo = \{ code: 'interrupted', retryable: true/);
});

test('memory trimming keeps a whole turn so the kept answer still shows', () => {
  // The webview pairs a user item with the assistant item after it. A trim that lands mid-pair
  // leaves a headless answer that renderConversation never draws, so the turn reads as lost.
  const start = agent.indexOf('private boundConversationItems');
  const body = agent.slice(start, start + 900);
  assert.match(body, /role !== 'user'\) first\+\+/, 'the kept window must start on a user turn');
  assert.match(body, /conversation\.items = conversation\.items\.slice\(first\)/);
});
