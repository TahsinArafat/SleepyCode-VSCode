import { test } from 'node:test';
import assert from 'node:assert/strict';

const turns = await import('../src/shared/turns.ts');

// The React webview assigns the reducer's return value straight back into its
// session state (`s.turns = applyEvent(s.turns, ev)`). A stub that returns null
// therefore nulls the transcript and the next render throws
// "Cannot read properties of null (reading 'length')". These tests pin the
// real reducer behaviour so that can never regress.

test('applyEvent never returns null or undefined', () => {
  const start = [{ role: 'user', text: 'hi' }];
  const events = [
    { type: 'run-status', status: 'running' },
    { type: 'text-delta', text: 'hello' },
    { type: 'thinking-delta', text: 'hmm' },
    { type: 'tool-call-started', callId: 't1', name: 'Read', input: {} },
    { type: 'tool-call-completed', callId: 't1', name: 'Read', status: 'completed', result: 'ok' },
    { type: 'run-result', text: 'done', durationMs: 5 },
    { type: 'run-status', status: 'finished' },
    { type: 'error', message: 'boom' },
  ];
  let current = start;
  for (const event of events) {
    current = turns.applyEvent(current, event);
    assert.ok(Array.isArray(current), `applyEvent(${event.type}) returned ${current}`);
  }
});

test('text-delta streams into an assistant text block', () => {
  let t = [{ role: 'user', text: 'hi' }];
  t = turns.applyEvent(t, { type: 'run-status', status: 'running' });
  t = turns.applyEvent(t, { type: 'text-delta', text: 'Hel' });
  t = turns.applyEvent(t, { type: 'text-delta', text: 'lo' });
  const assistant = t[t.length - 1];
  assert.equal(assistant.role, 'assistant');
  const text = assistant.blocks.filter(b => b.kind === 'text').map(b => b.text).join('');
  assert.equal(text, 'Hello');
});

test('thinking-delta streams into a thinking block', () => {
  let t = turns.applyEvent([{ role: 'user', text: 'hi' }], { type: 'run-status', status: 'running' });
  t = turns.applyEvent(t, { type: 'thinking-delta', text: 'because' });
  const blocks = t[t.length - 1].blocks;
  assert.equal(blocks[0].kind, 'thinking');
  assert.equal(blocks[0].text, 'because');
});

test('tool events produce a tool block with a status', () => {
  let t = turns.applyEvent([{ role: 'user', text: 'hi' }], { type: 'run-status', status: 'running' });
  t = turns.applyEvent(t, { type: 'tool-call-started', callId: 't1', name: 'Read', input: { path: 'a' } });
  let block = t[t.length - 1].blocks.find(b => b.kind === 'tool');
  assert.equal(block.callId, 't1');
  assert.equal(block.status, 'running');
  t = turns.applyEvent(t, { type: 'tool-call-completed', callId: 't1', name: 'Read', status: 'completed', result: 'content' });
  block = t[t.length - 1].blocks.find(b => b.kind === 'tool');
  assert.equal(block.status, 'completed');
  assert.equal(block.result, 'content');
});

test('run-result settles the assistant turn', () => {
  let t = turns.applyEvent([{ role: 'user', text: 'hi' }], { type: 'run-status', status: 'running' });
  t = turns.applyEvent(t, { type: 'text-delta', text: 'answer' });
  t = turns.applyEvent(t, { type: 'run-result', text: 'answer', durationMs: 42 });
  const assistant = t[t.length - 1];
  assert.equal(assistant.durationMs, 42);
  assert.ok(assistant.endedAt);
});

test('error event adds an error block', () => {
  let t = turns.applyEvent([{ role: 'user', text: 'hi' }], { type: 'run-status', status: 'running' });
  t = turns.applyEvent(t, { type: 'error', message: 'kaboom' });
  const blocks = t[t.length - 1].blocks;
  assert.equal(blocks[blocks.length - 1].kind, 'error');
  assert.equal(blocks[blocks.length - 1].message, 'kaboom');
});

test('restoreTurns keeps stored turns intact', () => {
  const stored = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', blocks: [{ kind: 'text', text: 'yo' }] },
  ];
  const restored = turns.applyEvent(stored, { type: 'run-status', status: 'finished' });
  assert.equal(restored.length, 2);
});

