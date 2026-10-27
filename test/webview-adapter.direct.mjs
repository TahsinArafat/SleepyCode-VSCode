import { test } from 'node:test';
import assert from 'node:assert/strict';

const adapter = await import('../src/webview-adapter.ts');

// ---------------------------------------------------------------- React -> Sleepy

test('ready passes through', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'ready' }), { type: 'ready' });
});

test('sendMessage -> send carries text, conversation and model', () => {
  const out = adapter.toSleepyMessage({ type: 'sendMessage', convId: 'c1', text: 'hi', model: 'm1' });
  assert.equal(out.type, 'send');
  assert.equal(out.text, 'hi');
  assert.equal(out.conversationId, 'c1');
  assert.equal(out.model, 'm1');
});

test('sendMessage without convId omits conversationId', () => {
  const out = adapter.toSleepyMessage({ type: 'sendMessage', text: 'hi' });
  assert.equal(out.type, 'send');
  assert.equal(out.conversationId, undefined);
});

test('stop -> stop', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'stop' }), { type: 'stop' });
});

test('newConversation -> newConversation', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'newConversation' }), { type: 'newConversation' });
});

test('openConversation / loadConversation -> openConversation', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openConversation', id: 'c1' }), { type: 'openConversation', id: 'c1' });
  assert.deepEqual(adapter.toSleepyMessage({ type: 'loadConversation', convId: 'c2' }), { type: 'openConversation', id: 'c2' });
});

test('selectModel -> selectModel', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'selectModel', model: 'gpt-x' }), { type: 'selectModel', model: 'gpt-x' });
});

test('undoLastTurn / redoLastTurn carry conversation id', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'undoLastTurn', convId: 'c1' }), { type: 'undoLastTurn', conversationId: 'c1' });
  assert.deepEqual(adapter.toSleepyMessage({ type: 'redoLastTurn', convId: 'c1' }), { type: 'redoLastTurn', conversationId: 'c1' });
});

test('panel requests pass through', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openPanel', panel: 'tasks' }), { type: 'openPanel', panel: 'tasks' });
  assert.deepEqual(adapter.toSleepyMessage({ type: 'requestPanel', panel: 'index' }), { type: 'requestPanel', panel: 'index' });
});

test('react-only messages are dropped', () => {
  // persistTurns is mapped now (the host adopts it defensively); unknown types
  // are still dropped.
  assert.equal(adapter.toSleepyMessage({ type: 'unknownThing' }), null);
  assert.equal(adapter.toSleepyMessage({ type: 'setPersona', personaId: 'x' }), null);
});

// ---------------------------------------------------------------- Sleepy -> React

test('delta -> agentEvent text-delta', () => {
  const out = adapter.toReactMessage({ type: 'delta', conversationId: 'c1', text: 'hello' });
  assert.equal(out.type, 'agentEvent');
  assert.equal(out.convId, 'c1');
  assert.equal(out.event.type, 'text-delta');
  assert.equal(out.event.text, 'hello');
});

test('reasoningDelta -> agentEvent thinking-delta', () => {
  const out = adapter.toReactMessage({ type: 'reasoningDelta', conversationId: 'c1', text: 'why' });
  assert.equal(out.event.type, 'thinking-delta');
  assert.equal(out.event.text, 'why');
});

test('tool start -> tool-call-started', () => {
  const out = adapter.toReactMessage({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'read_file', name: 'Read file' });
  assert.equal(out.event.type, 'tool-call-started');
  assert.equal(out.event.callId, 't1');
  // Tool ids are mapped to the React card names.
  assert.equal(out.event.name, 'Read');
});

test('tool end -> tool-call-completed with status', () => {
  const out = adapter.toReactMessage({ type: 'tool', conversationId: 'c1', phase: 'end', id: 't1', tool: 'read_file', name: 'Read file', failed: true });
  assert.equal(out.event.type, 'tool-call-completed');
  assert.equal(out.event.status, 'error');
});

test('error -> agentEvent error', () => {
  const out = adapter.toReactMessage({ type: 'error', conversationId: 'c1', text: 'boom' });
  assert.equal(out.event.type, 'error');
  assert.equal(out.event.message, 'boom');
});

test('state running -> run-status running', () => {
  const out = adapter.toReactMessage({ type: 'state', conversationId: 'c1', running: true, label: 'Working' });
  assert.equal(out.event.type, 'run-status');
  assert.equal(out.event.status, 'running');
});

test('state idle -> run-status finished', () => {
  const out = adapter.toReactMessage({ type: 'state', conversationId: 'c1', running: false, label: '' });
  assert.equal(out.event.type, 'run-status');
  assert.equal(out.event.status, 'finished');
});

test('done -> run-result', () => {
  const out = adapter.toReactMessage({ type: 'done', conversationId: 'c1' });
  assert.equal(out.event.type, 'run-result');
});

test('models groups flatten to modelsFetched', () => {
  const out = adapter.toReactMessage({
    type: 'models',
    groups: [
      { providerId: 'sleepyai', providerName: 'SleepyAI', configured: true, models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] },
      { providerId: 'compat', providerName: 'Compat', configured: false, models: [] },
    ],
    selected: 'a',
    defaultProvider: 'sleepyai',
  });
  assert.equal(out.type, 'modelsFetched');
  assert.deepEqual(out.models, ['a', 'b']);
  assert.equal(out.modelList.length, 2);
  assert.equal(out.modelList[0].id, 'a');
  assert.equal(out.modelList[0].name, 'A');
});

test('models with string ids still produce a model list', () => {
  const out = adapter.toReactMessage({ type: 'models', groups: [{ providerId: 'p', providerName: 'P', models: ['x', 'y'] }] });
  assert.deepEqual(out.models, ['x', 'y']);
  assert.equal(out.modelList[0].id, 'x');
});

test('conversations payload maps to React list', () => {
  const out = adapter.toReactMessage({
    type: 'conversations',
    activeId: 'c1',
    conversations: [{ id: 'c1', title: 'One', updatedAt: 5, archived: false, running: true }],
  });
  assert.equal(out.type, 'conversations');
  assert.equal(out.activeId, 'c1');
  assert.equal(out.list.length, 1);
  assert.equal(out.list[0].id, 'c1');
  assert.equal(out.list[0].title, 'One');
  assert.deepEqual(out.runningConvIds, ['c1']);
});

test('conversation items map to loadConversation turns', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [
      { id: 'i1', role: 'user', text: 'hello', timestamp: 1 },
      { id: 'i2', role: 'assistant', text: 'hi there', timestamp: 2, model: 'm1' },
    ],
  });
  assert.equal(out.type, 'loadConversation');
  assert.equal(out.activeId, 'c1');
  assert.equal(out.turns.length, 2);
  assert.equal(out.turns[0].role, 'user');
  assert.equal(out.turns[0].text, 'hello');
  assert.equal(out.turns[1].role, 'assistant');
  assert.equal(out.turns[1].blocks[0].kind, 'text');
  assert.equal(out.turns[1].blocks[0].text, 'hi there');
});

test('assistant work items become tool blocks', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [{
      id: 'i1', role: 'assistant', text: 'done', timestamp: 1,
      work: [{ kind: 'task', text: 'read it', tool: 'read_file', done: true }],
    }],
  });
  const blocks = out.turns[0].blocks;
  // Work happens before the answer, so tool blocks precede the final text.
  assert.equal(blocks[0].kind, 'tool');
  assert.equal(blocks[0].name, 'Read');
  assert.equal(blocks[0].status, 'completed');
  assert.equal(blocks[1].kind, 'text');
  assert.equal(blocks[1].text, 'done');
});

test('assistant reasoning work becomes thinking block', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [{ id: 'i1', role: 'assistant', text: 'answer', timestamp: 1, work: [{ kind: 'reasoning', text: 'thinking...' }] }],
  });
  const blocks = out.turns[0].blocks;
  assert.equal(blocks[0].kind, 'thinking');
  assert.equal(blocks[0].text, 'thinking...');
});

test('error transcript items become error blocks', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [{ id: 'i1', role: 'assistant', text: '', timestamp: 1, kind: 'error', errorInfo: { message: 'failed hard' } }],
  });
  const blocks = out.turns[0].blocks;
  assert.equal(blocks[0].kind, 'error');
  assert.equal(blocks[0].message, 'failed hard');
});

test('divider transcript items are skipped', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [
      { id: 'd1', role: 'assistant', text: '', timestamp: 1, kind: 'divider' },
      { id: 'i2', role: 'user', text: 'after divider', timestamp: 2 },
    ],
  });
  assert.equal(out.turns.length, 1);
  assert.equal(out.turns[0].text, 'after divider');
});

test('modelsError maps to a React error event', () => {
  const out = adapter.toReactMessage({ type: 'modelsError', text: 'no models' });
  assert.equal(out.type, 'agentEvent');
  assert.equal(out.event.type, 'error');
  assert.equal(out.event.message, 'no models');
});

test('untranslatable internal messages are dropped', () => {
  assert.equal(adapter.toReactMessage({ type: 'browserPreview', dataUrl: 'x' }), null);
  assert.equal(adapter.toReactMessage({ type: 'modelsLoading' }), null);
});

// ---------------------------------------------------------------- initialState

test('initialState builds a React bootstrap payload', () => {
  const out = adapter.buildInitialState({ activeId: 'c1', workspaceRoot: '/w', selectedModel: 'm1' });
  assert.equal(out.type, 'initialState');
  assert.equal(out.mode, 'agent');
  assert.equal(out.selectedModel, 'm1');
  assert.equal(out.activeId, 'c1');
  assert.deepEqual(out.turns, []);
  assert.deepEqual(out.personas, []);
  assert.equal(out.hasProviders, true);
  assert.equal(out.workspaceRoot, '/w');
});

// ---------------------------------------------------------------- approvals

