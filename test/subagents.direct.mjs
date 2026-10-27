import test from 'node:test';
import assert from 'node:assert/strict';
import * as subagents from '../src/subagents.ts';

/*
 * Subagents, named and grouped.
 *
 * The three built-in roles are the shapes a delegation can take: research,
 * critique, or bounded implementation. What a project actually needs is a name
 * for a job — "threat modeler", "migration planner" — that carries its own
 * instructions and, optionally, its own cheap model. A team is a roster of those
 * names, so a project lead delegates to a defined group instead of to whatever
 * it can think of.
 *
 * The rules that bite: a name the model addresses must match exactly one
 * definition, deleting a subagent must not leave a team referencing a ghost, and
 * a read-only definition must not get write tools because it happens to run on
 * the worker role.
 */

const { BUILTIN_SUBAGENTS, allSubagents, findSubagent, normalizeCustomSubagents, normalizeTeams, resolveTeamSubagents, subagentRosterBlock, teamRosterNote, validateSubagentDraft, validateTeamDraft } = subagents;

test('the three built-in roles are offered as subagents, with their capability', () => {
  assert.deepEqual(BUILTIN_SUBAGENTS.map((def) => def.role).sort(), ['explorer', 'reviewer', 'worker']);
  for (const def of BUILTIN_SUBAGENTS) {
    assert.ok(def.builtin, `${def.id} is built in`);
    assert.ok(def.name && def.description && def.prompt.length > 20, `${def.id} needs a real prompt and description`);
    // Read-only is the capability, not a checkbox somebody forgot.
    assert.equal(def.readonly, def.role !== 'worker', `${def.id} read-only must follow its role`);
  }
});

test('custom subagents join the roster and cannot shadow a built-in', () => {
  const custom = [
    { id: 'threat-modeler', name: 'Threat modeler', description: 'Finds attack surfaces', prompt: 'Think like an attacker.', role: 'reviewer', readonly: true },
    { id: 'explorer', name: 'Impostor', description: 'x', prompt: 'x', role: 'worker', readonly: false },
  ];
  const all = allSubagents(custom);
  assert.equal(all.filter((def) => def.id === 'explorer').length, 1);
  assert.equal(findSubagent(all, 'explorer').builtin, true);
  assert.ok(findSubagent(all, 'threat-modeler'));
});

test('a corrupt stored roster is dropped rather than rendered', () => {
  const stored = [
    null,
    { id: '', name: 'no id', prompt: 'p', role: 'reviewer' },
    { id: 'ok-one', name: 'Ok', description: 'd', prompt: 'p', role: 'reviewer', readonly: true },
    { id: 'bad role', name: 'Bad', description: 'd', prompt: 'p', role: 'emperor', readonly: true },
    { id: 'no-prompt', name: 'Empty', description: 'd', prompt: '   ', role: 'reviewer', readonly: true },
  ];
  assert.deepEqual(normalizeCustomSubagents(stored).map((def) => def.id), ['ok-one']);
  assert.deepEqual(normalizeCustomSubagents(undefined), []);
});

test('the model addresses a subagent by name, ignoring case and punctuation', () => {
  const all = allSubagents([{ id: 'threat-modeler', name: 'Threat Modeler', description: 'd', prompt: 'p', role: 'reviewer', readonly: true }]);
  assert.equal(findSubagent(all, 'threat-modeler').id, 'threat-modeler');
  assert.equal(findSubagent(all, 'Threat Modeler').id, 'threat-modeler');
  assert.equal(findSubagent(all, 'THREAT_MODELER').id, 'threat-modeler');
  // An unknown name is undefined, so the caller can fall back to the role.
  assert.equal(findSubagent(all, 'nobody'), undefined);
  assert.equal(findSubagent(all, ''), undefined);
});

