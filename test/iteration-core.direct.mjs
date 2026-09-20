import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendConversationMessages,
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

test('recoverPendingHistory folds a crash checkpoint only when no stored history exists', () => {
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

  const existing = [{ role: 'user', content: 'older' }];
  assert.equal(recoverPendingHistory(existing, pending, 400), existing);
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
