import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTurnSnapshot,
  branchConversationState,
  clearForwardStacks,
  interruptedAssistantFields,
  interruptedFieldsFromPending,
  INTERRUPTED_TURN_TEXT,
  originalUserText,
  persistCompactionStacks,
  loadCompactionStacks,
  popLastTurn,
  recoverPendingHistory,
  restoreCompaction,
  resumeFromLastAssistant,
  sliceMessagesToItems,
  takeTurnRedo,
  workspaceGitRestoreFromSnapshot,
  workspaceRestoreFromSnapshot,
} from '../src/session-core.ts';

const user = (text, id = text) => ({ id, role: 'user', text });
const assistant = (text, extra = {}) => ({ id: text, role: 'assistant', text, ...extra });

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
  assert.equal(alreadyFolded, folded);
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

test('sliceMessagesToItems cuts structured history with the transcript', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1' }] },
    { role: 'tool', content: 'result' },
  ];
  const kept = [user('first'), assistant('one')];
  assert.deepEqual(sliceMessagesToItems(messages, kept), [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'one' },
  ]);
  assert.deepEqual(sliceMessagesToItems(messages, []), []);
  assert.equal(sliceMessagesToItems(undefined, kept), undefined);
});

test('popLastTurn and redo restore items and messages together', () => {
  const conversation = {
    items: [user('ask'), assistant('answer', { fileSnapshot: [{ path: 'a.ts', existed: true, content: 'old' }] })],
    messages: [
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: 'answer' },
    ],
    pending: { userText: 'ask', messages: [{ role: 'assistant', content: 'live' }], startedAt: 1 },
  };
  const popped = popLastTurn(conversation);
  assert.ok(popped);
  assert.equal(conversation.items.length, 0);
  assert.deepEqual(conversation.messages, []);
  assert.equal(conversation.pending, undefined);
  assert.equal(popped.snapshot.items.length, 2);
  applyTurnSnapshot(conversation, popped.snapshot);
  assert.equal(conversation.items.length, 2);
  assert.equal(conversation.messages?.length, 2);
  assert.equal(conversation.items[1]?.fileSnapshot?.[0]?.path, 'a.ts');
});

test('compaction undo/redo restore pre/post messages, not just items', () => {
  const conversation = {
    items: [assistant('summary'), user('', { kind: 'divider', id: 'div' })],
    messages: [{ role: 'user', content: 'Conversation summary' }],
  };
  const snapshot = {
    beforeItems: [user('ask'), assistant('long')],
    afterItems: conversation.items.slice(),
    beforeMessages: [{ role: 'user', content: 'ask' }, { role: 'assistant', content: 'long' }],
    afterMessages: [{ role: 'user', content: 'Conversation summary' }],
  };
  restoreCompaction(conversation, snapshot, 'before');
  assert.equal(conversation.items[0]?.text, 'ask');
  assert.equal(conversation.messages?.[0]?.content, 'ask');
  restoreCompaction(conversation, snapshot, 'after');
  assert.equal(conversation.messages?.[0]?.content, 'Conversation summary');
});

test('resumeFromLastAssistant reuses the original user text', () => {
  const items = [
    user('implement undo'),
    assistant('Stopped.', { kind: 'error', partialText: 'I started by', work: [{ kind: 'task', text: 'read' }] }),
  ];
  const resume = resumeFromLastAssistant(items);
  assert.equal(resume?.userText, 'implement undo');
  assert.equal(resume?.resume.partialText, 'I started by');
  assert.equal(originalUserText(items), 'implement undo');
  assert.notEqual(resume?.userText, 'Continue');
});

test('pending extras survive reload as one interrupted assistant', () => {
  const pending = {
    userText: 'fix the bug',
    messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1' }] }],
    startedAt: 1,
    partialText: 'I started by reading agent.ts',
    work: [{ kind: 'task', text: 'read agent.ts' }],
    changes: [{ path: 'src/agent.ts' }],
    fileSnapshot: [{ path: 'src/agent.ts', existed: true, content: 'old' }],
    gitTree: 'abc123',
  };
  const fields = interruptedFieldsFromPending(pending);
  assert.equal(fields.partialText, 'I started by reading agent.ts');
  assert.equal(fields.gitTree, 'abc123');
  assert.deepEqual(fields.work, pending.work);
  assert.deepEqual(fields.changes, pending.changes);
  assert.deepEqual(fields.fileSnapshot, pending.fileSnapshot);
});

test('undo snapshot restores before-files; redo snapshot restores after-files', () => {
  const snapshot = {
    items: [user('ask'), assistant('answer', { fileSnapshot: [{ path: 'a.ts', existed: true, content: 'before' }] })],
    messages: [
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: 'answer' },
    ],
    redoFiles: [{ path: 'a.ts', existed: true, content: 'after' }],
  };
  assert.equal(workspaceRestoreFromSnapshot(snapshot, 'undo')?.[0]?.content, 'before');
  assert.equal(workspaceRestoreFromSnapshot(snapshot, 'redo')?.[0]?.content, 'after');
});

