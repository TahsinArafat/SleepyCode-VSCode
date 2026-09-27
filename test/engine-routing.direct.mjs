// Which engine runs a conversation's next turn. Import-free so the routing
// rules can be tested without VS Code, a server, or a model.
import assert from 'node:assert/strict';
import test from 'node:test';

import { hasLocalHistory, usesCliEngine } from '../src/engine-routing-core.ts';

test('a new conversation uses the CLI when one is available', () => {
  assert.equal(usesCliEngine({ engineAvailable: true, boundToSession: false, hasLocalHistory: false }), true);
});

test('a conversation already living in the CLI stays there', () => {
  // Its items are a display mirror of CLI rows, not local history. If this were
  // judged on hasLocalHistory it would look local and get demoted mid-conversation.
  assert.equal(usesCliEngine({ engineAvailable: true, boundToSession: true, hasLocalHistory: true }), true);
});

test('a conversation with only transcript items goes to the CLI (items are a display mirror)', () => {
  // Items in a CLI conversation are projected from CLI rows. Treating them as
  // "local history" blocked the CLI on every conversation that had seen at least
  // one response, silently forking the session. The CLI is the primary engine
  // when available; only real local ToolLoopAgent state (messages[], pending)
  // pins a conversation to the local agent.
  assert.equal(usesCliEngine({ engineAvailable: true, boundToSession: false, hasLocalHistory: false }), true);
});

test('a conversation with local agent messages stays local even though a CLI is available', () => {
  // A conversation whose local ToolLoopAgent has written model messages cannot
  // be handed to the CLI: the CLI has no import route for those messages. The
  // user paid for those turns and we cannot replay them without charging again.
  assert.equal(usesCliEngine({ engineAvailable: true, boundToSession: false, hasLocalHistory: true }), false);
});

test('no CLI means local, whatever the history', () => {
  assert.equal(usesCliEngine({ engineAvailable: false, boundToSession: true, hasLocalHistory: false }), false);
});

test('history detection covers every place a turn can be left behind', () => {
  // Items alone are NOT local history — they are a display mirror.
  assert.equal(hasLocalHistory({ items: [], messages: undefined, pending: undefined }), false);
  assert.equal(hasLocalHistory({ items: [{ kind: 'user', text: 'hi' }], messages: undefined, pending: undefined }), false);
  // Structured messages from the local ToolLoopAgent ARE local history.
  assert.equal(hasLocalHistory({ items: [], messages: [{ role: 'user', content: 'hi' }], pending: undefined }), true);
  // An interrupted local run is unfinished work and must not be handed to the CLI.
  assert.equal(
    hasLocalHistory({
      items: [],
      messages: undefined,
      pending: { userText: 'hi', messages: [], startedAt: 0 },
    }),
    true,
  );
});

test('a conversation with CLI-projected items is routed to the CLI when the engine is available', () => {
  // CLI conversations carry items (display mirrors of CLI rows). They should
  // continue going to the CLI, not fall back to the local agent, when the
  // conversation is not yet bound (e.g. after a window reload resets the map).
  const conversation = { items: [{ kind: 'assistant', text: 'hello from CLI' }], messages: undefined, pending: undefined };
  assert.equal(usesCliEngine({ engineAvailable: true, boundToSession: false, hasLocalHistory: hasLocalHistory(conversation) }), true);
});

test('a conversation with real local messages stays local as the CLI comes and goes', () => {
  // The local agent has written model messages; those cannot be migrated.
  const conversation = { items: [], messages: [{ role: 'user', content: 'hi' }], pending: undefined };
  assert.equal(usesCliEngine({ engineAvailable: false, boundToSession: false, hasLocalHistory: hasLocalHistory(conversation) }), false);
  assert.equal(usesCliEngine({ engineAvailable: true, boundToSession: false, hasLocalHistory: hasLocalHistory(conversation) }), false);
});