test('the roster shown to the model lists every subagent with what it is for', () => {
  const block = subagentRosterBlock(allSubagents([{ id: 'migrator', name: 'Migrator', description: 'Moves code between APIs', prompt: 'p', role: 'worker', readonly: false }]));
  assert.match(block, /<subagents>/);
  assert.match(block, /Explorer/);
  assert.match(block, /Migrator/);
  assert.match(block, /Moves code between APIs/);
  // Read-only is part of what the model needs to know before delegating.
  assert.match(block, /read-only/);
});

test('a new subagent needs an addressable id, a description and instructions', () => {
  const base = { id: 'migrator', name: 'Migrator', description: 'Moves code', prompt: 'Do the migration.', role: 'worker', readonly: false };
  assert.equal(validateSubagentDraft(base, [], { isNew: true }), '');
  assert.match(validateSubagentDraft({ ...base, id: 'Not A Slug' }, [], { isNew: true }), /id/i);
  assert.match(validateSubagentDraft({ ...base, description: '  ' }, [], { isNew: true }), /description/i);
  assert.match(validateSubagentDraft({ ...base, prompt: '  ' }, [], { isNew: true }), /instructions|prompt/i);
  // The model picks by name, so a name that is not unique is unusable.
  const existing = [{ id: 'other', name: 'Migrator', description: 'd', prompt: 'p', role: 'worker', readonly: false }];
  assert.match(validateSubagentDraft(base, existing, { isNew: true }), /name/i);
});

test('teams keep only members that exist', () => {
  const all = allSubagents([{ id: 'migrator', name: 'Migrator', description: 'd', prompt: 'p', role: 'worker', readonly: false }]);
  const known = all.map((def) => def.id);
  const teams = normalizeTeams([
    { id: 'squad', name: 'Squad', description: 'x', subagentIds: ['explorer', 'ghost', 'migrator'] },
    { id: 'empty', name: 'Empty', description: 'x', subagentIds: [] },
    { id: 'bad', name: 'Bad', description: 'x', subagentIds: 'nope' },
  ], known);
  assert.deepEqual(teams.map((team) => team.id), ['squad']);
  assert.deepEqual(teams[0].subagentIds, ['explorer', 'migrator']);
});

test('assigning no team means every subagent is delegatable', () => {
  const all = allSubagents([]);
  const teams = [{ id: 'squad', name: 'Squad', description: 'x', subagentIds: ['explorer'] }];
  // Nothing assigned: the roster is everything, which is the default behaviour
  // this feature must not change.
  assert.deepEqual(resolveTeamSubagents(all, teams, []).map((def) => def.id).sort(), all.map((def) => def.id).sort());
  // Assigned: only the members.
  assert.deepEqual(resolveTeamSubagents(all, teams, ['squad']).map((def) => def.id), ['explorer']);
  // An assigned team whose members were all deleted falls back to everything
  // rather than leaving the model with nobody to delegate to.
  const orphan = [{ id: 'squad', name: 'Squad', description: 'x', subagentIds: [] }];
  assert.equal(resolveTeamSubagents(all, orphan, ['squad']).length, all.length);
});

test('the assigned-teams note names the lead relationship', () => {
  const teams = [{ id: 'squad', name: 'Squad', description: 'Builds features', subagentIds: ['explorer'] }];
  assert.equal(teamRosterNote(teams, []), '');
  const note = teamRosterNote(teams, ['squad']);
  assert.match(note, /<assigned_teams>/);
  assert.match(note, /Squad/);
  assert.match(note, /lead/i);
});

test('a team needs a name and at least one member', () => {
  const base = { id: 'squad', name: 'Squad', description: 'x', subagentIds: ['explorer'] };
  assert.equal(validateTeamDraft(base, [], { isNew: true }), '');
  assert.match(validateTeamDraft({ ...base, name: '' }, [], { isNew: true }), /name/i);
  assert.match(validateTeamDraft({ ...base, subagentIds: [] }, [], { isNew: true }), /member/i);
  assert.match(validateTeamDraft(base, [{ id: 'squad', name: 'Other', description: 'x', subagentIds: ['explorer'] }], { isNew: true }), /already/i);
});