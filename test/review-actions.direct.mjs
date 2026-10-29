import test from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../src/review-actions.ts';

/*
 * The changed-files bar.
 *
 * The bar once offered Keep All / Undo All / Commit / Source Control (and before
 * those, Stage all and Restore checkpoint). Every one had a real host handler,
 * but each path carried a precondition that could fail it silently — no git
 * root, pre-existing dirty files, unrelated staged changes — so from the user's
 * seat the buttons read as decoration, and they were removed on request. The
 * bar now shows the count and one OK that dismisses it; per-file Keep/Undo stay
 * in the expanded list, and bulk work lives in VS Code's Source Control.
 *
 * These builders exist so the one remaining button posts a message the host
 * actually receives, and so a button whose target is missing is disabled rather
 * than dead.
 */

const ctx = { conversationId: 'c1', itemId: 'i1', paths: ['a.ts', 'b.ts'], running: false };

test('the bar offers OK and nothing else', () => {
  const actions = review.changeActions(ctx);
  assert.deepEqual(actions.map(a => a.id), ['dismiss']);
  assert.equal(actions[0].label, 'OK');
  assert.ok(actions[0].hint.length > 10, 'dismiss needs a hint');
  assert.equal(actions[0].enabled, true, 'dismiss should be enabled with a full context');
});

test('the removed bulk actions post nothing', () => {
  // Removed on request after the buttons read as decoration: every one had a
  // precondition that could fail it silently.
  for (const removed of ['keepAll', 'undoAll', 'commit', 'sourceControl', 'stageAll', 'restore']) {
    assert.equal(review.changeActionMessages(removed, ctx).length, 0, `${removed} must be gone`);
    assert.equal(review.changeActions(ctx).some(action => action.id === removed), false, `${removed} must not render`);
  }
});

test('dismiss posts an intent the host receives', () => {
  // Posting host names from the webview was silently dropped — `toSleepyMessage`
  // has no case for them — so the intent is a React-level name the adapter
  // translates and the host acknowledges.
  assert.deepEqual(review.changeActionMessages('dismiss', ctx), [{ type: 'dismissChanges', conversationId: 'c1' }]);
});

test('the turn id is optional, because the host tracks it', () => {
  assert.equal(review.changeActionMessages('dismiss', { ...ctx, itemId: undefined }).length, 1);
});

test('nothing fires with no conversation and no changes at all', () => {
  for (const action of review.changeActions({}).map(a => a.id)) {
    assert.deepEqual(review.changeActionMessages(action, {}), [], `${action} with nothing`);
  }
});

test('dismiss works while a run is in flight', () => {
  // Dismissing a notice is not a file mutation; the old gate that disabled every
  // action mid-run does not apply to it.
  const running = { ...ctx, running: true };
  const actions = review.changeActions(running);
  assert.equal(actions[0].enabled, true);
  assert.deepEqual(review.changeActionMessages('dismiss', running), [{ type: 'dismissChanges', conversationId: 'c1' }]);
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
    {},
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