test('parseTodos extracts checklist state', async () => {
  const { parseTodos } = await import('../src/shared/todoPresentation.ts');
  // TodoWrite display format: [x] completed, [ ] pending, [~] in progress.
  const todos = parseTodos('[x] done thing\n[ ] pending thing\n[~] running thing');
  assert.equal(todos.length, 3);
  assert.equal(todos[0].status, 'completed');
  assert.equal(todos[1].status, 'pending');
  assert.equal(todos[2].status, 'in_progress');
});

// ---------------------------------------------------------------- route note
//
// `modelRoute` was mapped to `shell-notify`, which the reducer does not handle at
// all — so the "Auto → model · reason" explanation the classic webview showed
// only ever reached a transient status line that the next status overwrote. The
// reason a request ran on a different model was effectively invisible.

const applyAll = (events) => events.reduce((list, ev) => turns.applyEvent(list, ev), []);

test('a route note becomes a persistent block, not a status line', () => {
  const list = applyAll([
    { type: "route-note", model: "gpt-6-sol", requested: "auto", reason: "cheapest available" },
  ]);
  const blocks = list[0].blocks;
  const note = blocks.find(b => b.kind === "route");
  assert.ok(note, 'the route note should be a block');
  assert.equal(note.model, "gpt-6-sol");
  assert.match(note.text, /cheapest available/);
});

test('the same route is not repeated when it is announced twice', () => {
  // The host can re-announce; two identical lines would be noise.
  const once = applyAll([{ type: "route-note", model: "m", requested: "auto", reason: "r" }]);
  const twice = applyAll([
    { type: "route-note", model: "m", requested: "auto", reason: "r" },
    { type: "route-note", model: "m", requested: "auto", reason: "r" },
  ]);
  const count = (t) => t[0].blocks.filter(b => b.kind === "route").length;
  assert.equal(count(once), 1);
  assert.equal(count(twice), 1, 'a repeated announcement updates the note rather than adding another');
});

test('a note with no reason still says which model ran', () => {
  const list = applyAll([{ type: "route-note", model: "gpt-6-sol", requested: "auto" }]);
  const note = list[0].blocks.find(b => b.kind === "route");
  assert.match(note.text, /gpt-6-sol/);
  assert.doesNotMatch(note.text, /\(\)/, 'no empty parenthetical');
});

// ---------------------------------------------------------------- retry countdown
//
// The classic retry row counted down ("retry in 8s") because a silent wait reads
// as a hang. The retry event carries the delay; the block dropped it.

const applyAllRetry = (events) => events.reduce((list, ev) => turns.applyEvent(list, ev), []);

test('a retry block keeps the delay it will wait', () => {
  const list = applyAllRetry([{ type: 'retry', attempt: 2, max: 5, delayMs: 8000, error: 'connection reset' }]);
  const block = list[0].blocks.find(b => b.kind === 'error');
  assert.equal(block.retrying.attempt, 2);
  assert.equal(block.retrying.max, 5);
  assert.equal(block.retrying.delayMs, 8000, 'without the delay there is nothing to count down');
});

test('a retry with no stated delay still records the attempt', () => {
  // Some attempts are immediate; the countdown simply has nothing to show.
  const list = applyAllRetry([{ type: 'retry', attempt: 1, max: 3, error: 'boom' }]);
  const block = list[0].blocks.find(b => b.kind === 'error');
  assert.equal(block.retrying.attempt, 1);
  assert.equal(block.retrying.delayMs, undefined);
});

test('countdown text is derived from the delay, never fabricated', () => {
  // The number shown has to be the wait that was actually planned.
  assert.equal(turns.retryCountdown(8000, 0), 'retry in 8s');
  assert.equal(turns.retryCountdown(8000, 3000), 'retry in 5s');
  assert.equal(turns.retryCountdown(1000, 500), 'retry in 1s');
  // Past the deadline the card stops claiming a wait is coming.
  assert.equal(turns.retryCountdown(8000, 8000), 'retrying now');
  assert.equal(turns.retryCountdown(8000, 20000), 'retrying now');
  // No delay at all: nothing to count.
  assert.equal(turns.retryCountdown(undefined, 0), '');
});
