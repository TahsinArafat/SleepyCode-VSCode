import test from 'node:test';
import assert from 'node:assert/strict';
import * as panel from '../src/panel-core.ts';

// The five side panels used to reach the user as a QuickPick, which threw away
// everything except the text of each row. These tests pin the model the React
// drawer renders: titles, hints, which buttons exist, and — most importantly —
// the exact host messages those buttons post. A button that posts nothing is
// the failure mode worth guarding: it looks like a working control.

const IDS = ['worktrees', 'index', 'agents', 'tasks', 'checkpoints'];

test('every panel id is recognised and unknown ids are not', () => {
  for (const id of IDS) assert.equal(panel.isPanelId(id), true, id);
  assert.equal(panel.isPanelId('marketplace'), false);
  assert.equal(panel.isPanelId(''), false);
  assert.equal(panel.isPanelId(undefined), false);
  assert.equal(panel.isPanelId(7), false);
  assert.deepEqual([...panel.PANEL_IDS], IDS);
});

test('titles are the names the commands use, and unknown ids pass through', () => {
  assert.equal(panel.panelTitle('worktrees'), 'Worktrees');
  assert.equal(panel.panelTitle('index'), 'Project Index');
  assert.equal(panel.panelTitle('agents'), 'Agents');
  assert.equal(panel.panelTitle('tasks'), 'Scheduled Tasks');
  assert.equal(panel.panelTitle('checkpoints'), 'Undo History');
  // A panel added later must still render a heading rather than an empty one.
  assert.equal(panel.panelTitle('mystery'), 'mystery');
});

test('every panel has a hint for when the host sends none', () => {
  for (const id of IDS) {
    const hint = panel.panelHintFor(id);
    assert.equal(typeof hint, 'string', id);
    assert.ok(hint.length > 10, `${id} hint is too short: ${hint}`);
  }
  // Unknown panels get no invented guidance.
  assert.equal(panel.panelHintFor('mystery'), '');
});

test('refresh is offered everywhere; reindex only where it means something', () => {
  for (const id of IDS) {
    assert.ok(panel.panelActions(id).some(a => a.id === 'refresh'), `${id} cannot refresh`);
  }
  assert.deepEqual(panel.panelActions('index').map(a => a.id), ['refresh', 'reindex']);
  assert.deepEqual(panel.panelActions('worktrees').map(a => a.id), ['refresh', 'newWorktree']);
  // Informational panels must not grow buttons that do nothing.
  assert.deepEqual(panel.panelActions('tasks').map(a => a.id), ['refresh']);
  assert.deepEqual(panel.panelActions('agents').map(a => a.id), ['refresh']);
  assert.deepEqual(panel.panelActions('checkpoints').map(a => a.id), ['refresh']);
  assert.deepEqual(panel.panelActions('mystery'), []);
});

test('only panels with selectable rows get a row action', () => {
  assert.deepEqual(panel.panelRowAction('agents'), { id: 'useAgent', label: 'Use' });
  assert.deepEqual(panel.panelRowAction('checkpoints'), { id: 'restore', label: 'Restore' });
  assert.equal(panel.panelRowAction('worktrees'), null);
  assert.equal(panel.panelRowAction('index'), null);
  assert.equal(panel.panelRowAction('tasks'), null);
  assert.equal(panel.panelRowAction('mystery'), null);
});

test('row keys are stable and never collide', () => {
  assert.equal(panel.panelRowKey({ id: 'a', title: 'A' }, 0), 'a');
  assert.equal(panel.panelRowKey({ title: 'A' }, 3), '3');
  // An empty id is not an id: it would key every such row to "".
  assert.equal(panel.panelRowKey({ id: '', title: 'A' }, 3), '3');
  const keys = [{ id: 'x', title: 'A' }, { title: 'B' }, { id: 'x', title: 'C' }].map(panel.panelRowKey);
  assert.deepEqual(keys, ['x', '1', 'x']);
});

test('refresh asks the host for that panel again', () => {
  assert.deepEqual(panel.panelActionMessages('worktrees', 'refresh'), [{ type: 'requestPanel', panel: 'worktrees' }]);
  assert.deepEqual(panel.panelActionMessages('checkpoints', 'refresh'), [{ type: 'requestPanel', panel: 'checkpoints' }]);
});

test('reindex rebuilds the index and then re-reads the panel', () => {
  assert.deepEqual(panel.panelActionMessages('index', 'reindex'), [
    { type: 'reindexProject' },
    { type: 'requestPanel', panel: 'index' },
  ]);
  // Reindexing is only wired on the index panel; elsewhere it must not fire.
  assert.deepEqual(panel.panelActionMessages('tasks', 'reindex'), []);
});

