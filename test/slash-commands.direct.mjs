import test from 'node:test';
import assert from 'node:assert/strict';
import * as slash from '../src/slash-commands.ts';

/*
 * The classic composer had a slash palette: thirteen direct actions, five prompt
 * rewrites, and `/skill <name> <task>`. The React composer inserts plain text, so
 * none of it exists — the single biggest gap against the classic UI.
 *
 * Every command here declares an outcome rather than a callback, so what a command
 * does is assertable without a DOM. The rule the tests hold to: a command either
 * produces messages the host handles, or fills the composer with a prompt, or opens
 * a control that exists. Nothing claims to do something it cannot.
 */

test('every command is complete and unique', () => {
  const ids = slash.SLASH_COMMANDS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate command id');
  for (const command of slash.SLASH_COMMANDS) {
    assert.match(command.id, /^\/[a-z]+$/, `${command.id} should be a slash word`);
    assert.ok(command.label, `${command.id} needs a label`);
    assert.ok(command.description.length > 10, `${command.id} needs a description`);
    assert.ok(command.group, `${command.id} needs a group`);
    assert.ok(command.isComplete === undefined || command.isComplete === false || command.isComplete === true, `${command.id} has a broken flag`);
  }
});

test('the palette groups commands the way the classic one did', () => {
  const groups = new Set(slash.SLASH_COMMANDS.map(c => c.group));
  assert.deepEqual([...groups].sort(), ['Ask', 'Session', 'Workspace'].sort());
});

test('no gaps in the command set', () => {
  // A command that does not resolve is a dead menu row, which is what this whole
  // pass is about. Every declared command must produce an outcome.
  for (const command of slash.SLASH_COMMANDS) {
    const outcome = slash.runSlashCommand(command.id, '', slash.directContext('c1'));
    assert.ok(outcome, `${command.id} resolved to nothing`);
    assert.ok(outcome.kind, `${command.id} has no outcome kind`);
  }
  // And nothing resolves to a kind the composer cannot execute.
  const kinds = new Set(slash.SLASH_COMMANDS.map(c => slash.runSlashCommand(c.id, '', slash.directContext('c1')).kind));
  for (const kind of kinds) assert.ok(['messages', 'prompt', 'control'].includes(kind), `unknown outcome kind ${kind}`);
});

test('the session actions post the messages the host handles', () => {
  const ctx = slash.directContext('c1');
  const messages = (id) => slash.runSlashCommand(id, '', ctx).messages;

  assert.deepEqual(messages('/new'), [{ type: 'newConversation' }]);
  assert.deepEqual(messages('/compact'), [{ type: 'compact', conversationId: 'c1' }]);
  assert.deepEqual(messages('/reindex'), [{ type: 'reindexProject' }]);
  assert.deepEqual(messages('/memory'), [{ type: 'openMemory' }]);
});

test('the workspace actions open a settings section that exists', () => {
  // Each of these lands on a page this build serves; `visibleSection` is what
  // guarantees that, and the sections named here must be served ones.
  const ctx = slash.directContext('c1');
  const out = (id) => slash.runSlashCommand(id, '', ctx).messages[0];
  assert.deepEqual(out('/settings'), { type: 'openSettings' });
  assert.deepEqual(out('/usage'), { type: 'openSettings', section: 'usage' });
  assert.deepEqual(out('/marketplace'), { type: 'openSettings', section: 'marketplace' });
  assert.deepEqual(out('/skills'), { type: 'openSettings', section: 'marketplace' });
});

test('the composer controls are named, not faked', () => {
  // These have no host message: they open a control in the composer itself. Naming
  // the control is what lets the composer wire it, and what makes it testable.
  const ctx = slash.directContext('c1');
  assert.equal(slash.runSlashCommand('/context', '', ctx).control, 'context');
  assert.equal(slash.runSlashCommand('/model', '', ctx).control, 'model');
  assert.equal(slash.runSlashCommand('/agent', '', ctx).control, 'agent');
  assert.equal(slash.runSlashCommand('/permissions', '', ctx).control, 'approval');
});

test('a session action with no conversation is refused, not posted broken', () => {
  // `/compact` and friends name a conversation; posting one with an empty id is
  // the message-that-cannot-work defect.
  const noConversation = slash.directContext(undefined);
  for (const id of ['/compact']) {
    assert.equal(slash.runSlashCommand(id, '', noConversation), null, `${id} with no conversation`);
  }
  // `/new` does not need one.
  assert.deepEqual(slash.runSlashCommand('/new', '', noConversation).messages, [{ type: 'newConversation' }]);
});

test('the prompt rewrites carry the text after the command', () => {
  const plan = slash.runSlashCommand('/plan', 'add a settings page', slash.directContext('c1'));
  assert.equal(plan.kind, 'prompt');
  assert.match(plan.text, /add a settings page/, 'the subject has to survive');
  assert.match(plan.text, /plan/i);
  // The subject is not lost by a rewrite that ignores it.
  const fix = slash.runSlashCommand('/fix', 'the parser drops blank lines', slash.directContext('c1'));
  assert.match(fix.text, /the parser drops blank lines/);
});

