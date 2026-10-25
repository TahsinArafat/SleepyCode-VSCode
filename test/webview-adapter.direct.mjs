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
  assert.equal(out.event.name, 'read_file');
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
  assert.equal(blocks[0].name, 'read_file');
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
