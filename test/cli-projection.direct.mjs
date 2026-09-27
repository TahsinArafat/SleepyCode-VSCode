// Direct tests for the CLI part projection. Dependency-free on purpose: this file
// imports only src/cli-projection.ts, which must never import vscode.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cliErrorText,
  projectMessage,
  projectParts,
  recoverableAssistant,
  toolWorkItem,
} from '../src/cli-projection.ts';

test('a user text part becomes a user item with its text intact', () => {
  const items = projectParts([{ id: 'prt_1', type: 'text', text: 'add a header' }], 'user');
  assert.equal(items.length, 1);
  assert.equal(items[0].role, 'user');
  assert.equal(items[0].text, 'add a header');
});

test('assistant text is the item text and reasoning becomes work', () => {
  const items = projectParts([
    { id: 'prt_1', type: 'reasoning', text: 'checking the plan' },
    { id: 'prt_2', type: 'text', text: 'Here is the header.' },
  ], 'assistant');
  // One assistant turn stays one item carrying both its text and its activity.
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Here is the header.');
  assert.equal(items[0].work?.[0].kind, 'reasoning');
  assert.equal(items[0].work?.[0].text, 'checking the plan');
});

test('tool parts become task rows on the assistant item, not a parallel list', () => {
  const items = projectParts([
    { id: 'prt_1', type: 'tool', tool: 'read_file', callID: 'c1', state: { status: 'running', input: { path: 'a.ts' } } },
  ], 'assistant');
  const work = items.flatMap(item => item.work ?? []);
  const task = work.find(w => w.kind === 'task');
  assert.ok(task, 'expected a task row');
  assert.equal(task?.tool, 'read_file');
  assert.equal(task?.done, false);
});

test('a running tool row is not done, a completed one is', () => {
  const running = toolWorkItem({ tool: 'read_file', state: { status: 'running' } });
  assert.equal(running.done, false);
  const done = toolWorkItem({ tool: 'read_file', state: { status: 'completed' } });
  assert.equal(done.done, true);
  const failed = toolWorkItem({ tool: 'read_file', state: { status: 'error', error: 'boom' } });
  assert.equal(failed.done, false);
  assert.equal(failed.interrupted, true);
});

test('a compaction part becomes a divider, never a synthetic message', () => {
  const items = projectParts([{ id: 'prt_1', type: 'compaction', summary: 'earlier turns' }], 'assistant');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'divider');
});

test('an assistant error part becomes a retryable error card', () => {
  // The wire shape is `{ name, data: { message } }`, NOT `{ message }`. An older
  // version of this test passed `{ message }`, which is why the real shape went
  // unnoticed and a failed turn rendered the bare name "UnknownError".
  const items = projectParts([{ id: 'prt_1', type: 'error', error: { name: 'UnknownError', data: { message: 'model refused' } } }], 'assistant');
  const error = items[0];
  assert.equal(error.kind, 'error');
  assert.equal(error.text, 'model refused');
  assert.equal(error.errorInfo?.retryable, true);
});

test('the captured ProviderModelNotFound payload shows the real reason', () => {
  // Recorded verbatim from a live `sleepy serve` on a first send.
  const captured = { name: 'UnknownError', data: { message: 'Model not found: sleepy/auto-best-coding.' } };
  assert.equal(cliErrorText(captured), 'Model not found: sleepy/auto-best-coding.');

  const items = projectParts([{ id: 'prt_1', type: 'error', error: captured }], 'assistant');
  assert.equal(items[0].text, 'Model not found: sleepy/auto-best-coding.');
  assert.notEqual(items[0].text, 'UnknownError', 'the bare name is not a reason');
});

test('cliErrorText prefers the message and only falls back to the name', () => {
  for (const name of ['UnknownError', 'ProviderAuthError', 'APIError', 'MessageAbortedError']) {
    assert.equal(cliErrorText({ name, data: { message: 'the real reason' } }), 'the real reason');
  }
  // Every variant the CLI declares carries data.message; name is a last resort.
  assert.equal(cliErrorText({ name: 'APIError', data: {} }), 'APIError');
  assert.equal(cliErrorText('plain string'), 'plain string');
  assert.equal(cliErrorText(undefined), undefined);
  assert.equal(cliErrorText(null), undefined);
  assert.equal(cliErrorText({}), undefined);
  assert.equal(cliErrorText('   '), undefined, 'whitespace is not a reason');
});

test('incomplete assistants stay recoverable so Continue is offered', () => {
  // No terminal stop means the CLI can still resume that turn.
  assert.equal(recoverableAssistant({ finish: 'tool-calls' }), true);
  assert.equal(recoverableAssistant({ finish: 'length' }), true);
  assert.equal(recoverableAssistant({ error: { message: 'boom' } }), true);
  assert.equal(recoverableAssistant({ finish: 'stop' }), false);
  // No terminal stop at all is still an unfinished turn, so it stays resumable.
  assert.equal(recoverableAssistant({}), true);
  // A user message is never something to resume.
  assert.equal(recoverableAssistant({ role: 'user', finish: 'stop' }), false);
});

test('an aborted tool part keeps its row and is marked interrupted', () => {
  const items = projectParts([
    { id: 'prt_1', type: 'tool', tool: 'run_command', callID: 'c1', state: { status: 'error', error: 'aborted' } },
  ], 'assistant');
  const task = items.flatMap(i => i.work ?? []).find(w => w.kind === 'task');
  assert.equal(task?.interrupted, true);
});

test('projectMessage keeps a single assistant turn as one item with its work', () => {
  const [item] = projectMessage({
    info: { id: 'msg_1', role: 'assistant', modelID: 'deepseek', providerID: 'sleepy' },
    parts: [
      { id: 'prt_1', type: 'reasoning', text: 'thinking' },
      { id: 'prt_2', type: 'tool', tool: 'list_files', callID: 'c1', state: { status: 'completed' } },
      { id: 'prt_3', type: 'text', text: 'done' },
    ],
  });
  assert.equal(item.role, 'assistant');
  assert.equal(item.text, 'done');
  assert.equal(item.model, 'sleepy/deepseek');
  assert.equal(item.work?.length, 2);
});
