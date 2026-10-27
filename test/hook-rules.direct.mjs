import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../src/hook-rules.ts';

/*
 * Hooks run in-process here: an event, an optional matcher, and an action. The
 * ported settings page edited shell commands instead, which nothing ran and
 * nothing stored. These are the rules that decide what a saved hook does — so a
 * typo must never become "block everything" or "allow everything".
 */

test('a new rule is added with an id that cannot collide', () => {
  const existing = [{ id: 'hook-2', name: 'a', event: 'beforeTool', action: 'warn', enabled: true }];
  const added = rules.newHookRule(existing, 'onEdit');
  assert.equal(added.event, 'onEdit');
  assert.equal(added.action, 'warn');
  assert.equal(added.enabled, true);
  assert.equal(existing.some(rule => rule.id === added.id), false);
});

test('untrusted input is read back, and anything unrecognised is dropped', () => {
  const parsed = rules.normalizeHookRules([
    { id: 'a', name: 'No deletes', event: 'onCommand', action: 'block', message: 'No rm', matcher: { contains: 'rm -rf' } },
    // Unknown action, unknown event, and a non-object.
    { id: 'b', event: 'onCommand', action: 'explode' },
    { id: 'c', event: 'onNothing', action: 'block' },
    'nope',
    // Duplicate ids would make one row edit another.
    { id: 'a', name: 'dupe', event: 'onMessage', action: 'log' },
  ]);
  assert.equal(parsed.length, 2);
  // An unknown action becomes the harmless one rather than the drastic one.
  assert.equal(parsed[1].action, 'warn');
  assert.equal(parsed[1].id, 'b');
  assert.deepEqual(parsed[0].matcher, { contains: 'rm -rf' });
});

test('a rule that blocks or asks has to say why', () => {
  assert.equal(rules.hookRuleProblem({ id: 'a', name: 'x', event: 'onEdit', action: 'warn', message: '', enabled: true }), null);
  assert.match(rules.hookRuleProblem({ id: 'a', name: 'x', event: 'onEdit', action: 'block', message: '  ', enabled: true }) ?? '', /Say why/);
  assert.equal(rules.hookRuleProblem({ id: 'a', name: 'x', event: 'onEdit', action: 'block', message: 'No secrets', enabled: true }), null);
});

test('the matcher fields offered match what the event actually carries', () => {
  assert.deepEqual(rules.matcherFields('beforeTool'), ['tool', 'pathGlob']);
  assert.deepEqual(rules.matcherFields('onEdit'), ['pathGlob']);
  assert.deepEqual(rules.matcherFields('onCommand'), ['contains']);
  // A run start carries no tool, path or text, so it cannot be matched on.
  assert.deepEqual(rules.matcherFields('onAgentStart'), []);
});

test('a rule reads as one line, including what it matches', () => {
  const summary = rules.hookRuleSummary({
    id: 'a', name: 'x', event: 'onCommand', action: 'block', message: 'No',
    matcher: { contains: 'rm -rf' }, enabled: true,
  });
  assert.match(summary, /Before a command/);
  assert.match(summary, /contains "rm -rf"/);
  assert.match(summary, /block/);
});