test('a rewrite with no subject still says something useful', () => {
  // `/review` with nothing after it is a normal thing to type.
  const review = slash.runSlashCommand('/review', '', slash.directContext('c1'));
  assert.equal(review.kind, 'prompt');
  assert.ok(review.text.length > 40, 'a bare rewrite must still be a usable prompt');
  assert.doesNotMatch(review.text, /\s{2,}/, 'no double spaces from concatenating an empty subject');
});

test('every prompt rewrite produces a distinct prompt', () => {
  const text = (id) => slash.runSlashCommand(id, 'the thing', slash.directContext('c1')).text;
  const prompts = ['/plan', '/fix', '/review', '/test', '/explain'].map(text);
  assert.equal(new Set(prompts).size, prompts.length, 'two rewrites produce the same prompt');
  for (const prompt of prompts) assert.ok(prompt.length > 40, 'a rewrite should be more than a label');
});

test('/skill names the skill and keeps the task', () => {
  const outcome = slash.runSlashCommand('/skill', 'release-checklist cut a release', slash.directContext('c1'));
  assert.equal(outcome.kind, 'prompt');
  assert.match(outcome.text, /release-checklist/);
  assert.match(outcome.text, /cut a release/);
});

test('/skill without a skill name asks for one instead of guessing', () => {
  // Silently treating the first word as a skill on an empty argument would invent
  // a skill name and send a prompt about it.
  const outcome = slash.runSlashCommand('/skill', '', slash.directContext('c1'));
  assert.equal(outcome.kind, 'prompt');
  assert.match(outcome.text, /skill/i);
  assert.doesNotMatch(outcome.text, /@/, 'no invented skill reference');
});

test('an unknown command resolves to nothing rather than to text', () => {
  // The palette must not swallow a message that merely starts with a slash.
  assert.equal(slash.runSlashCommand('/nope', '', slash.directContext('c1')), null);
  assert.equal(slash.runSlashCommand('/co', '', slash.directContext('c1')), null, 'a prefix is not a command');
  assert.equal(slash.runSlashCommand('compact', '', slash.directContext('c1')), null, 'no leading slash');
  assert.equal(slash.runSlashCommand('', '', slash.directContext('c1')), null);
});

test('commands are matched by prefix, case-insensitively, with the best first', () => {
  // Typing "/co" should not offer every command containing "co".
  assert.deepEqual(slash.matchSlashCommands('/co').map(c => c.id), ['/compact', '/context']);
  assert.deepEqual(slash.matchSlashCommands('/').map(c => c.id), slash.SLASH_COMMANDS.map(c => c.id));
  assert.deepEqual(slash.matchSlashCommands('/COMP').map(c => c.id), ['/compact']);
  assert.deepEqual(slash.matchSlashCommands('/zzz'), []);
  // Everything, in declared order, for a bare slash with no query.
  assert.deepEqual(slash.matchSlashCommands('/ma').map(c => c.id), ['/marketplace']);
});

test('a command is matched by its name and not by its description', () => {
  // Matching descriptions makes "/settings" surface unrelated commands whose text
  // happens to mention settings.
  assert.deepEqual(slash.matchSlashCommands('/plan').map(c => c.id), ['/plan']);
  assert.deepEqual(slash.matchSlashCommands('/agent').map(c => c.id), ['/agent']);
});

test('a command with arguments is still offered while it is being typed', () => {
  // "/plan add a settings page" must keep showing /plan, or the menu vanishes as
  // soon as the user starts describing what they want.
  assert.deepEqual(slash.matchSlashCommands('/plan add a settings page').map(c => c.id), ['/plan']);
  // `/skill ...` also still offers `/skills`, because the match is by prefix and
  // the user may yet be typing the longer word. That is the point of matching on
  // the name rather than on the whole string.
  assert.deepEqual(slash.matchSlashCommands('/skill release-checklist cut it').map(c => c.id), ['/skill', '/skills']);
});

test('parseSlash separates the command from its argument', () => {
  assert.deepEqual(slash.parseSlash('/plan add a page'), { name: '/plan', args: 'add a page' });
  assert.deepEqual(slash.parseSlash('/review'), { name: '/review', args: '' });
  assert.deepEqual(slash.parseSlash('/review   '), { name: '/review', args: '' });
  assert.deepEqual(slash.parseSlash('/plan   a   b'), { name: '/plan', args: 'a   b' }, 'inner spacing is the user’s');
  assert.equal(slash.parseSlash('plain text'), null);
  assert.equal(slash.parseSlash(''), null);
  // A slash that is not at the start is not a command.
  assert.equal(slash.parseSlash('see /plan'), null);
});

test('the palette is only offered for a slash at the very start', () => {
  assert.equal(slash.slashOpen('/'), true);
  assert.equal(slash.slashOpen('/pl'), true);
  assert.equal(slash.slashOpen(''), false);
  assert.equal(slash.slashOpen('hello /plan'), false);
  // A path typed as prose must not pop the palette: the word after the slash is
  // followed by spaces, so this is a sentence rather than a command being typed.
  assert.equal(slash.slashOpen('/usr/local/bin is missing'), false, 'a path with spaces is prose');
  assert.equal(slash.slashOpen('/usr/local'), true, 'a bare slash word is still a command being typed');
  assert.equal(slash.slashOpen(' /plan'), false, 'leading space means it is prose');
});