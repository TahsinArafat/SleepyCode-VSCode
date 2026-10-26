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