test('branchConversationState copies sliced items and messages together', () => {
  const conversation = {
    items: [user('first'), assistant('one'), user('second'), assistant('two')],
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1' }] },
      { role: 'tool', content: 'result' },
    ],
  };
  const branched = branchConversationState(conversation, 1);
  assert.deepEqual(branched?.items.map(item => item.text), ['first', 'one']);
  assert.deepEqual(branched?.messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'one' },
  ]);
  assert.equal(conversation.messages?.length, 5);
  assert.equal(branchConversationState(conversation, -1), undefined);
});

test('git undo uses the pre-turn tree; redo uses the captured post-turn tree', () => {
  const snapshot = {
    items: [user('ask'), assistant('answer', { gitTree: 'before-tree', fileSnapshot: [{ path: 'a.ts', existed: true, content: 'before' }] })],
    messages: [
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: 'answer' },
    ],
    redoFiles: [{ path: 'a.ts', existed: true, content: 'after' }],
    redoGitTree: 'after-tree',
  };
  assert.equal(workspaceGitRestoreFromSnapshot(snapshot, 'undo'), 'before-tree');
  assert.equal(workspaceGitRestoreFromSnapshot(snapshot, 'redo'), 'after-tree');
});

test('a stopped turn stays retryable without duplicating the partial', () => {
  // The card carries the retryable sentence, so it is never a dead end.
  assert.equal(INTERRUPTED_TURN_TEXT, 'Response interrupted — retry continues from this point.');
  assert.notEqual(INTERRUPTED_TURN_TEXT, 'Stopped.');
  // The streamed partial stays in partialText only. The webview renders
  // partialText as a bubble and the error card from `text`, so putting the
  // partial in both fields would print it twice.
  const stopped = interruptedAssistantFields({
    userText: 'do it',
    reason: 'stop',
    message: INTERRUPTED_TURN_TEXT,
    partialText: 'I was reading agent.ts when you stopped',
  });
  assert.equal(stopped.kind, 'error');
  assert.equal(stopped.partialText, 'I was reading agent.ts when you stopped');
  assert.notEqual(stopped.partialText, INTERRUPTED_TURN_TEXT);
});

test('interrupted turns share one assistant shape', () => {
  const stopped = interruptedAssistantFields({
    userText: 'do it',
    reason: 'stop',
    message: 'Stopped.',
    partialText: 'halfway',
    work: [{ kind: 'task' }],
  });
  assert.equal(stopped.kind, 'error');
  assert.equal(stopped.partialText, 'halfway');

  const failed = interruptedAssistantFields({
    userText: 'do it',
    reason: 'error',
    message: 'Model failed',
    partialText: 'halfway',
  });
  assert.equal(failed.kind, 'error');

  const paused = interruptedAssistantFields({
    userText: 'do it',
    reason: 'max_steps',
    message: 'paused',
    pauseLimit: 50,
  });
  assert.equal(paused.paused, true);
  assert.equal(paused.pauseReason, 'max_steps');
  assert.equal(paused.pauseLimit, 50);
});

test('undo pushes redo; a later send clears the forward stack', () => {
  const conversation = {
    items: [user('ask'), assistant('answer')],
    messages: [
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: 'answer' },
    ],
    turnUndo: [],
    turnRedo: [],
  };
  const popped = popLastTurn(conversation);
  assert.ok(popped);
  conversation.turnUndo = [popped.snapshot];
  conversation.turnRedo = [];

  const redo = takeTurnRedo(conversation);
  assert.ok(redo);
  applyTurnSnapshot(conversation, redo);
  conversation.turnUndo = [];
  assert.equal(conversation.items.length, 2);
  assert.equal(conversation.turnRedo.length, 1);

  conversation.items.push(user('next'), assistant('later'));
  conversation.messages = [
    { role: 'user', content: 'ask' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'later' },
  ];
  clearForwardStacks(conversation);
  assert.deepEqual(conversation.turnUndo, []);
  assert.deepEqual(conversation.turnRedo, []);
});

test('compaction redo snapshots persist with the undo stack', () => {
  const snapshot = {
    beforeItems: [user('ask'), assistant('long')],
    afterItems: [assistant('summary'), user('', { kind: 'divider', id: 'div' })],
    beforeMessages: [{ role: 'user', content: 'ask' }, { role: 'assistant', content: 'long' }],
    afterMessages: [{ role: 'user', content: 'Conversation summary' }],
  };
  const persisted = persistCompactionStacks({
    undo: [snapshot],
    redo: [snapshot],
  });
  assert.equal(persisted.undo.length, 1);
  assert.equal(persisted.redo.length, 1);
  assert.equal(persisted.redo[0]?.beforeItems[0]?.text, 'ask');

  const loaded = loadCompactionStacks(persisted);
  assert.equal(loaded.undo.length, 1);
  assert.equal(loaded.redo.length, 1);
  assert.deepEqual(loadCompactionStacks([snapshot]), { undo: [snapshot], redo: [] });
  assert.deepEqual(loadCompactionStacks(undefined), { undo: [], redo: [] });
});
