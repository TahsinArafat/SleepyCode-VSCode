import test from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../src/review-actions.ts';

/*
 * The review bar's actions.
 *
 * Two of the four the classic card offered are gone rather than left standing:
 * "Stage all" duplicated Keep All (staging is what Keep All does), and "Restore
 * checkpoint" rolled every file back to its pre-turn state — the opposite of the
 * Keep All button beside it, and available where it belongs in Undo History. A
 * button whose label promises a state change it should not make is worse than no
 * button at all.
 *
 * These builders exist so each remaining button posts a message the host already
 * handles, and so a button whose target is missing is disabled rather than dead.
 * The host resolves an edit through a conversation and the turn that made it.
 */

const ctx = { conversationId: 'c1', itemId: 'i1', paths: ['a.ts', 'b.ts'], running: false };

test('the bar offers Keep All, Undo All, Commit and Source Control, and nothing else', () => {
  const actions = review.changeActions(ctx);
  assert.deepEqual(actions.map(a => a.id), ['keepAll', 'undoAll', 'commit', 'sourceControl']);
  for (const action of actions) {
    assert.ok(action.label, `${action.id} needs a label`);
    assert.ok(action.hint.length > 10, `${action.id} needs a hint`);
    assert.equal(action.enabled, true, `${action.id} should be enabled with a full context`);
  }
});

test('the two that duplicated or contradicted Keep All are gone', () => {
  // "Stage all" staged — which is exactly what Keep All does — and "Restore
  // checkpoint" reverted every file, the opposite of the button next to it.
  assert.equal(review.changeActionMessages('stageAll', ctx).length, 0);
  assert.equal(review.changeActionMessages('restore', ctx).length, 0);
  assert.equal(review.changeActions(ctx).some(action => action.id === 'stageAll' || action.id === 'restore'), false);
});

test('keeping and undoing post the paths the bar is showing', () => {
  // The host resolves the turn; the paths are what the user is looking at.
  assert.deepEqual(review.changeActionMessages('keepAll', ctx), [
    { type: 'acceptAllChanges', conversationId: 'c1', paths: ['a.ts', 'b.ts'] },
  ]);
  assert.deepEqual(review.changeActionMessages('undoAll', ctx), [
    { type: 'rejectAllChanges', conversationId: 'c1', paths: ['a.ts', 'b.ts'] },
  ]);
});

test('commit and source control post intents the adapter can translate', () => {
  // Posting host names (`gitCommit`, `reviewChanges`) from the webview was silently
  // dropped — `toSleepyMessage` has no case for them — so both buttons did nothing.
  assert.deepEqual(review.changeActionMessages('commit', ctx), [{ type: 'commitChanges', conversationId: 'c1' }]);
  assert.deepEqual(review.changeActionMessages('sourceControl', ctx), [{ type: 'openSourceControl', conversationId: 'c1' }]);
});

test('the turn id is optional, because the host tracks it', () => {
  // Requiring it left every one of these permanently disabled: turns carry no id
  // in the webview.
  for (const action of ['keepAll', 'undoAll', 'commit', 'sourceControl']) {
    assert.equal(review.changeActionMessages(action, { ...ctx, itemId: undefined }).length, 1, `${action} without a turn id`);
  }
});

test('nothing fires with no conversation and no changes at all', () => {
  for (const action of review.changeActions({}).map(a => a.id)) {
    assert.deepEqual(review.changeActionMessages(action, {}), [], `${action} with nothing`);
  }
});

test('keeping and undoing need at least one path', () => {
  // An empty list would post a "keep everything" for nothing.
  assert.deepEqual(review.changeActionMessages('keepAll', { ...ctx, paths: [] }), []);
  assert.deepEqual(review.changeActionMessages('undoAll', { ...ctx, paths: undefined }), []);
  // Commit and Source Control do not depend on the list: the host resolves
  // the files from the turn.
  assert.equal(review.changeActionMessages('commit', { ...ctx, paths: [] }).length, 1);
});

test('every action is disabled while a run is in flight', () => {
  // The host refuses all of them mid-run — a revert racing a live edit is worse
  // than a disabled button — so the bar must not offer one it cannot run.
  const running = { ...ctx, running: true };
  for (const action of review.changeActions(running)) {
    assert.equal(action.enabled, false, `${action.id} while running`);
    assert.deepEqual(review.changeActionMessages(action.id, running), [], `${action.id} while running`);
  }
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

// ---------------------------------------------------------------- starting a review

/*
 * "Review code" used to post `reviewChanges`, which resolves a turn's tracked
 * files — so choosing the workspace-wide "Uncommitted changes" scope reported
 * "No workspace file changes were recorded for this response" whenever the
 * uncommitted work came from an earlier conversation. A review has to name its
 * own scope, not borrow the newest response's.
 */

test('each review scope becomes a prompt that names it', () => {
  const uncommitted = review.reviewStart({ type: 'uncommitted' });
  assert.equal(uncommitted.title, 'Review uncommitted changes');
  assert.match(uncommitted.prompt, /unstaged/);
  assert.match(uncommitted.prompt, /read-only/i);

  const branch = review.reviewStart({ type: 'baseBranch', branch: 'origin/main' });
  assert.match(branch.title, /origin\/main/);
  assert.match(branch.prompt, /origin\/main/);

  const commit = review.reviewStart({ type: 'commit', commit: 'abc1234' });
  assert.match(commit.prompt, /abc1234/);

  const custom = review.reviewStart({ type: 'custom', instructions: 'Only the parser.' });
  assert.match(custom.prompt, /Only the parser\./);
});

test('a scope with nothing to review is refused rather than started', () => {
  // An empty branch or commit would send a review of everything.
  assert.equal(review.reviewStart({ type: 'baseBranch', branch: '  ' }), null);
  assert.equal(review.reviewStart({ type: 'commit', commit: '' }), null);
  assert.equal(review.reviewStart({ type: 'custom', instructions: '' }), null);
  assert.equal(review.reviewStart(undefined), null);
});