test('notify approval maps to approvalRequest', () => {
  const out = adapter.toReactMessage({
    type: 'notify', id: 7, title: 'Run tests?', detail: 'npm test',
    okLabel: 'Allow once', cancelLabel: 'Deny', risk: 'medium',
    approval: { id: 7, conversationId: 'c1', kind: 'command', command: 'npm test' },
  });
  assert.equal(out.type, 'approvalRequest');
  assert.equal(out.convId, 'c1');
  assert.equal(out.request.requestId, '7');
  assert.equal(out.request.subject, 'Run tests?');
  assert.equal(out.request.detail, 'npm test');
  assert.equal(out.request.actionType, 'shell');
});

test('notify for an edit uses the edits action type', () => {
  const out = adapter.toReactMessage({
    type: 'notify', id: 9, title: 'Edit file?', detail: 'write src/a.ts',
    approval: { id: 9, conversationId: 'c1', kind: 'edit' },
  });
  assert.equal(out.request.actionType, 'edits');
});

test('resolveApproval approve -> notifyResponse ok', () => {
  const out = adapter.toSleepyMessage({ type: 'resolveApproval', requestId: '7', approve: true });
  assert.deepEqual(out, { type: 'notifyResponse', id: 7, choice: 'ok' });
});

test('resolveApproval deny -> notifyResponse cancel', () => {
  const out = adapter.toSleepyMessage({ type: 'resolveApproval', requestId: '7', approve: false });
  assert.deepEqual(out, { type: 'notifyResponse', id: 7, choice: 'cancel' });
});

// ---------------------------------------------------------------- plan + tool names

test('plan work items render as a WritePlan card', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [{
      id: 'i1', role: 'assistant', text: 'done', timestamp: 1,
      work: [{ kind: 'plan', text: '', title: 'Ship it', steps: ['a', 'b'], activeStep: 1, doneSteps: [0] }],
    }],
  });
  const block = out.turns[0].blocks[0];
  assert.equal(block.kind, 'tool');
  assert.equal(block.name, 'WritePlan');
  assert.equal(block.input.title, 'Ship it');
  assert.match(block.input.content, /a/);
  assert.equal(block.status, 'running');
});

test('a finished plan is marked completed', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [{
      id: 'i1', role: 'assistant', text: '', timestamp: 1,
      work: [{ kind: 'plan', text: '', title: 'P', steps: ['a'], activeStep: -1, doneSteps: [0] }],
    }],
  });
  assert.equal(out.turns[0].blocks[0].status, 'completed');
});

test('live plan tool events use the React tool name', () => {
  const out = adapter.toReactMessage({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'plan', name: 'Plan' });
  assert.equal(out.event.name, 'WritePlan');
});

test('sleepycode tool names map to their React equivalents', () => {
  const map = (tool) => adapter.toReactMessage({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't', tool, name: tool }).event.name;
  assert.equal(map('read_file'), 'Read');
  assert.equal(map('write_file'), 'Write');
  assert.equal(map('replace_text'), 'StrReplace');
  assert.equal(map('run_command'), 'Shell');
  assert.equal(map('search_files'), 'Grep');
  assert.equal(map('list_files'), 'Glob');
  assert.equal(map('get_diagnostics'), 'ReadLints');
});

// ---------------------------------------------------------------- usage

test('loadConversation derives usedTokens from the last context count', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [
      { id: 'i1', role: 'user', text: 'hi', timestamp: 1 },
      { id: 'i2', role: 'assistant', text: 'yo', timestamp: 2, contextTokens: 1234 },
    ],
  });
  assert.equal(out.usedTokens, 1234);
});

test('loadConversation falls back to zero without a context count', () => {
  const out = adapter.toReactMessage({ type: 'conversation', id: 'c1', items: [] });
  assert.equal(out.usedTokens, 0);
});

// ---------------------------------------------------------------- panels

test('panel rows reach the webview intact, including the ids row buttons need', () => {
  const out = adapter.toReactMessage({
    type: 'panel', panel: 'agents', hint: 'pick one',
    rows: [{ id: 'reviewer', title: 'A', detail: 'one' }, { title: 'B' }],
  });
  assert.equal(out.type, 'panel');
  assert.equal(out.panel, 'agents');
  assert.equal(out.hint, 'pick one');
  assert.deepEqual(out.rows, [{ id: 'reviewer', title: 'A', detail: 'one' }, { title: 'B' }]);
});

test('panel title reflects the panel kind', () => {
  assert.equal(adapter.panelTitle('worktrees'), 'Worktrees');
  assert.equal(adapter.panelTitle('checkpoints'), 'Undo History');
  assert.equal(adapter.panelTitle('mystery'), 'mystery');
});

test('a panel without rows still renders an empty screen', () => {
  const out = adapter.toReactMessage({ type: 'panel', panel: 'index' });
  assert.equal(out.type, 'panel');
  assert.deepEqual(out.rows, []);
});

test('showPanel names the panel the drawer should open', () => {
  assert.deepEqual(adapter.toReactMessage({ type: 'showPanel', panel: 'worktrees' }), {
    type: 'showPanel', panel: 'worktrees',
  });
});

test('panel row actions translate to the host messages the panels already use', () => {
  // The drawer's row buttons post SleepyCode's own messages; without a mapping
  // the adapter drops them and the button does nothing at all.
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'selectAgent', agentId: 'reviewer' }),
    { type: 'selectAgent', agentId: 'reviewer' },
  );
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'restoreCheckpoint', conversationId: 'conv-1', itemId: 'item-2' }),
    { type: 'restoreCheckpoint', conversationId: 'conv-1', itemId: 'item-2' },
  );
  // A row with no target must not reach the host as an empty selection.
  assert.equal(adapter.toSleepyMessage({ type: 'selectAgent', agentId: '' }), null);
  assert.equal(adapter.toSleepyMessage({ type: 'restoreCheckpoint', conversationId: '', itemId: 'item-2' }), null);
  assert.equal(adapter.toSleepyMessage({ type: 'restoreCheckpoint', conversationId: 'conv-1', itemId: '' }), null);
});

// ---------------------------------------------------------------- send handshake

test('sendMessage carries the request id so the host can acknowledge it', () => {
  const out = adapter.toSleepyMessage({ type: 'sendMessage', convId: null, text: 'hi', requestId: 'req-1' });
  assert.equal(out.type, 'send');
  assert.equal(out.requestId, 'req-1');
});

test('requestAccepted passes through to the webview', () => {
  const out = adapter.toReactMessage({ type: 'requestAccepted', requestId: 'req-1', convId: 'c9', created: true });
  assert.equal(out.type, 'requestAccepted');
  assert.equal(out.requestId, 'req-1');
  assert.equal(out.convId, 'c9');
  assert.equal(out.created, true);
});

// ---------------------------------------------------------------- streaming guard

test('transcript snapshots are skipped while the conversation is streaming', () => {
  const snapshot = { type: 'conversation', id: 'c1', items: [{ id: 'i', role: 'user', text: 'x', timestamp: 1 }] };
  // A mid-run snapshot would replace the live turns and erase streamed text.
  assert.equal(adapter.toReactMessageWhileStreaming(snapshot, true), null);
});

test('transcript snapshots flow once the run is over', () => {
  const snapshot = { type: 'conversation', id: 'c1', items: [{ id: 'i', role: 'user', text: 'x', timestamp: 1 }] };
  const out = adapter.toReactMessageWhileStreaming(snapshot, false);
  assert.equal(out.type, 'loadConversation');
  assert.equal(out.turns.length, 1);
});

test('streaming deltas are never suppressed', () => {
  const out = adapter.toReactMessageWhileStreaming({ type: 'delta', conversationId: 'c1', text: 'a' }, true);
  assert.equal(out.type, 'agentEvent');
  assert.equal(out.event.text, 'a');
});

test('streaming guard still drops untranslatable messages', () => {
  assert.equal(adapter.toReactMessageWhileStreaming({ type: 'modelsLoading' }, false), null);
});

// ---------------------------------------------------------------- live run signals

test('retry maps to the React retry event', () => {
  const out = adapter.toReactMessage({ type: 'retry', conversationId: 'c1', attempt: 2, max: 5, error: 'timeout', backoffMs: 800 });
  assert.equal(out.type, 'agentEvent');
  assert.equal(out.event.type, 'retry');
  assert.equal(out.event.attempt, 2);
  assert.equal(out.event.max, 5);
  assert.equal(out.event.delayMs, 800);
  assert.equal(out.event.error, 'timeout');
});

test('retryEnd is dropped so a successful retry leaves no empty error card', () => {
  assert.equal(adapter.toReactMessage({ type: 'retryEnd', conversationId: 'c1', ok: true, attempt: 2, max: 5 }), null);
  // A failed retry already surfaces through the run's error event.
  assert.equal(adapter.toReactMessage({ type: 'retryEnd', conversationId: 'c1', ok: false, attempt: 5, max: 5 }), null);
});

test('steered maps to the user-steering event', () => {
  const out = adapter.toReactMessage({ type: 'steered', conversationId: 'c1' });
  assert.equal(out.event.type, 'user-steering');
});

test('liveUsage maps to the usage event', () => {
  const out = adapter.toReactMessage({
    type: 'liveUsage', conversationId: 'c1', model: 'm1',
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4,
  });
  assert.equal(out.event.type, 'usage');
  assert.equal(out.event.promptTokens, 10);
  assert.equal(out.event.completionTokens, 20);
  assert.equal(out.event.totalTokens, 30);
  assert.equal(out.event.model, 'm1');
});

test('workPhase maps to a shell-notify status line', () => {
  const out = adapter.toReactMessage({ type: 'workPhase', conversationId: 'c1', first: 'Reading files' });
  assert.equal(out.event.type, 'shell-notify');
  assert.equal(out.event.message, 'Reading files');
});

test('permission requests map to an approval request', () => {
  const out = adapter.toReactMessage({ type: 'permission', conversationId: 'c1', permissionId: 'p1', title: 'Allow write?' });
  assert.equal(out.type, 'approvalRequest');
  assert.equal(out.convId, 'c1');
  assert.equal(out.request.requestId, 'p1');
  assert.equal(out.request.subject, 'Allow write?');
});