test('new worktree reuses the existing conversation-scoped command', () => {
  assert.deepEqual(panel.panelActionMessages('worktrees', 'newWorktree'), [{ type: 'createWorktreeConversation' }]);
  assert.deepEqual(panel.panelActionMessages('index', 'newWorktree'), []);
});

test('unknown panel actions post nothing', () => {
  assert.deepEqual(panel.panelActionMessages('worktrees', 'explode'), []);
  assert.deepEqual(panel.panelActionMessages('mystery', 'refresh'), []);
});

test('using an agent selects it by id', () => {
  assert.deepEqual(
    panel.panelRowActionMessages('agents', 'useAgent', { id: 'reviewer', title: 'Reviewer' }),
    [{ type: 'selectAgent', agentId: 'reviewer' }],
  );
  // A row without an id has no target, so the button must post nothing rather
  // than selecting "" and resetting the agent.
  assert.deepEqual(panel.panelRowActionMessages('agents', 'useAgent', { title: 'Reviewer' }), []);
  assert.deepEqual(panel.panelRowActionMessages('agents', 'useAgent', { id: '', title: 'Reviewer' }), []);
});

test('restoring a checkpoint needs both the conversation and the turn', () => {
  const row = { id: 'item-2', title: 'Added the parser' };
  assert.deepEqual(
    panel.panelRowActionMessages('checkpoints', 'restore', row, { conversationId: 'conv-1' }),
    [{ type: 'restoreCheckpoint', conversationId: 'conv-1', itemId: 'item-2' }],
  );
  assert.deepEqual(panel.panelRowActionMessages('checkpoints', 'restore', row, {}), []);
  assert.deepEqual(panel.panelRowActionMessages('checkpoints', 'restore', { title: 'x' }, { conversationId: 'conv-1' }), []);
  // The host refuses a restore mid-run; posting it anyway would be a no-op that
  // reads as a broken button, so the message is never built.
  assert.deepEqual(
    panel.panelRowActionMessages('checkpoints', 'restore', row, { conversationId: 'conv-1', running: true }),
    [],
  );
});

test('row actions are only honoured on the panel that owns them', () => {
  assert.deepEqual(panel.panelRowActionMessages('agents', 'restore', { id: 'x' }, { conversationId: 'c' }), []);
  assert.deepEqual(panel.panelRowActionMessages('checkpoints', 'useAgent', { id: 'x' }, { conversationId: 'c' }), []);
  assert.deepEqual(panel.panelRowActionMessages('mystery', 'restore', { id: 'x' }, { conversationId: 'c' }), []);
});

test('row buttons are disabled exactly when their message cannot be built', () => {
  assert.equal(panel.panelRowActionEnabled('useAgent', { id: 'reviewer' }, {}), true);
  assert.equal(panel.panelRowActionEnabled('useAgent', { title: 'no id' }, {}), false);
  assert.equal(panel.panelRowActionEnabled('restore', { id: 'i' }, { conversationId: 'c' }), true);
  assert.equal(panel.panelRowActionEnabled('restore', { id: 'i' }, {}), false);
  assert.equal(panel.panelRowActionEnabled('restore', { id: 'i' }, { conversationId: 'c', running: true }), false);
  assert.equal(panel.panelRowActionEnabled('restore', { title: 'no id' }, { conversationId: 'c' }), false);
  assert.equal(panel.panelRowActionEnabled('explode', { id: 'i' }, { conversationId: 'c' }), false);
});

// ---------------------------------------------------------------- drawer entry
//
// The drawer only ever opened when a VS Code command pushed `showPanel`, so
// everything in it was unreachable from the chat. These are the entries the More
// menu offers, and the rule that each one names a panel that exists.

test('the menu offers one entry per panel, labelled for a user', () => {
  const entries = panel.panelMenuEntries();
  assert.deepEqual(entries.map(e => e.id), ['worktrees', 'index', 'agents', 'tasks', 'checkpoints']);
  for (const entry of entries) {
    assert.equal(entry.label, panel.panelTitle(entry.id), `${entry.id} should reuse the panel title`);
    assert.ok(entry.hint.length > 10, `${entry.id} needs a hint`);
  }
  // The hint says what the panel is for, not just its name again.
  assert.match(entries.find(e => e.id === 'checkpoints').hint, /restore|undo/i);
});

test('opening a panel posts the message the host handles', () => {
  assert.deepEqual(panel.openPanelMessage('worktrees'), { type: 'openPanel', panel: 'worktrees' });
  assert.deepEqual(panel.openPanelMessage('checkpoints'), { type: 'openPanel', panel: 'checkpoints' });
  // An id that names no panel would ask the host for something it cannot build.
  assert.equal(panel.openPanelMessage('marketplace'), null);
  assert.equal(panel.openPanelMessage(''), null);
  assert.equal(panel.openPanelMessage(undefined), null);
});
