import test from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../src/review-actions.ts';

/*
 * The classic changes card offered Stage all, Commit, Source Control and Restore
 * checkpoint. The React review bar offers only Keep All / Undo All plus per-file
 * Keep and Undo, so a response could be staged but never committed and never
 * rolled back to its checkpoint from the chat.
 *
 * These builders exist so each button posts a message the host already handles,
 * and so a button whose target is missing is disabled rather than dead. The host
 * resolves an edit through a conversation and the turn that made it, which is why
 * both ids are required for everything here.
 */

const ctx = { conversationId: 'c1', itemId: 'i1', paths: ['a.ts', 'b.ts'], running: false };

test('the card offers the four actions the classic one had', () => {
  const actions = review.changeActions(ctx);
  assert.deepEqual(actions.map(a => a.id), ['stageAll', 'commit', 'sourceControl', 'restore']);
  for (const action of actions) {
    assert.ok(action.label, `${action.id} needs a label`);
    assert.ok(action.hint.length > 10, `${action.id} needs a hint`);
    assert.equal(action.enabled, true, `${action.id} should be enabled with a full context`);
  }
});

test('stage all posts the paths, without naming the turn', () => {
  // React-level intent: the host resolves the turn, so the button works whether or
  // not the webview knows the id.
  assert.deepEqual(review.changeActionMessages('stageAll', ctx), [
    { type: 'stageAllChanges', conversationId: 'c1', paths: ['a.ts', 'b.ts'] },
  ]);
});

test('commit and source control post intents the adapter can translate', () => {
  // Posting host names (`gitCommit`, `reviewChanges`) from the webview was silently
  // dropped — `toSleepyMessage` has no case for them — so both buttons did nothing.
  assert.deepEqual(review.changeActionMessages('commit', ctx), [{ type: 'commitChanges', conversationId: 'c1' }]);
  assert.deepEqual(review.changeActionMessages('sourceControl', ctx), [{ type: 'openSourceControl', conversationId: 'c1' }]);
  assert.deepEqual(review.changeActionMessages('restore', ctx), [{ type: 'restoreCheckpoint', conversationId: 'c1' }]);
});

test('the turn id is optional, because the host tracks it', () => {
  // Requiring it left every one of these permanently disabled: turns carry no id
  // in the webview.
  for (const action of ['stageAll', 'commit', 'sourceControl', 'restore']) {
    assert.equal(review.changeActionMessages(action, { ...ctx, itemId: undefined }).length, 1, `${action} without a turn id`);
  }
});

test('nothing fires with no conversation and no changes at all', () => {
  for (const action of ['stageAll', 'commit', 'sourceControl', 'restore']) {
    assert.deepEqual(review.changeActionMessages(action, {}), [], `${action} with nothing`);
  }
});

test('stage all needs at least one path', () => {
  // An empty list would post a stage request that stages nothing.
  assert.deepEqual(review.changeActionMessages('stageAll', { ...ctx, paths: [] }), []);
  assert.deepEqual(review.changeActionMessages('stageAll', { ...ctx, paths: undefined }), []);
  // The others do not depend on the list, because the host resolves the files.
  assert.equal(review.changeActionMessages('commit', { ...ctx, paths: [] }).length, 1);
});

test('actions that mutate files are disabled while a run is in flight', () => {
  // The host refuses these mid-run; a disabled button beats a silent no-op.
  const running = { ...ctx, running: true };
  for (const action of ['stageAll', 'commit', 'restore']) {
    assert.equal(review.changeActions(running).find(a => a.id === action).enabled, false, `${action} while running`);
    assert.deepEqual(review.changeActionMessages(action, running), [], `${action} while running`);
  }
  // Opening Source Control only reveals a view, so it stays available.
  assert.equal(review.changeActions(running).find(a => a.id === 'sourceControl').enabled, true);
  assert.equal(review.changeActionMessages('sourceControl', running).length, 1);
});

test('an unknown action posts nothing', () => {
  assert.deepEqual(review.changeActionMessages('explode', ctx), []);
});

test('the enabled flag and the message builders agree', () => {
  // A button whose label is offered but whose message is refused is the defect
  // this pairing exists to prevent, so they are asserted against each other.
  const contexts = [
    ctx,
    { ...ctx, running: true },
    { ...ctx, conversationId: undefined },
    { ...ctx, itemId: undefined },
    { ...ctx, paths: [] },
  ];
  for (const context of contexts) {
    for (const action of review.changeActions(context)) {
      const messages = review.changeActionMessages(action.id, context);
      assert.equal(action.enabled, messages.length > 0, `${action.id} disagrees with its messages for ${JSON.stringify(context)}`);
    }
  }
});