// ---------------------------------------------------------------- remaining outgoing

test('cancelRun maps to stop', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'cancelRun', convId: 'c1' }), { type: 'stop' });
});

test('fetchModels maps to refreshModels', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'fetchModels' }), { type: 'refreshModels' });
});

test('openFile carries the path and optional line', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openFile', path: 'src/a.ts' }), { type: 'openFile', path: 'src/a.ts' });
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openFile', path: 'src/a.ts', startLine: 12 }), { type: 'openFile', path: 'src/a.ts', line: 12 });
});

test('openMention opens the mentioned path', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openMention', kind: 'file', path: 'src/b.ts' }), { type: 'openFile', path: 'src/b.ts' });
});

test('browseAttachments maps to the file picker', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'browseAttachments' }), { type: 'requestFilePicker' });
});

test('openSettings requests the settings surface', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openSettings' }), { type: 'requestSettings' });
});

test('openSettings carries the section it was asked for', () => {
  // Dropping it landed every jump on General, so "Get started" and "Add models"
  // both opened the wrong page.
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'openSettings', section: 'mcp' }),
    { type: 'requestSettings', section: 'mcp' },
  );
  // No section still means "whatever the window opens on".
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openSettings', section: undefined }), { type: 'requestSettings' });
});

test('openLog requests extension logs', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openLog' }), { type: 'requestExtensionLogs' });
});

test('searchFiles maps to a mention query', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'searchFiles', query: 'app', requestId: 1 }), { type: 'fileMentionQuery', query: 'app' });
});

test('selectConversation maps to openConversation', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'selectConversation', id: 'c3' }), { type: 'openConversation', id: 'c3' });
});

test('deleteConversation passes through', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'deleteConversation', id: 'c3' }), { type: 'deleteConversation', id: 'c3' });
});

test('messages with no SleepyCode counterpart are dropped', () => {
  // Both were closed since this test was written: updateChatWorkspace is
  // persisted and setMode is applied as a tool policy.
  // Only setPersona and OpenCursor-internal types remain unmapped.
  for (const type of ['setPersona']) {
    assert.equal(adapter.toSleepyMessage({ type }), null, `${type} should be dropped`);
  }
});

// ---------------------------------------------------------------- sign-in nudge

test('signed-out status asks for a sign-in offer', () => {
  assert.equal(adapter.shouldOfferSignIn({ type: 'sleepyStatus', loggedIn: false }), true);
});

test('signed-in or in-progress status does not', () => {
  assert.equal(adapter.shouldOfferSignIn({ type: 'sleepyStatus', loggedIn: true }), false);
  assert.equal(adapter.shouldOfferSignIn({ type: 'sleepyStatus', loggedIn: false, busy: true }), false);
  assert.equal(adapter.shouldOfferSignIn({ type: 'delta', text: 'x' }), false);
  assert.equal(adapter.shouldOfferSignIn(null), false);
});

// ---------------------------------------------------------------- pending changes

test('conversation file changes become pending changes', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [{
      id: 'i1', role: 'assistant', text: 'edited', timestamp: 1,
      changes: [
        { path: 'src/a.ts', action: 'Modified', additions: 4, deletions: 2 },
        { path: 'src/new.ts', action: 'Created', additions: 9 },
        { path: 'src/gone.ts', action: 'Deleted' },
      ],
    }],
  });
  assert.equal(out.changes.length, 3);
  assert.deepEqual(out.changes[0], { path: 'src/a.ts', existedBefore: true, added: 4, removed: 2 });
  assert.equal(out.changes[1].existedBefore, false);
  assert.equal(out.changes[2].existedBefore, true);
});

test('reverted changes are left out of pending changes', () => {
  const out = adapter.toReactMessage({
    type: 'conversation',
    id: 'c1',
    items: [{ id: 'i1', role: 'assistant', text: '', timestamp: 1, changes: [{ path: 'a.ts', action: 'Modified', reverted: true }] }],
  });
  assert.deepEqual(out.changes, []);
});

test('conversations without changes report an empty list', () => {
  const out = adapter.toReactMessage({ type: 'conversation', id: 'c1', items: [{ id: 'i', role: 'user', text: 'x', timestamp: 1 }] });
  assert.deepEqual(out.changes, []);
});

test('pendingChangesMessage wraps the latest turn changes', () => {
  const out = adapter.pendingChangesMessage([
    { id: 'i1', role: 'assistant', text: '', timestamp: 1, changes: [{ path: 'src/a.ts', action: 'Modified', additions: 1 }] },
  ]);
  assert.equal(out.type, 'pendingChanges');
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].path, 'src/a.ts');
});

test('pendingChangesMessage is empty without changes', () => {
  assert.deepEqual(adapter.pendingChangesMessage(undefined).changes, []);
});

// ---------------------------------------------------------------- change review target

test('latestAssistantItemId finds the newest assistant item', () => {
  const items = [
    { id: 'a', role: 'assistant' },
    { id: 'u', role: 'user' },
    { id: 'b', role: 'assistant' },
    { id: 'u2', role: 'user' },
  ];
  assert.equal(adapter.latestAssistantItemId(items), 'b');
});

test('latestAssistantItemId is undefined without an assistant turn', () => {
  assert.equal(adapter.latestAssistantItemId([{ id: 'u', role: 'user' }]), undefined);
  assert.equal(adapter.latestAssistantItemId(undefined), undefined);
});

// ---------------------------------------------------------------- attachments

test('sendMessage carries attachments through to the host', () => {
  const out = adapter.toSleepyMessage({
    type: 'sendMessage', text: 'look',
    attachments: [{ id: '1', name: 'shot.png', mime: 'image/png', data: 'data:image/png;base64,AAA', kind: 'image' }],
  });
  assert.equal(out.attachments.length, 1);
  assert.equal(out.attachments[0].name, 'shot.png');
});

test('image attachments are split out for materialising', () => {
  const split = adapter.reactAttachmentsOf([
    { id: '1', name: 'shot.png', mime: 'image/png', data: 'data:image/png;base64,AAA', kind: 'image' },
    { id: '2', name: 'notes.txt', mime: 'text/plain', data: 'hello', kind: 'text' },
  ]);
  assert.equal(split.images.length, 1);
  assert.equal(split.images[0].dataUrl, 'data:image/png;base64,AAA');
  assert.equal(split.images[0].mimeType, 'image/png');
  assert.equal(split.files.length, 0);
});

test('non-image and malformed attachments are not treated as images', () => {
  const split = adapter.reactAttachmentsOf([
    { id: '1', name: 'notes.txt', kind: 'text', data: 'plain text' },
    { id: '2', name: 'broken', kind: 'image', data: 'not-a-data-url' },
    undefined,
    null,
  ]);
  assert.deepEqual(split.images, []);
});

test('reactAttachmentsOf tolerates a missing list', () => {
  assert.deepEqual(adapter.reactAttachmentsOf(undefined), { images: [], files: [] });
});

// ---------------------------------------------------------------- mentions

test('attached-file tags become SleepyCode file context', () => {
  const out = adapter.toSleepyMessage({
    type: 'sendMessage',
    text: 'explain <attached type="file" title="app.ts" content="src/app.ts" /> please',
  });
  const files = (out.attachments || []).filter(a => a.kind === 'file');
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/app.ts');
});

test('mention tags are stripped from the text sent to the model', () => {
  const out = adapter.toSleepyMessage({
    type: 'sendMessage',
    text: 'explain <attached type="file" title="app.ts" content="src/app.ts" /> please',
  });
  // Tag removal collapses the gap it leaves behind.
  assert.equal(out.text, 'explain please');
  assert.ok(!out.text.includes('<attached'));
});

test('plain messages are left exactly as typed', () => {
  const out = adapter.toSleepyMessage({ type: 'sendMessage', text: '  keep my spacing  ' });
  assert.equal(out.text, '  keep my spacing  ');
});

test('mentions merge with real attachments', () => {
  const out = adapter.toSleepyMessage({
    type: 'sendMessage',
    text: 'see <attached type="file" title="a" content="a.ts" />',
    attachments: [{ id: '1', name: 'shot.png', mime: 'image/png', data: 'data:image/png;base64,AAA', kind: 'image' }],
  });
  assert.equal(out.attachments.length, 2);
});

// ---------------------------------------------------------------- React fallbacks

test('usage and the marketplace are served by the settings window', () => {
  // Both used to be dead ends; the settings window has a section for each.
  assert.equal(adapter.reactFallbackFor({ type: 'showUsage' }), null);
  assert.equal(adapter.reactFallbackFor({ type: 'showMarketplace' }), null);
});

test('the fallback mechanism still works for an unported surface', () => {
  // No command needs it today; it must not silently rot before the next one.
  assert.equal(adapter.reactFallbackFor({ type: 'delta', text: 'x' }), null);
});

test('other messages have no fallback', () => {
  assert.equal(adapter.reactFallbackFor({ type: 'delta', text: 'x' }), null);
  assert.equal(adapter.reactFallbackFor({ type: 'conversation', id: 'c' }), null);
});

// ---------------------------------------------------------------- queue + steering

test('steering a running chat becomes another send', () => {
  const out = adapter.toSleepyMessage({ type: 'steerMessage', convId: 'c1', text: 'also do X' });
  assert.equal(out.type, 'send');
  assert.equal(out.text, 'also do X');
  assert.equal(out.conversationId, 'c1');
});

test('queue remove maps to removeQueued', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'queueAction', convId: 'c1', id: 'q1', action: 'remove' }), { type: 'removeQueued', conversationId: 'c1', id: 'q1' });
});

test('queue steer maps to steerQueued', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'queueAction', convId: 'c1', id: 'q1', action: 'steer' }), { type: 'steerQueued', conversationId: 'c1', id: 'q1' });
});

