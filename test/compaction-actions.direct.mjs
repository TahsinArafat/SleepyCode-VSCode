import test from 'node:test';
import assert from 'node:assert/strict';
import * as compaction from '../src/compaction-actions.ts';

/*
 * The React compaction marker is passive: it shows that earlier conversation was
 * summarized and can be expanded, but nothing can be done about it. The classic
 * webview had Cancel while summarizing, Undo to restore the full conversation,
 * Redo to re-apply it, and a manual /compact.
 *
 * These builders decide which of those are available, so a control is only shown
 * when it can act. Compaction cannot run while a turn is in flight (the host
 * refuses it), and undo/redo depend on whether a stack exists — which the host
 * reports, rather than the webview guessing from the transcript.
 */

test('a settled conversation offers a manual compact', () => {
  const actions = compaction.compactionActions({ conversationId: 'c1' });
  const compact = actions.find(a => a.id === 'compact');
  assert.equal(compact.enabled, true);
  assert.deepEqual(compaction.compactionMessages('compact', { conversationId: 'c1' }), [
    { type: 'compact', conversationId: 'c1' },
  ]);
});

test('compact is refused while a turn is running', () => {
  // The host refuses to compact an active conversation, so offering it would be
  // a button that silently does nothing.
  const context = { conversationId: 'c1', running: true };
  assert.equal(compaction.compactionActions(context).find(a => a.id === 'compact').enabled, false);
  assert.deepEqual(compaction.compactionMessages('compact', context), []);
});

test('cancel is only offered while compaction is actually running', () => {
  const running = { conversationId: 'c1', compacting: true };
  assert.equal(compaction.compactionActions(running).find(a => a.id === 'cancel').enabled, true);
  assert.deepEqual(compaction.compactionMessages('cancel', running), [
    { type: 'cancelCompact', conversationId: 'c1' },
  ]);
  // Not offered when nothing is compacting.
  assert.equal(compaction.compactionActions({ conversationId: 'c1' }).find(a => a.id === 'cancel').enabled, false);
  assert.deepEqual(compaction.compactionMessages('cancel', { conversationId: 'c1' }), []);
});

test('undo appears only when the host reports an undo stack', () => {
  // Guessing from the transcript would offer Undo when the stack is empty and
  // then do nothing.
  const withStack = { conversationId: 'c1', undoable: true };
  assert.equal(compaction.compactionActions(withStack).find(a => a.id === 'undo').enabled, true);
  assert.deepEqual(compaction.compactionMessages('undo', withStack), [
    { type: 'undoLastTurn', conversationId: 'c1' },
  ]);
  assert.equal(compaction.compactionActions({ conversationId: 'c1' }).find(a => a.id === 'undo').enabled, false);
  assert.deepEqual(compaction.compactionMessages('undo', { conversationId: 'c1' }), []);
});

test('redo appears only when the host reports a redo stack', () => {
  const withStack = { conversationId: 'c1', redoable: true };
  assert.equal(compaction.compactionActions(withStack).find(a => a.id === 'redo').enabled, true);
  assert.deepEqual(compaction.compactionMessages('redo', withStack), [
    { type: 'redoLastTurn', conversationId: 'c1' },
  ]);
  assert.equal(compaction.compactionActions({ conversationId: 'c1' }).find(a => a.id === 'redo').enabled, false);
});

test('undo and redo are refused while a turn is running', () => {
  // Both rewind the transcript; doing that under a live run would fight it.
  const context = { conversationId: 'c1', undoable: true, redoable: true, running: true };
  assert.deepEqual(compaction.compactionMessages('undo', context), []);
  assert.deepEqual(compaction.compactionMessages('redo', context), []);
});

test('nothing is offered without a conversation', () => {
  for (const action of ['compact', 'cancel', 'undo', 'redo']) {
    assert.deepEqual(compaction.compactionMessages(action, {}), [], `${action} with no conversation`);
    assert.deepEqual(compaction.compactionMessages(action, { conversationId: '' }), [], `${action} with an empty id`);
  }
  assert.deepEqual(compaction.compactionActions({}).filter(a => a.enabled), []);
});

test('an unknown action posts nothing', () => {
  assert.deepEqual(compaction.compactionMessages('explode', { conversationId: 'c1' }), []);
});

test('every action is offered in a fixed order, enabled or not', () => {
  // A stable list keeps the controls from jumping around as state changes.
  assert.deepEqual(
    compaction.compactionActions({ conversationId: 'c1' }).map(a => a.id),
    ['compact', 'cancel', 'undo', 'redo'],
  );
  for (const action of compaction.compactionActions({ conversationId: 'c1' })) {
    assert.ok(action.label, `${action.id} needs a label`);
    assert.ok(action.hint.length > 10, `${action.id} needs a hint`);
  }
});

test('the enabled flag and the message builders agree', () => {
  const contexts = [
    { conversationId: 'c1' },
    { conversationId: 'c1', running: true },
    { conversationId: 'c1', compacting: true },
    { conversationId: 'c1', undoable: true, redoable: true },
    {},
  ];
  for (const context of contexts) {
    for (const action of compaction.compactionActions(context)) {
      assert.equal(
        action.enabled,
        compaction.compactionMessages(action.id, context).length > 0,
        `${action.id} disagrees for ${JSON.stringify(context)}`,
      );
    }
  }
});