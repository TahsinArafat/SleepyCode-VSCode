import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendConversationMessages,
  dropOrphanedToolCalls,
  iterationRequestMessages,
  nextTurnStart,
  pausedByStepLimit,
  recoverPendingHistory,
  safeHistoryStart,
  selectStructuredHistory,
} from '../src/iteration-core.ts';

test('max-step pause only triggers when a bounded tool loop stops on tool calls at the limit', () => {
  assert.equal(pausedByStepLimit(50, 50, 'tool-calls'), true);
  assert.equal(pausedByStepLimit(50, 49, 'tool-calls'), false);
  assert.equal(pausedByStepLimit(50, 50, 'stop'), false);
  assert.equal(pausedByStepLimit(0, 500, 'tool-calls'), false);
});

test('recoverPendingHistory folds a crash checkpoint onto existing history', () => {
  const pending = {
    userText: 'fix the bug',
    messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1' }] },
      { role: 'tool', content: 'file contents' },
    ],
  };
  const recovered = recoverPendingHistory(undefined, pending, 400);
  assert.deepEqual(recovered, [
    { role: 'user', content: 'fix the bug' },
    pending.messages[0],
    pending.messages[1],
  ]);

  const existing = [
    { role: 'user', content: 'older' },
    { role: 'assistant', content: 'old answer' },
  ];
  const folded = recoverPendingHistory(existing, pending, 400);
  assert.equal(folded?.[0]?.content, 'older');
  assert.equal(folded?.at(-1)?.content, 'file contents');
  assert.equal(folded?.some(message => message.content === 'fix the bug'), true);

  const alreadyFolded = recoverPendingHistory(folded, pending, 400);
  assert.deepEqual(alreadyFolded, folded);
  const reloaded = JSON.parse(JSON.stringify(folded));
  const reloadedPending = JSON.parse(JSON.stringify(pending));
  const afterReload = recoverPendingHistory(reloaded, reloadedPending, 400);
  assert.deepEqual(afterReload, reloaded);
  assert.equal(recoverPendingHistory(undefined, undefined, 400), undefined);
  assert.deepEqual(recoverPendingHistory([], { userText: 'x', messages: [] }, 400), []);
});

test('recoverPendingHistory trims from the front when the checkpoint exceeds the bound', () => {
  const pending = {
    userText: 'go',
    messages: Array.from({ length: 5 }, (_, index) => ({ role: 'assistant', content: String(index) })),
  };
  const recovered = recoverPendingHistory(undefined, pending, 3);
  assert.equal(recovered?.length, 3);
  assert.deepEqual(recovered?.map(message => message.content), ['2', '3', '4']);
});

test('recoverPendingHistory folds a mid-stream partial answer that never reached the step list', () => {
  // A crash during streaming leaves `messages` empty: the answer only exists as partialText.
  const pending = { userText: 'write the parser', messages: [], partialText: 'export function parse(source) {' };
  const recovered = recoverPendingHistory(undefined, pending, 400);
  assert.deepEqual(recovered, [
    { role: 'user', content: 'write the parser' },
    { role: 'assistant', content: 'export function parse(source) {' },
  ]);
  // Recovering twice must not duplicate it.
  assert.deepEqual(recoverPendingHistory(recovered, pending, 400), recovered);

  // When a finished step already stored the same text, it is not appended twice.
  const stored = { userText: 'go', messages: [{ role: 'assistant', content: 'done so far' }], partialText: 'done so far' };
  assert.deepEqual(recoverPendingHistory(undefined, stored, 400)?.map(message => message.content), ['go', 'done so far']);
});

test('selectStructuredHistory never starts on a tool result and cuts only at user turns', () => {
  const estimate = message => Math.ceil(String(message.content ?? '').length / 4);
  const stored = [
    { role: 'tool', content: 'orphan result' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second '.repeat(40) },
    { role: 'assistant', content: 'tooling', toolCalls: [{ id: 't1' }] },
    { role: 'tool', content: 'big result '.repeat(40) },
  ];
  const selected = selectStructuredHistory(stored, 20, estimate);
  assert.equal(selected[0]?.role, 'user');
  assert.equal(selected[0]?.content, stored[3]?.content);
  assert.ok(selected.some(message => message.role === 'tool'), 'tool results stay attached to their turn');
  assert.ok(selected.length >= 3, 'an oversized newest turn is kept instead of dropping all context');
  assert.equal(selectStructuredHistory([], 100, estimate).length, 0);
  assert.equal(selectStructuredHistory([{ role: 'assistant', content: 'no user' }], 100, estimate).length, 0);
});

test('safeHistoryStart and nextTurnStart only cut at user-owned boundaries', () => {
  const messages = [
    { role: 'assistant', content: 'lead' },
    { role: 'user', content: 'ask' },
    { role: 'assistant', content: 'call' },
    { role: 'tool', content: 'result' },
    { role: 'user', content: 'again' },
  ];
  assert.equal(safeHistoryStart(messages, 3), 1);
  assert.equal(safeHistoryStart(messages, 0), 0);
  assert.equal(nextTurnStart(messages, 2), 4);
  assert.equal(nextTurnStart(messages, 5), 5);
});

test('appendConversationMessages keeps the newest context under the hard bound', () => {
  const existing = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old-answer' },
  ];
  const produced = [
    { role: 'assistant', content: 'new-answer' },
  ];
  const next = appendConversationMessages(existing, 'new', produced, 3);
  assert.deepEqual(next, [
    { role: 'assistant', content: 'old-answer' },
    { role: 'user', content: 'new' },
    { role: 'assistant', content: 'new-answer' },
  ]);
});