test('queue run maps to promoteQueued so the row actually runs next', () => {
  // "Send queued request now" and "Resume interrupted request" both post `run`.
  // The host decides between aborting the current run and starting this entry.
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'queueAction', convId: 'c1', id: 'q2', action: 'run' }),
    { type: 'promoteQueued', conversationId: 'c1', id: 'q2' },
  );
});

test('queue up maps to moveQueued', () => {
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'queueAction', convId: 'c1', id: 'q2', action: 'up' }),
    { type: 'moveQueued', conversationId: 'c1', id: 'q2' },
  );
});

test('an id-less queue action still names its conversation', () => {
  // Rows React created optimistically, and "enter on an empty editor runs the
  // next queued", have no host id yet — the host resolves the conversation's
  // first entry rather than doing nothing.
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'queueAction', convId: 'c1', action: 'run' }),
    { type: 'promoteQueued', conversationId: 'c1', id: undefined },
  );
});

test('the two queue actions that are handled in the webview are dropped here', () => {
  // `edit` pulls the text back into the composer (React owns the draft and the
  // attachments) and `down` is not offered by any row. Neither has a host
  // counterpart, so translating them would invent one.
  for (const action of ['edit', 'down']) {
    assert.equal(adapter.toSleepyMessage({ type: 'queueAction', convId: 'c1', id: 'q1', action }), null, `${action} should be dropped`);
  }
});

// ---------------------------------------------------------------- approval placement

test('approvals attach to their tool card when a call id is known', () => {
  const out = adapter.toReactMessage({
    type: 'notify', id: 3, title: 'Run tests?', detail: 'npm test', toolCallId: 'call-7',
    approval: { id: 3, conversationId: 'c1', kind: 'command' },
  });
  assert.equal(out.request.callId, 'call-7');
});

test('approvals without a tool call still reach the webview', () => {
  const out = adapter.toReactMessage({
    type: 'notify', id: 3, title: 'Delete it?', detail: '',
    approval: { id: 3, conversationId: 'c1', kind: 'edit' },
  });
  assert.equal(out.type, 'approvalRequest');
  assert.equal(out.request.callId, undefined);
});

// ---------------------------------------------------------------- approval preset

test('React approval presets map onto SleepyCode modes', () => {
  assert.equal(adapter.approvalModeForPreset('ask'), 'ask');
  assert.equal(adapter.approvalModeForPreset('review'), 'edits');
  assert.equal(adapter.approvalModeForPreset('allow'), 'autonomous');
});

test('an unknown preset leaves the mode unchanged', () => {
  assert.equal(adapter.approvalModeForPreset('mystery'), undefined);
  assert.equal(adapter.approvalModeForPreset(undefined), undefined);
});

// ---------------------------------------------------------------- config

test('the config message becomes configState for React', () => {
  const out = adapter.toReactMessage({ type: 'config', model: 'm1', provider: 'sleepyai', approvalMode: 'edits' });
  assert.equal(out.type, 'configState');
  assert.equal(out.hasProviders, true);
  assert.deepEqual(out.personas, []);
});

test('approval mode is reflected in the config payload', () => {
  const out = adapter.toReactMessage({ type: 'config', approvalMode: 'autonomous' });
  assert.equal(out.approvalMode, 'autonomous');
});

// ---------------------------------------------------------------- tool payloads

test('a tool args string is parsed into the React tool input', () => {
  const out = adapter.toReactMessage({
    type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'write_file',
    name: 'Writing files…', args: '{"path":"src/a.ts","content":"x"}',
  });
  assert.equal(out.event.input.path, 'src/a.ts');
});

test('tool results are carried onto the completed card', () => {
  const out = adapter.toReactMessage({
    type: 'tool', conversationId: 'c1', phase: 'end', id: 't1', tool: 'run_command',
    args: '{"command":"npm test"}', result: 'ok', failed: false,
  });
  assert.equal(out.event.status, 'completed');
  assert.equal(out.event.result, 'ok');
  assert.equal(out.event.input.command, 'npm test');
});

test('a malformed args string does not break the event', () => {
  const out = adapter.toReactMessage({ type: 'tool', conversationId: 'c1', phase: 'start', id: 't1', tool: 'read_file', args: '{not json' });
  assert.equal(out.event.type, 'tool-call-started');
  assert.deepEqual(out.event.input, {});
});

// ---------------------------------------------------------------- continue run

test('continue targets the newest assistant turn', () => {
  const target = adapter.continueTarget('c1', [
    { id: 'u', role: 'user' },
    { id: 'a1', role: 'assistant' },
  ]);
  assert.deepEqual(target, { conversationId: 'c1', itemId: 'a1' });
});

test('continue is unavailable without a conversation or assistant turn', () => {
  assert.equal(adapter.continueTarget(undefined, [{ id: 'a', role: 'assistant' }]), null);
  assert.equal(adapter.continueTarget('c1', [{ id: 'u', role: 'user' }]), null);
  assert.equal(adapter.continueTarget('c1', undefined), null);
});

// ---------------------------------------------------------------- approval policy

test('SleepyCode approval modes become a real React policy', () => {
  const ask = adapter.approvalPolicyForMode('ask');
  assert.equal(ask.shell.mode, 'ask');
  assert.equal(ask.edits.mode, 'ask');
  assert.deepEqual(ask.shell.allowlist, []);

  const edits = adapter.approvalPolicyForMode('edits');
  assert.equal(edits.edits.mode, 'review');
  assert.equal(edits.shell.mode, 'review');

  const autonomous = adapter.approvalPolicyForMode('autonomous');
  assert.equal(autonomous.shell.mode, 'allow');
  assert.equal(autonomous.edits.mode, 'allow');
});

test('every action type is present so the picker never reads undefined', () => {
  const policy = adapter.approvalPolicyForMode('ask');
  for (const action of ['shell', 'edits', 'delete', 'mcp', 'web', 'outside']) {
    assert.ok(policy[action], `${action} missing`);
  }
});

test('an unknown mode falls back to the safe ask policy', () => {
  assert.equal(adapter.approvalPolicyForMode('mystery').shell.mode, 'ask');
  assert.equal(adapter.approvalPolicyForMode(undefined).shell.mode, 'ask');
});

test('configState carries the policy so the picker shows the current preset', () => {
  const out = adapter.toReactMessage({ type: 'config', approvalMode: 'autonomous' });
  assert.equal(out.approvalPolicy.shell.mode, 'allow');
});

// ---------------------------------------------------------------- run notices

test('compaction progress becomes a compaction event', () => {
  const running = adapter.toReactMessage({ type: 'compactProgress', conversationId: 'c1', phase: 'summarizing' });
  assert.equal(running.event.type, 'compaction');
  assert.equal(running.event.status, 'running');

  const done = adapter.toReactMessage({ type: 'compactProgress', conversationId: 'c1', phase: 'done', text: 'summary here' });
  assert.equal(done.event.status, 'done');
  assert.equal(done.event.summary, 'summary here');

  const failed = adapter.toReactMessage({ type: 'compactProgress', conversationId: 'c1', phase: 'error' });
  assert.equal(failed.event.status, 'failed');
});

test('a cancelled compaction does not claim success', () => {
  const out = adapter.toReactMessage({ type: 'compactProgress', conversationId: 'c1', phase: 'cancelled' });
  // There is no "cancelled" block in the React transcript, and claiming "done"
  // would say the context was summarized when it was not.
  assert.equal(out.event.status, 'failed');
});

test('queued prompts become the React queue', () => {
  const out = adapter.toReactMessage({ type: 'queuedPrompt', conversationId: 'c1', prompts: ['first', 'second'], ids: ['q1', 'q2'] });
  assert.equal(out.type, 'workflowState');
  assert.equal(out.queues.c1.length, 2);
  assert.equal(out.queues.c1[0].text, 'first');
  assert.equal(out.queues.c1[0].id, 'q1');
  assert.equal(out.queues.c1[0].status, 'queued');
  assert.equal(typeof out.queues.c1[0].createdAt, 'number');
});

test('an empty queue clears the React queue', () => {
  const out = adapter.toReactMessage({ type: 'queuedPrompt', conversationId: 'c1', prompts: [], ids: [] });
  assert.deepEqual(out.queues.c1, []);
});

test('a queue without ids still produces addressable rows', () => {
  const out = adapter.toReactMessage({ type: 'queuedPrompt', conversationId: 'c1', prompts: ['only'] });
  assert.equal(out.queues.c1.length, 1);
  assert.ok(out.queues.c1[0].id, 'a queued row needs an id to be removable');
});

// ---------------------------------------------------------------- workflow state
//
// React replaces BOTH of its maps from the one `workflowState` message. A
// partial publish is therefore a delete: sending only queues called
// `setGoals(undefined)` and dropped the goal banner, and sending only goals
// emptied every queued row. These pin the complete message.

test('the workflow message carries every conversation and the goals together', () => {
  const out = adapter.toReactMessage({
    type: 'workflow',
    queues: { c1: [{ id: 'q1', text: 'first' }], c2: [{ id: 'q2', text: 'other tab' }] },
    goals: { c1: { objective: 'ship it', status: 'active' } },
  });
  assert.equal(out.type, 'workflowState');
  // Both conversations, so switching tabs does not show an empty queue.
  assert.deepEqual(Object.keys(out.queues).sort(), ['c1', 'c2']);
  assert.equal(out.queues.c2[0].text, 'other tab');
  assert.deepEqual(out.goals, { c1: { objective: 'ship it', status: 'active' } });
});

test('a workflow message with no goals clears them explicitly', () => {
  // `{}` and not `undefined`: React reads the key it is handed, and a missing
  // key is what wiped the banner.
  const out = adapter.toReactMessage({ type: 'workflow', queues: {}, goals: {} });
  assert.deepEqual(out.goals, {});
  assert.deepEqual(out.queues, {});
});

