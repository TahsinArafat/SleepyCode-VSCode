import test from 'node:test';
import assert from 'node:assert/strict';
import * as extras from '../src/settings-extras.ts';

/*
 * Three things the classic settings view had and the React settings window does
 * not: a first-run setup mode, a danger-zone reset, and an extension-log viewer.
 *
 * Two of them are small state machines whose whole point is to make a destructive
 * or irreversible action deliberate, so they are pure and pinned. The third is
 * formatting: the log viewer exists to be read, and a line that hides its level or
 * its event is not worth showing.
 */

test('the reset arms over three clicks, not one', () => {
  // A single click that wipes every setting is a trap; the count is the guard.
  assert.equal(extras.DANGER_CONFIRM_CLICKS, 3);
  assert.equal(extras.isResetArmed(0), false);
  assert.equal(extras.isResetArmed(1), false);
  assert.equal(extras.isResetArmed(2), false);
  assert.equal(extras.isResetArmed(3), true);
  assert.equal(extras.isResetArmed(9), true);
});

test('the label counts down so the user knows the click did something', () => {
  // A button that changes nothing until the third press reads as broken.
  assert.equal(extras.resetLabel(0), 'Reset all settings');
  assert.match(extras.resetLabel(1), /2/);
  assert.match(extras.resetLabel(2), /1/);
  assert.match(extras.resetLabel(3), /confirm/i);
});

test('the reset disarms when the pointer leaves', () => {
  // Leaving the button resets the count, so a user cannot arm it by accident,
  // wander off, and then finish the gesture later.
  assert.equal(extras.nextResetClicks(0, 'leave'), 0);
  assert.equal(extras.nextResetClicks(2, 'leave'), 0);
  assert.equal(extras.nextResetClicks(0, 'click'), 1);
  assert.equal(extras.nextResetClicks(2, 'click'), 3);
  // Clicking past the threshold stays at the threshold rather than drifting.
  assert.equal(extras.nextResetClicks(3, 'click'), 3);
});

test('the reset message names what will be wiped', () => {
  // "Reset everything" without saying what is lost is not informed consent.
  const text = extras.RESET_CONSEQUENCE;
  assert.match(text, /setting/i);
  assert.match(text, /key/i);
  assert.match(text, /conversation/i);
});

test('log entries become readable lines with their level and event', () => {
  const lines = extras.logLines([
    { timestamp: Date.parse('2026-10-27T10:00:00Z'), level: 'info', event: 'run.enter', detail: 'conversation=c1' },
    { timestamp: Date.parse('2026-10-27T10:00:01Z'), level: 'error', event: 'run.failed' },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /2026-10-27T10:00:00/);
  assert.match(lines[0], /INFO/);
  assert.match(lines[0], /run\.enter/);
  assert.match(lines[0], /conversation=c1/);
  // A line with no detail does not end in a dangling separator.
  assert.doesNotMatch(lines[1], /:\s*$/);
});

test('the log ignores junk entries instead of printing undefined', () => {
  const lines = extras.logLines([null, {}, { level: 'info' }, { event: 'x' }, 'nope']);
  assert.deepEqual(lines, []);
  assert.deepEqual(extras.logLines(undefined), []);
  assert.deepEqual(extras.logLines([]), []);
});

test('the log viewer tallies what is in it', () => {
  // "12 lines" is not useful; "2 errors" is the reason to open the panel.
  const tally = extras.logTally([
    { timestamp: 1, level: 'info', event: 'a' },
    { timestamp: 2, level: 'error', event: 'b' },
    { timestamp: 3, level: 'error', event: 'c' },
    { timestamp: 4, level: 'warn', event: 'd' },
  ]);
  assert.deepEqual(tally, { total: 4, info: 1, warn: 1, error: 2 });
  assert.deepEqual(extras.logTally([]), { total: 0, info: 0, warn: 0, error: 0 });
});

test('an empty log says so rather than showing a blank box', () => {
  assert.equal(extras.logEmptyText(), 'No entries yet. Run something and come back.');
});

test('first-run setup names the one action that unblocks the extension', () => {
  // The whole failure mode of a first run is a user who does not know what to do
  // next, so the copy has to name the action.
  assert.match(extras.FIRST_RUN_TITLE, /set up|welcome|get started/i);
  assert.match(extras.FIRST_RUN_BODY, /sign in|account|key/i);
  assert.equal(extras.FIRST_RUN_ACTION, 'Sign in to SleepyAI');
  // Skipping is allowed; a modal that cannot be dismissed is a trap.
  assert.ok(extras.FIRST_RUN_DISMISS.length > 3);
});

test('setup is only considered complete once something actually happened', () => {
  // Signing in or dismissing both count; merely opening the window does not, or
  // the user is never shown the setup step again.
  assert.equal(extras.completesSetup('signIn'), true);
  assert.equal(extras.completesSetup('dismiss'), true);
  assert.equal(extras.completesSetup('open'), false);
  assert.equal(extras.completesSetup(''), false);
  assert.equal(extras.completesSetup(undefined), false);
});