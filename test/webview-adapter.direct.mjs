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