test('a malformed workflow payload degrades to empty state, never to undefined', () => {
  for (const message of [{ type: 'workflow' }, { type: 'workflow', queues: null, goals: null }, { type: 'workflow', queues: [], goals: 7 }]) {
    const out = adapter.toReactMessage(message);
    assert.equal(out.type, 'workflowState');
    assert.deepEqual(out.queues, {}, `queues for ${JSON.stringify(message)}`);
    assert.deepEqual(out.goals, {}, `goals for ${JSON.stringify(message)}`);
  }
});

test('a context notice is surfaced rather than dropped', () => {
  const out = adapter.toReactMessage({
    type: 'contextNotice', conversationId: 'c1', kind: 'trimmed',
    text: 'Older history was trimmed to keep this conversation within memory limits.',
  });
  // React has no persistent notice block, but silence would hide a real change
  // to what the model can see.
  assert.equal(out.event.type, 'shell-notify');
  assert.match(out.event.message, /trimmed/);
});

test('a failed settings save becomes an error event', () => {
  const out = adapter.toReactMessage({ type: 'settingsResult', ok: false, text: 'bad value' });
  assert.equal(out.event.type, 'error');
  assert.equal(out.event.message, 'bad value');
});

test('a successful settings save needs no event', () => {
  assert.equal(adapter.toReactMessage({ type: 'settingsResult', ok: true, text: 'Settings saved.' }), null);
});

test('a routed model is reported so Auto is not silent', () => {
  const out = adapter.toReactMessage({ type: 'modelRoute', conversationId: 'c1', requested: 'auto', model: 'm1', reason: 'cheapest' });
  assert.equal(out.event.type, 'shell-notify');
  assert.match(out.event.message, /m1/);
});

test('reasoningEnd needs no mapping: thinking closes on the next delta', () => {
  // applyToBlocks closes a thinking block on text-delta and tool-call-started,
  // so a dedicated event would be redundant.
  assert.equal(adapter.toReactMessage({ type: 'reasoningEnd' }), null);
});

// ---------------------------------------------------------------- conversation search

test('searchConversations reaches the host', () => {
  const out = adapter.toSleepyMessage({ type: 'searchConversations', query: 'auth', archived: false, requestId: 4 });
  assert.equal(out.type, 'searchConversations');
  assert.equal(out.query, 'auth');
  assert.equal(out.requestId, 4);
});

test('conversation search matches the title', () => {
  const list = adapter.searchConversationSummaries(
    [{ id: 'c1', title: 'Fix the auth flow', items: [] }],
    'auth',
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'c1');
});

test('conversation search matches message text and returns an excerpt', () => {
  const list = adapter.searchConversationSummaries(
    [{ id: 'c1', title: 'Unrelated', items: [{ role: 'user', text: 'the parser drops trailing commas' }] }],
    'trailing',
  );
  assert.equal(list.length, 1);
  assert.match(list[0].excerpt, /trailing commas/);
});

test('conversation search is case-insensitive and empty queries match everything', () => {
  const items = [{ id: 'c1', title: 'Alpha', items: [] }, { id: 'c2', title: 'Beta', items: [] }];
  assert.equal(adapter.searchConversationSummaries(items, 'ALPHA').length, 1);
  assert.equal(adapter.searchConversationSummaries(items, '   ').length, 2);
});

test('conversation search respects the archived filter', () => {
  const items = [
    { id: 'c1', title: 'Live', items: [] },
    { id: 'c2', title: 'Old', archived: true, items: [] },
  ];
  assert.deepEqual(adapter.searchConversationSummaries(items, '', false).map(c => c.id), ['c1']);
  assert.deepEqual(adapter.searchConversationSummaries(items, '', true).map(c => c.id), ['c2']);
});

test('conversation search results carry the request id back', () => {
  const out = adapter.conversationSearchResults(9, [{ id: 'c1', title: 'Alpha', items: [] }], 'alpha');
  assert.equal(out.type, 'conversationSearchResults');
  assert.equal(out.requestId, 9);
  assert.equal(out.list.length, 1);
});

test('conversation search tolerates missing text', () => {
  const list = adapter.searchConversationSummaries([{ id: 'c1' }, { id: 'c2', items: [{}] }], 'x');
  assert.deepEqual(list, []);
});

// ---------------------------------------------------------------- bulk change review

test('acceptAllChanges stages every pending file', () => {
  const out = adapter.bulkChangeMessages('acceptAllChanges', 'c1', 'i1', ['a.ts', 'b.ts']);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'gitStageChanges');
  assert.deepEqual(out[0].paths, ['a.ts', 'b.ts']);
});

test('rejectAllChanges reverts every pending file individually', () => {
  const out = adapter.bulkChangeMessages('rejectAllChanges', 'c1', 'i1', ['a.ts', 'b.ts']);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(m => m.path), ['a.ts', 'b.ts']);
  assert.ok(out.every(m => m.type === 'gitRevertFile'));
});

test('bulk actions with nothing pending do nothing', () => {
  assert.deepEqual(adapter.bulkChangeMessages('acceptAllChanges', 'c1', 'i1', []), []);
  assert.deepEqual(adapter.bulkChangeMessages('rejectAllChanges', 'c1', 'i1', undefined), []);
});

test('bulk actions without a conversation target are refused', () => {
  // Staging or reverting the wrong turn's files is worse than doing nothing.
  assert.deepEqual(adapter.bulkChangeMessages('acceptAllChanges', undefined, undefined, ['a.ts']), []);
  assert.deepEqual(adapter.bulkChangeMessages('rejectAllChanges', 'c1', undefined, ['a.ts']), []);
});

// ---------------------------------------------------------------- misc actions

test('logError reaches the host so webview failures are visible', () => {
  const out = adapter.toSleepyMessage({ type: 'logError', message: 'boom', info: 'stack' });
  assert.equal(out.type, 'logError');
  assert.equal(out.message, 'boom');
});

test('openBrowserTab reaches the host', () => {
  const out = adapter.toSleepyMessage({ type: 'openBrowserTab', url: 'https://example.test' });
  assert.equal(out.type, 'openBrowserTab');
  assert.equal(out.url, 'https://example.test');
});

test('mention search reuses the file query for file-like categories', () => {
  const out = adapter.toSleepyMessage({ type: 'searchMentions', kind: 'files', query: 'app', requestId: 2 });
  assert.equal(out.type, 'fileMentionQuery');
  assert.equal(out.query, 'app');
});

test('mention categories SleepyCode cannot search are dropped, not guessed', () => {
  // docs/chats/branch/terminals have no SleepyCode equivalent; answering them
  // with file hits would put the wrong thing in the composer.
  for (const kind of ['docs', 'chats', 'branch', 'terminals', 'code']) {
    assert.equal(adapter.toSleepyMessage({ type: 'searchMentions', kind, query: 'x', requestId: 3 }), null, `${kind} should be dropped`);
  }
});

// ---------------------------------------------------------------- drafts and tabs

test('updateChatWorkspace is kept for the host to persist', () => {
  const out = adapter.toSleepyMessage({ type: 'updateChatWorkspace', state: { drafts: {} } });
  assert.equal(out.type, 'updateChatWorkspace');
  assert.deepEqual(out.state, { drafts: {} });
});

test('a draft survives the round trip', () => {
  const merged = adapter.mergeWorkspaceState(
    { openTabs: [], drafts: {} },
    { drafts: { c1: { text: 'half-typed thought', attachments: [] } } },
  );
  assert.equal(merged.drafts.c1.text, 'half-typed thought');
});

test('a partial update leaves the other half alone', () => {
  const merged = adapter.mergeWorkspaceState(
    { openTabs: ['a', 'b'], drafts: { a: { text: 'x', attachments: [] } } },
    { openTabs: ['a'] },
  );
  assert.deepEqual(merged.openTabs, ['a']);
  assert.equal(merged.drafts.a.text, 'x', 'a tabs-only update must not drop drafts');
});

test('clearing drafts is respected rather than merged', () => {
  const merged = adapter.mergeWorkspaceState({ openTabs: [], drafts: { a: { text: 'x', attachments: [] } } }, { drafts: {} });
  assert.deepEqual(merged.drafts, {});
});

test('oversized image data is not persisted', () => {
  // Drafts live in globalState, which is not meant to hold megabytes of base64.
  const big = 'data:image/png;base64,' + 'A'.repeat(400_000);
  const state = adapter.toStorableWorkspaceState({
    openTabs: ['c1'],
    drafts: { c1: { text: 'keep me', attachments: [{ id: '1', name: 'shot.png', mime: 'image/png', data: big, kind: 'image' }] } },
  });
  assert.equal(state.drafts.c1.text, 'keep me');
  // The image is dropped and the user is told, rather than silently losing it.
  assert.equal(state.drafts.c1.attachments.length, 0);
  assert.equal(state.trimmed, true);
});

test('small attachments are kept', () => {
  const state = adapter.toStorableWorkspaceState({
    openTabs: [],
    drafts: { c1: { text: 'x', attachments: [{ id: '1', name: 'a.txt', mime: 'text/plain', data: 'small', kind: 'text' }] } },
  });
  assert.equal(state.drafts.c1.attachments.length, 1);
  assert.equal(state.trimmed, false);
});

test('junk workspace state is tolerated', () => {
  assert.deepEqual(adapter.toStorableWorkspaceState(undefined).openTabs, []);
  assert.deepEqual(adapter.toStorableWorkspaceState({ drafts: 'nope' }).drafts, {});
});

// ---------------------------------------------------------------- export