test('appendConversationMessages does not insert a second user turn on resume', () => {
  const existing = [
    { role: 'user', content: 'implement undo' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1' }] },
    { role: 'tool', content: 'file contents' },
  ];
  const produced = [{ role: 'assistant', content: 'finished the remaining work' }];
  const next = appendConversationMessages(existing, 'implement undo', produced, 400, true);
  assert.deepEqual(next.map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(next.filter(message => message.role === 'user').length, 1);
  assert.equal(next.at(-1)?.content, 'finished the remaining work');
});

test('iterationRequestMessages keeps live tool context when a turn continues mid-iteration', () => {
  const prior = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }];
  const live = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'read1', name: 'read_file' }] },
    { role: 'tool', content: 'src/agent.ts contents that must not be dropped' },
  ];
  const prompt = 'Continue the original coding request from exactly where you stopped.';
  const messages = iterationRequestMessages(prior, live, prompt);
  assert.deepEqual(messages.slice(0, 2), prior);
  assert.deepEqual(messages.slice(2, 4), live);
  assert.deepEqual(messages[4], { role: 'user', content: prompt });

  const firstStep = iterationRequestMessages(prior, [], 'do the work');
  assert.deepEqual(firstStep, [...prior, { role: 'user', content: 'do the work' }]);

  const resumeWithOnlyLive = iterationRequestMessages([], live, prompt);
  assert.equal(resumeWithOnlyLive[0], live[0]);
  assert.equal(resumeWithOnlyLive.at(-1)?.content, prompt);
});

// ---------------------------------------------------------------- stopped turns

/*
 * Pressing stop between a tool call and its result writes an assistant message
 * with a tool-call and no result. Strict providers reject that shape outright, so
 * one stop used to make every later turn fail — and repeated stops left a
 * history that could not be sent at all.
 */

test('an unanswered tool call becomes a note instead of an invalid request', () => {
  const stored = [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: {} }] },
  ];
  const repaired = dropOrphanedToolCalls(stored);
  assert.equal(repaired.length, 2);
  const parts = repaired[1].content;
  assert.equal(parts[0].type, 'text');
  assert.match(parts[0].text, /read_file/);
  assert.match(parts[0].text, /did not finish/);
});

test('an answered tool call is left exactly as it was', () => {
  const stored = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: 'file' } }] },
  ];
  assert.deepEqual(dropOrphanedToolCalls(stored), stored);
});

test('only the unanswered call in a mixed step is rewritten', () => {
  const stored = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'done', toolName: 'read_file', input: {} },
      { type: 'tool-call', toolCallId: 'hung', toolName: 'run_command', input: {} },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'done', toolName: 'read_file', output: { type: 'text', value: 'ok' } }] },
  ];
  const parts = dropOrphanedToolCalls(stored)[1].content;
  assert.equal(parts[0].type, 'tool-call');
  assert.equal(parts[1].type, 'text');
  assert.match(parts[1].text, /run_command/);
});

test('the simpler toolCalls shape is repaired too', () => {
  const stored = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1' }] },
  ];
  const repaired = dropOrphanedToolCalls(stored);
  assert.deepEqual(repaired[1].toolCalls, []);
});

test('a repair that leaves nothing to say removes the empty step', () => {
  const stored = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [] },
    { role: 'assistant', content: 'real answer' },
  ];
  assert.deepEqual(dropOrphanedToolCalls(stored).map(message => message.content), ['go', 'real answer']);
});

test('a stopped turn persists a history the next request can send', () => {
  // End to end: append a turn that was cut off mid-tool, then select it.
  const stored = appendConversationMessages(
    [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'answer' }],
    'now do this',
    [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c9', toolName: 'write_file', input: {} }] }],
    400,
  );
  const selected = selectStructuredHistory(stored, 100_000, message => String(message.content ?? '').length);
  assert.ok(selected.length >= 2);
  const calls = selected.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool-call');
  assert.deepEqual(calls, [], 'no unanswered tool call may reach the provider');
});

test('a completion frame fills in args the start frame never had', async () => {
  // A streamed tool call whose arguments only finish parsing at the end (or a CLI
  // row that reports its input with the result) used to settle with an empty
  // input, so a finished write card showed no filename and a shell card `$ …`.
  const { applyEvent } = await import('../src/shared/turns.ts');
  let turns = applyEvent([], { type: 'run-status', status: 'running' });
  turns = applyEvent(turns, { type: 'tool-call-started', callId: 't1', name: 'Write', input: {} });
  turns = applyEvent(turns, {
    type: 'tool-call-completed', callId: 't1', name: 'Write', status: 'completed', result: 'Wrote a.ts',
    input: { path: 'src/a.ts', content: 'x' },
  });
  const block = turns[turns.length - 1].blocks.find(entry => entry.kind === 'tool');
  assert.equal(block.input.path, 'src/a.ts');
  assert.equal(block.status, 'completed');
});

test('an empty completion input does not erase what the start frame carried', async () => {
  const { applyEvent } = await import('../src/shared/turns.ts');
  let turns = applyEvent([], { type: 'run-status', status: 'running' });
  turns = applyEvent(turns, { type: 'tool-call-started', callId: 't2', name: 'Shell', input: { command: 'npm test' } });
  turns = applyEvent(turns, { type: 'tool-call-completed', callId: 't2', name: 'Shell', status: 'completed', result: 'ok' });
  const block = turns[turns.length - 1].blocks.find(entry => entry.kind === 'tool');
  assert.equal(block.input.command, 'npm test');
});
