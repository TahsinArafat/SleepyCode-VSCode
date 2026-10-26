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
  assert.equal(adapter.toSleepyMessage({ type: 'persistTurns', convId: 'c1', turns: [] }), null);
  assert.equal(adapter.toSleepyMessage({ type: 'unknownThing' }), null);
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

test('panel rows flatten to quick pick items', () => {
  const items = adapter.panelToQuickPickItems({
    type: 'panel', panel: 'tasks',
    rows: [{ title: 'A', detail: 'one' }, { title: 'B' }],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'A');
  assert.equal(items[0].description, 'one');
  assert.equal(items[1].label, 'B');
  assert.equal(items[1].description, undefined);
});

test('panel title reflects the panel kind', () => {
  assert.equal(adapter.panelTitle('worktrees'), 'Worktrees');
  assert.equal(adapter.panelTitle('checkpoints'), 'Undo History');
  assert.equal(adapter.panelTitle('mystery'), 'mystery');
});

test('empty panels produce no quick pick items', () => {
  assert.deepEqual(adapter.panelToQuickPickItems({ type: 'panel', panel: 'index', rows: [] }), []);
  assert.deepEqual(adapter.panelToQuickPickItems({ type: 'panel', panel: 'index' }), []);
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
  for (const type of ['setGoal', 'setMode', 'persistTurns', 'setPersona', 'getFileIcon', 'updateChatWorkspace']) {
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

test('usage and marketplace have no React screen, so they ask for a fallback', () => {
  assert.equal(adapter.reactFallbackFor({ type: 'showUsage' }), 'Usage & Billing');
  assert.equal(adapter.reactFallbackFor({ type: 'showMarketplace' }), 'Skill Marketplace');
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

test('unsupported queue actions are dropped', () => {
  for (const action of ['run', 'up', 'down', 'edit']) {
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