test('a conversation exports to markdown with its turns in order', () => {
  const md = adapter.conversationToMarkdown({
    title: 'Fix the parser',
    updatedAt: Date.UTC(2026, 0, 2, 3, 4),
    items: [
      { id: 'i1', role: 'user', text: 'why does it drop commas', timestamp: 1 },
      { id: 'i2', role: 'assistant', text: 'Because the lexer stops early.', timestamp: 2, model: 'm1' },
    ],
  });
  assert.match(md, /^# Fix the parser/m);
  assert.match(md, /why does it drop commas/);
  assert.match(md, /Because the lexer stops early\./);
  // Order matters: the user's question comes before the answer.
  assert.ok(md.indexOf('why does it drop commas') < md.indexOf('Because the lexer'));
});

test('the export records which model produced an answer', () => {
  const md = adapter.conversationToMarkdown({
    title: 't', items: [{ id: 'a', role: 'assistant', text: 'hi', timestamp: 2, model: 'sleepy/auto' }],
  });
  assert.match(md, /sleepy\/auto/);
});

test('tool activity is summarised without internal ids', () => {
  const md = adapter.conversationToMarkdown({
    title: 't',
    items: [{
      id: 'a', role: 'assistant', text: 'done', timestamp: 2,
      work: [{ kind: 'task', tool: 'read_file', text: 'read src/app.ts', done: true }],
    }],
  });
  assert.match(md, /read_file|Read/);
  assert.ok(!md.includes('callId'), 'internal ids should not leak into an export');
});

test('a plan exports as its steps', () => {
  const md = adapter.conversationToMarkdown({
    title: 't',
    items: [{
      id: 'a', role: 'assistant', text: '', timestamp: 1,
      work: [{ kind: 'plan', title: 'Ship it', steps: ['one', 'two'], doneSteps: [0], activeStep: 1 }],
    }],
  });
  assert.match(md, /Ship it/);
  assert.match(md, /\[x\] one/);
  assert.match(md, /\[ \] two/);
});

test('errors are exported as errors, not as empty turns', () => {
  const md = adapter.conversationToMarkdown({
    title: 't',
    items: [{ id: 'a', role: 'assistant', text: '', timestamp: 1, kind: 'error', errorInfo: { message: 'rate limited' } }],
  });
  assert.match(md, /rate limited/);
});

test('edited files are listed at the end of their turn', () => {
  const md = adapter.conversationToMarkdown({
    title: 't',
    items: [{
      id: 'a', role: 'assistant', text: 'fixed', timestamp: 1,
      changes: [{ path: 'src/a.ts', action: 'Modified', additions: 3, deletions: 1 }],
    }],
  });
  assert.match(md, /src\/a\.ts/);
  assert.match(md, /\+3/);
});

test('compaction dividers are not exported as content', () => {
  const md = adapter.conversationToMarkdown({
    title: 't',
    items: [
      { id: 'd', role: 'assistant', text: '', timestamp: 1, kind: 'divider' },
      { id: 'u', role: 'user', text: 'after the divider', timestamp: 2 },
    ],
  });
  assert.match(md, /after the divider/);
  assert.equal(md.match(/^## /gm)?.length, 1, 'the divider should not add a section');
});

test('an empty conversation still exports a valid document', () => {
  const md = adapter.conversationToMarkdown({ title: '', items: [] });
  assert.match(md, /^# /m);
  assert.ok(md.length > 0);
});

test('the export filename is safe on every platform', () => {
  const name = adapter.exportFileName('Fix: the/parser "bug"?  \n on Windows');
  assert.ok(!/[\\/:*?"<>|\n]/.test(name), `unsafe characters in ${name}`);
  assert.match(name, /\.md$/);
  assert.ok(name.length <= 80, `too long: ${name.length}`);
});

test('an empty or symbol-only title still yields a usable filename', () => {
  assert.match(adapter.exportFileName(''), /^conversation.*\.md$/);
  assert.match(adapter.exportFileName('///'), /^conversation.*\.md$/);
});

// ---------------------------------------------------------------- subagents

test('a subagent start becomes a Task tool card', () => {
  const out = adapter.toReactMessage({
    type: 'subagent', conversationId: 'c1', id: 'sub-1', role: 'explorer',
    task: 'find the parser', name: 'Subagent (explorer): find the parser', phase: 'start',
  });
  assert.equal(out.event.type, 'tool-call-started');
  assert.equal(out.event.callId, 'sub-1');
  // React only renders its subagent card for the Task tool name.
  assert.equal(out.event.name, 'Task');
  assert.equal(out.event.input.role, 'explorer');
  assert.match(out.event.input.task, /find the parser/);
});

test('a finished subagent completes the Task card', () => {
  const out = adapter.toReactMessage({
    type: 'subagent', conversationId: 'c1', id: 'sub-1', role: 'explorer',
    task: 't', phase: 'end', ok: true, result: 'found it',
  });
  assert.equal(out.event.type, 'tool-call-completed');
  assert.equal(out.event.status, 'completed');
  assert.match(out.event.result, /found it/);
});

test('a failed subagent completes the Task card as an error', () => {
  const out = adapter.toReactMessage({
    type: 'subagent', conversationId: 'c1', id: 'sub-1', role: 'worker', task: 't', phase: 'end', ok: false, error: 'boom',
  });
  assert.equal(out.event.status, 'error');
  assert.match(out.event.result, /boom/);
});

test('cancelSubagent reaches the host with the subagent id', () => {
  const out = adapter.toSleepyMessage({ type: 'cancelSubagent', callId: 'sub-1', reason: 'user' });
  assert.equal(out.type, 'cancelSubagent');
  assert.equal(out.callId, 'sub-1');
});

// ---------------------------------------------------------------- modes

test('setMode reaches the host', () => {
  const out = adapter.toSleepyMessage({ type: 'setMode', mode: 'ask' });
  assert.equal(out.type, 'setMode');
  assert.equal(out.mode, 'ask');
});

test('ask and plan modes are read-only: every mutating tool is blocked', () => {
  const mutating = ['write_file', 'replace_text', 'delete_file', 'run_command', 'terminal_start', 'skillsmp_install_skill', 'worktree_create'];
  for (const mode of ['ask', 'plan']) {
    for (const tool of mutating) {
      assert.equal(adapter.isToolAllowedInMode(mode, tool), false, `${tool} must be blocked in ${mode}`);
    }
  }
});

test('ask and plan modes keep the read-only tools', () => {
  for (const mode of ['ask', 'plan']) {
    for (const tool of ['read_file', 'list_files', 'search_files', 'get_diagnostics', 'plan', 'delegate_task', 'web_search', 'browser_snapshot', 'browser_inspect']) {
      assert.equal(adapter.isToolAllowedInMode(mode, tool), true, `${tool} should stay available in ${mode}`);
    }
  }
});

test('driving a browser is an action, so ask and plan cannot do it', () => {
  // Reading a page is an observation; navigating, clicking, typing and
  // evaluating change external state the user has not approved.
  for (const mode of ['ask', 'plan']) {
    for (const tool of ['browser_navigate', 'browser_click', 'browser_type', 'browser_evaluate']) {
      assert.equal(adapter.isToolAllowedInMode(mode, tool), false, `${tool} must be blocked in ${mode}`);
    }
  }
});

test('agent mode allows everything', () => {
  for (const tool of ['write_file', 'run_command', 'delete_file', 'read_file']) {
    assert.equal(adapter.isToolAllowedInMode('agent', tool), true, `${tool} should be allowed in agent mode`);
  }
});

test('an unknown mode is treated as read-only rather than unrestricted', () => {
  // Guessing "agent" for an unrecognised mode would silently grant write access.
  assert.equal(adapter.isToolAllowedInMode('mystery', 'write_file'), false);
  assert.equal(adapter.isToolAllowedInMode(undefined, 'run_command'), false);
  assert.equal(adapter.isToolAllowedInMode('mystery', 'read_file'), true);
});

test('approval only applies to agent mode', () => {
  // Approval governs edits and commands, which only agent mode can perform.
  assert.equal(adapter.approvalAppliesInMode('agent'), true);
  assert.equal(adapter.approvalAppliesInMode('ask'), false);
  assert.equal(adapter.approvalAppliesInMode('plan'), false);
  assert.equal(adapter.approvalAppliesInMode(undefined), false);
});

test('initialState carries the mode so the picker reflects reality', () => {
  const out = adapter.buildInitialState({ mode: 'plan' });
  assert.equal(out.mode, 'plan');
});

// ---------------------------------------------------------------- mode coverage

// The real tool set, read from src/tools.ts so this cannot drift from the code.
const realTools = await import('node:fs/promises').then(async (fs) => {
  const src = await fs.readFile(new URL('../src/tools.ts', import.meta.url), 'utf8');
  const literal = [...src.matchAll(/\n    ([a-z_]+): tool\(\{/g)].map((m) => m[1]);
  const assigned = [...src.matchAll(/tools\.([a-z_]+) = tool\(/g)].map((m) => m[1]);
  return [...new Set([...literal, ...assigned])].sort();
});

test('the real tool set was found', () => {
  assert.ok(realTools.length > 30, `only found ${realTools.length} tools: ${realTools.join(',')}`);
});

test('read-only modes withhold every tool that changes something', () => {
  const mutating = realTools.filter((tool) => !adapter.isToolAllowedInMode('ask', tool));
  // Every mutating tool must be one we deliberately classified, never a
  // read-only tool caught by an over-broad prefix.
  const expected = [
    'browser_back', 'browser_click', 'browser_close', 'browser_close_tab', 'browser_evaluate',
    'browser_forward', 'browser_navigate', 'browser_new_tab', 'browser_press', 'browser_reload',
    'browser_scroll', 'browser_switch_tab', 'browser_type', 'browser_wait',
    'delete_file', 'github_commit', 'github_open_pr', 'github_pr_comment', 'github_start_from_issue',
    'memory_update', 'replace_text', 'run_command', 'skillsmp_install_skill',
    'terminal_start', 'terminal_stop', 'terminal_write',
    'worktree_create', 'worktree_merge', 'worktree_remove', 'worktree_run',
    'write_file',
    // Withheld in ask (ask writes nothing) but granted to plan, which must be
    // able to save the plan it produced.
    'write_plan',
  ];
  assert.deepEqual(mutating, expected.sort());
});

test('read-only modes keep every observation tool', () => {
  const readOnly = realTools.filter((tool) => adapter.isToolAllowedInMode('plan', tool));
  for (const tool of ['read_file', 'list_files', 'search_files', 'get_diagnostics', 'plan', 'web_search', 'repo_search', 'repo_symbol', 'browser_snapshot', 'browser_screenshot', 'terminal_read', 'terminal_list', 'memory_read', 'github_list_issues', 'worktree_list', 'worktree_status', 'skillsmp_search']) {
    assert.ok(readOnly.includes(tool), `${tool} should stay available in plan mode`);
  }
});

test('plan mode may use write_plan from the real tool set, and ask may not', () => {
  assert.ok(realTools.includes('write_plan'), 'write_plan should exist');
  assert.equal(adapter.isToolAllowedInMode('plan', 'write_plan'), true);
  assert.equal(adapter.isToolAllowedInMode('ask', 'write_plan'), false);
  // The grant must not open general writing.
  assert.equal(adapter.isToolAllowedInMode('plan', 'write_file'), false);
});

test('agent mode withholds nothing from the real tool set', () => {
  assert.deepEqual(realTools.filter((tool) => !adapter.isToolAllowedInMode('agent', tool)), []);
});

// ---------------------------------------------------------------- ask the user

test('answerQuestion reaches the host', () => {
  const out = adapter.toSleepyMessage({ type: 'answerQuestion', callId: 'call-1', answers: { '0': ['yes'] } });
  assert.equal(out.type, 'answerQuestion');
  assert.equal(out.callId, 'call-1');
  assert.deepEqual(out.answers, { '0': ['yes'] });
});

test('the ask tool renders as the React question card', () => {
  // React only renders QuestionCard for this tool name, so the mapping is what
  // makes an answered question visible at all.
  assert.equal(adapter.reactToolName('ask_user'), 'AskQuestion');
});

test('a question start carries the questions React needs', () => {
  const out = adapter.toReactMessage({
    type: 'tool', conversationId: 'c1', phase: 'start', id: 'call-1', tool: 'ask_user',
    args: JSON.stringify({ header: 'Clarify', questions: [{ question: 'Which file?', options: ['a.ts', 'b.ts'] }] }),
  });
  assert.equal(out.event.type, 'tool-call-started');
  assert.equal(out.event.name, 'AskQuestion');
  assert.equal(out.event.input.header, 'Clarify');
  assert.equal(out.event.input.questions.length, 1);
  assert.deepEqual(out.event.input.questions[0].options, ['a.ts', 'b.ts']);
});

test('answered questions are echoed back so the card shows the choice', () => {
  const out = adapter.questionAnswered('c1', 'call-1', { '0': ['a.ts'] });
  assert.equal(out.type, 'questionAnswered');
  assert.equal(out.convId, 'c1');
  assert.equal(out.callId, 'call-1');
  assert.deepEqual(out.answers, { '0': ['a.ts'] });
});

test('asking the user is allowed in read-only modes', () => {
  // Asking is how the agent avoids guessing; it changes nothing itself.
  for (const mode of ['agent', 'ask', 'plan']) {
    assert.equal(adapter.isToolAllowedInMode(mode, 'ask_user'), true, `ask_user must be allowed in ${mode}`);
  }
});

// ---------------------------------------------------------------- no workspace

test('an error keeps the conversation it belongs to', () => {
  // Posting an error with no conversation id files it under the placeholder
  // session, which is not the active one — so it renders nowhere. That is why a
  // send with no folder open produced no run, no stream and no message.
  const out = adapter.toReactMessage({ type: 'error', conversationId: 'c1', text: 'Open a folder first.' });
  assert.equal(out.convId, 'c1');
  assert.equal(out.event.type, 'error');
});

test('configState says whether a workspace is open', () => {
  const open = adapter.toReactMessage({ type: 'config', workspaceRoot: '/repo', canSend: true });
  assert.equal(open.workspaceRoot, '/repo');
  assert.equal(open.canSend, true);

  const none = adapter.toReactMessage({ type: 'config' });
  assert.equal(none.canSend, false);
  assert.equal(none.workspaceRoot, undefined);
});

test('initialState says whether a workspace is open', () => {
  assert.equal(adapter.buildInitialState({ workspaceRoot: '/repo' }).canSend, true);
  assert.equal(adapter.buildInitialState({}).canSend, false);
});

test('the no-workspace explanation is actionable', () => {
  const text = adapter.noWorkspaceMessage();
  assert.match(text, /folder|workspace/i);
  // It must tell the user what to do, not just that something failed.
  assert.match(text, /open/i);
});

// ---------------------------------------------------------------- mode on send

test('the mode the composer shows is carried with the message', () => {
  // React sends `mode` on every sendMessage. Dropping it meant the run used the
  // stored per-conversation mode, which could still be `agent` — so Ask mode
  // wrote files.
  const out = adapter.toSleepyMessage({ type: 'sendMessage', convId: 'c1', text: 'hi', mode: 'ask' });
  assert.equal(out.mode, 'ask');
});

test('an invalid mode is not forwarded', () => {
  const out = adapter.toSleepyMessage({ type: 'sendMessage', text: 'hi', mode: 'bogus' });
  assert.equal(out.mode, undefined);
});

test('the run mode prefers the composer, then the conversation, then the last choice', () => {
  // Order matters: the composer is what the user is looking at right now.
  assert.equal(adapter.resolveRunMode({ messageMode: 'ask', conversationMode: 'agent', lastMode: 'plan' }), 'ask');
  assert.equal(adapter.resolveRunMode({ conversationMode: 'plan', lastMode: 'ask' }), 'plan');
  assert.equal(adapter.resolveRunMode({ lastMode: 'ask' }), 'ask');
});

test('with nothing recorded the mode is agent', () => {
  assert.equal(adapter.resolveRunMode({}), 'agent');
  assert.equal(adapter.resolveRunMode(undefined), 'agent');
});

test('a bogus stored mode does not grant agent silently', () => {
  // An unrecognised value must fall through to the next source, not to `agent`,
  // because `agent` is the one mode that can write.
  assert.equal(adapter.resolveRunMode({ messageMode: 'nope', conversationMode: 'nope', lastMode: 'plan' }), 'plan');
  assert.equal(adapter.resolveRunMode({ messageMode: 'nope', conversationMode: 'nope' }), 'agent');
});

// ---------------------------------------------------------------- approval visibility

test('the approval control is hidden wherever approval cannot apply', () => {
  // Display and enforcement must be the same rule: the composer showed an
  // approval picker in ask/plan while the host ignored it, which is exactly the
  // contradiction that made Ask mode look broken.
  for (const mode of ['ask', 'plan']) {
    assert.equal(adapter.approvalAppliesInMode(mode), false, `${mode} must hide it`);
  }
  assert.equal(adapter.approvalAppliesInMode('agent'), true);
});

// ---------------------------------------------------------------- plan files

test('a plan path is extracted from a plain path result', () => {
  assert.equal(adapter.planPathFromResult('.sleepycode/plans/add-auth.md'), '.sleepycode/plans/add-auth.md');
});

test('a plan path survives a prose prefix', () => {
  assert.equal(adapter.planPathFromResult('wrote plan to .plans/x.md'), '.plans/x.md');
  assert.equal(adapter.planPathFromResult('Wrote the plan to .sleepycode/plans/x.md.'), '.sleepycode/plans/x.md');
});

test('a serialized tool result is never mistaken for a path', () => {
  // This is the ENAMETOOLONG crash: the whole JSON blob was passed to openFile.
  const blob = JSON.stringify({
    type: 'tool-result', toolCallId: 'call-1', toolName: 'write_plan',
    input: { title: 'Something Fishy', content: '# long markdown…' },
    output: 'Wrote the plan to .sleepycode/plans/x.md', dynamic: false,
  });
  assert.equal(adapter.planPathFromResult(blob), undefined);
});

test('anything that is not a relative markdown path is rejected', () => {
  for (const value of ['', '   ', 'nothing', 'read the file first', '/abs/path.md', 'a/b.txt', 'a b/c.md']) {
    assert.equal(adapter.planPathFromResult(value), undefined, `${value} should be rejected`);
  }
});

test('a path that tries to escape is rejected', () => {
  assert.equal(adapter.planPathFromResult('../../etc/passwd.md'), undefined);
  assert.equal(adapter.planPathFromResult('.sleepycode/../../x.md'), undefined);
});

test('a multi-line result is not a path', () => {
  assert.equal(adapter.planPathFromResult('.sleepycode/plans/x.md\nand more'), undefined);
});

test('missing results are handled', () => {
  assert.equal(adapter.planPathFromResult(undefined), undefined);
  assert.equal(adapter.planPathFromResult(''), undefined);
});

test('every plan tool name is recognised, from the host and from the mapping', () => {
  // SleepyCode has `plan` (stateful card) and `write_plan` (plan file); the
  // React card answers to the mapped name.
  for (const name of ['plan', 'write_plan', 'WritePlan']) {
    assert.equal(adapter.isPlanToolName(name), true, `${name} should be a plan tool`);
  }
  for (const name of ['read_file', 'Read', 'write_file', '']) {
    assert.equal(adapter.isPlanToolName(name), false, `${name} is not a plan tool`);
  }
});

// ---------------------------------------------------------------- authoritative plan state

test('the host plan message drives the plan card', () => {
  // SleepyCode posts authoritative plan state as `type: 'plan'`, and it was
  // dropped entirely — so the live card could only come from history, where a
  // progress-only work item has no steps and rendered as "(empty plan)".
  const out = adapter.toReactMessage({
    type: 'plan', conversationId: 'c1', title: 'Something Fishy',
    steps: ['Goal', 'Rules', 'CLI'], activeStep: 1, doneSteps: [0], done: false,
  });
  assert.equal(out.event.type, 'tool-call-started');
  assert.equal(out.event.name, 'WritePlan');
  assert.equal(out.event.input.title, 'Something Fishy');
  assert.deepEqual(out.event.input.steps, ['Goal', 'Rules', 'CLI']);
  assert.deepEqual(out.event.input.doneSteps, [0]);
  assert.equal(out.event.input.done, false);
});

test('repeated plan posts address the same card, so they update instead of stacking', () => {
  const first = adapter.toReactMessage({ type: 'plan', conversationId: 'c1', steps: ['a'], activeStep: 0 });
  const second = adapter.toReactMessage({ type: 'plan', conversationId: 'c1', activeStep: 1, doneSteps: [0] });
  assert.equal(first.event.callId, second.event.callId);
  assert.equal(first.event.callId, 'plan:c1');
});

test('a completed plan is marked done so the Implement button can appear', () => {
  const out = adapter.toReactMessage({ type: 'plan', conversationId: 'c1', steps: ['a'], done: true });
  assert.equal(out.event.input.done, true);
});

test('a plan post without steps does not blank the card', () => {
  // The input is merged by the reducer, so an omitted field must stay omitted
  // rather than being sent as an empty array.
  const out = adapter.toReactMessage({ type: 'plan', conversationId: 'c1', activeStep: 2 });
  assert.equal(out.event.input.steps, undefined);
  assert.equal(out.event.input.title, undefined);
});

// ---------------------------------------------------------------- persistTurns

test('persistTurns reaches the host', () => {
  const out = adapter.toSleepyMessage({ type: 'persistTurns', convId: 'c1', turns: [{ role: 'user', text: 'hi' }] });
  assert.equal(out.type, 'persistTurns');
  assert.equal(out.conversationId, 'c1');
  assert.equal(out.turns.length, 1);
});

test('recovered turns become transcript items', () => {
  const items = adapter.turnsToItems([
    { role: 'user', text: 'hi' },
    { role: 'assistant', blocks: [{ kind: 'text', text: 'hello' }, { kind: 'tool', name: 'Read', status: 'completed', result: 'file' }] },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].role, 'user');
  assert.equal(items[0].text, 'hi');
  assert.equal(items[1].text, 'hello');
  assert.equal(items[1].work[0].tool, 'Read');
});

test('recovery keeps an error turn as an error', () => {
  const items = adapter.turnsToItems([{ role: 'assistant', blocks: [{ kind: 'error', message: 'boom' }] }]);
  assert.equal(items[0].kind, 'error');
  assert.equal(items[0].errorInfo.message, 'boom');
});

test('recovery tolerates junk', () => {
  assert.deepEqual(adapter.turnsToItems(undefined), []);
  assert.deepEqual(adapter.turnsToItems([null, {}]), []);
});

// ---------------------------------------------------------------- rename & pin
//
// The host has implemented both for a while; the React conversation list simply
// never offered them, so a thread could be archived but not named or kept.
// `pinned` also had to travel, or the list cannot show which ones are kept.

test('the conversation list carries the pinned flag', () => {
  const out = adapter.toReactMessage({
    type: 'conversations',
    activeId: 'c1',
    conversations: [
      { id: 'c1', title: 'Kept', updatedAt: 2, pinned: true },
      { id: 'c2', title: 'Not kept', updatedAt: 1 },
    ],
  });
  assert.equal(out.list[0].pinned, true);
  // Absent must read as false rather than undefined, so the star has one shape.
  assert.equal(out.list[1].pinned, false);
  // Archiving still travels independently.
  const archived = adapter.toReactMessage({ type: 'conversations', conversations: [{ id: 'c3', archived: true, updatedAt: 5 }] });
  assert.equal(archived.list[0].archivedAt, 5);
  assert.equal(archived.list[0].pinned, false);
});

test('rename and pin translate to the host messages that already exist', () => {
  // With a title: the page supplies it. Without: the host opens its own input
  // box, so an empty title must not be sent as an empty rename.
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'renameConversation', id: 'c1', title: 'New name' }),
    { type: 'renameConversation', id: 'c1', title: 'New name' },
  );
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'renameConversation', id: 'c1' }),
    { type: 'renameConversation', id: 'c1', title: undefined },
  );
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'togglePinConversation', id: 'c1' }),
    { type: 'togglePinConversation', id: 'c1' },
  );
});

test('a rename or pin with no conversation named is refused', () => {
  // Renaming "" would silently do nothing host-side; refusing here keeps the
  // "posts a message that cannot work" class closed.
  assert.equal(adapter.toSleepyMessage({ type: 'renameConversation' }), null);
  assert.equal(adapter.toSleepyMessage({ type: 'renameConversation', id: '' }), null);
  assert.equal(adapter.toSleepyMessage({ type: 'togglePinConversation' }), null);
  assert.equal(adapter.toSleepyMessage({ type: 'togglePinConversation', id: '' }), null);
});

// ---------------------------------------------------------------- reasoning effort
//
// `selectReasoningEffort` was mapped inbound but nothing ever forwarded the
// CURRENT level, so a picker could not show which one was active — and the
// composer had no picker at all.

test('the effort levels travel as options the picker can render', () => {
  const options = adapter.effortOptions();
  assert.equal(options.length, 7);
  assert.deepEqual(options.map(o => o.id), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  for (const option of options) {
    assert.ok(option.label, `${option.id} needs a label`);
    assert.ok(option.hint, `${option.id} needs a hint`);
  }
  assert.equal(options[0].label, 'None');
  // Order is the model's own scale, not alphabetical.
  assert.equal(options[6].id, 'max');
});

test('the current reasoning level reaches the composer', () => {
  const out = adapter.toReactMessage({ type: 'config', reasoningEffort: 'high' });
  assert.equal(out.reasoningEffort, 'high');
  assert.deepEqual(out.reasoningEfforts.map(o => o.id), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('an unrecognised or missing level falls back to the default rather than undefined', () => {
  // A picker with nothing selected looks broken; `none` is what the host sends
  // when nothing is stored.
  assert.equal(adapter.toReactMessage({ type: 'config' }).reasoningEffort, 'none');
  assert.equal(adapter.toReactMessage({ type: 'config', reasoningEffort: 'nonsense' }).reasoningEffort, 'none');
  assert.equal(adapter.toReactMessage({ type: 'config', reasoningEffort: 7 }).reasoningEffort, 'none');
});

test('initialState carries the level too, so the first paint is right', () => {
  const out = adapter.buildInitialState({ reasoningEffort: 'medium' });
  assert.equal(out.reasoningEffort, 'medium');
  assert.equal(adapter.buildInitialState({}).reasoningEffort, 'none');
});

test('choosing a level posts the message the host already handles', () => {
  assert.deepEqual(
    adapter.toSleepyMessage({ type: 'selectReasoningEffort', effort: 'xhigh' }),
    { type: 'selectReasoningEffort', effort: 'xhigh' },
  );
});

// ---------------------------------------------------------------- agent picker
//
// The classic composer had an agent menu; the React one had no selector at all,
// so changing agent meant the Agents panel (a command) or typing @agent-id blind.

test('the agent list and the selected agent reach the composer', () => {
  const out = adapter.toReactMessage({
    type: 'config',
    agentId: 'apex',
    agents: [{ id: 'default', name: 'SleepyCode' }, { id: 'apex', name: 'Apex (Builder)' }],
  });
  assert.equal(out.agentId, 'apex');
  assert.deepEqual(out.agentOptions.map(o => o.id), ['default', 'apex']);
  // The label is the short one the menu shows, not the stored name.
  assert.equal(out.agentOptions[1].name, 'Apex');
  assert.equal(out.agentOptions[1].role, 'Build');
});

test('a missing agent list is an empty list, not undefined', () => {
  // A picker that receives undefined renders nothing at all, which reads as a
  // missing feature rather than an empty one.
  const out = adapter.toReactMessage({ type: 'config', agentId: 'default' });
  assert.deepEqual(out.agentOptions, []);
  assert.equal(out.agentId, 'default');
});

test('initialState carries the agents so the first paint has a picker', () => {
  const out = adapter.buildInitialState({
    agentId: 'forge',
    agents: [{ id: 'forge', name: 'Forge (Reviewer)' }],
  });
  assert.equal(out.agentId, 'forge');
  assert.equal(out.agentOptions[0].name, 'Forge');
  assert.equal(out.agentOptions[0].role, 'Review');
});

test('selecting an agent posts the message the host already handles', () => {
  assert.deepEqual(adapter.toSleepyMessage({ type: 'selectAgent', agentId: 'pivot' }), { type: 'selectAgent', agentId: 'pivot' });
  assert.equal(adapter.toSleepyMessage({ type: 'selectAgent', agentId: '' }), null);
});

test('openPanel is refused for a panel that does not exist', () => {
  // The host builds the rows for whatever it is asked for; an unknown id would
  // reach it as a request it cannot serve.
  assert.deepEqual(adapter.toSleepyMessage({ type: 'openPanel', panel: 'worktrees' }), { type: 'openPanel', panel: 'worktrees' });
  assert.equal(adapter.toSleepyMessage({ type: 'openPanel', panel: 'marketplace' }), null);
  assert.equal(adapter.toSleepyMessage({ type: 'openPanel' }), null);
});

test('pendingChanges names the turn that made them', () => {
  // Every change action resolves its files through a conversation AND a turn.
  // Turns carry no id in the webview, so the host — which tracks the latest
  // assistant item — has to send it.
  const items = [
    { id: 'u1', role: 'user', text: 'do it' },
    { id: 'a1', role: 'assistant', text: 'done', changes: [{ path: 'a.ts', action: 'Modified' }] },
  ];
  const out = adapter.pendingChangesMessage(items);
  assert.equal(out.type, 'pendingChanges');
  assert.equal(out.changes.length, 1);
  assert.equal(out.itemId, 'a1', 'the assistant turn that made the change');
  // No changes means no target either, so the buttons stay disabled.
  assert.equal(adapter.pendingChangesMessage([{ id: 'u1', role: 'user', text: 'hi' }]).itemId, undefined);
});
