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

test('a leftover local chat stays local even though a CLI is available', () => {
  // We deliberately do not migrate. The CLI has no route that accepts history we
  // cannot hand-write, and replaying it as prompts would re-run the model on
  // every old turn and invent a transcript that never happened.
  assert.equal(usesCliEngine({ engineAvailable: true, boundToSession: false, hasLocalHistory: true }), false);
});

test('no CLI means local, whatever the history', () => {
  assert.equal(usesCliEngine({ engineAvailable: false, boundToSession: true, hasLocalHistory: false }), false);
});

test('history detection covers every place a turn can be left behind', () => {
  assert.equal(hasLocalHistory({ items: [], messages: undefined, pending: undefined }), false);
  assert.equal(hasLocalHistory({ items: [{ kind: 'user', text: 'hi' }], messages: undefined, pending: undefined }), true);
  assert.equal(hasLocalHistory({ items: [], messages: [{ role: 'user', content: 'hi' }], pending: undefined }), true);
  // An interrupted run is unfinished work and must not be handed to the CLI.
  assert.equal(
    hasLocalHistory({
      items: [],
      messages: undefined,
      pending: { userText: 'hi', messages: [], startedAt: 0 },
    }),
    true,
  );
});

test('a conversation pinned local stays local as the CLI comes and goes', () => {
  // The engine starting up later must not silently move an existing chat across.
  const conversation = { items: [{ kind: 'user', text: 'hi' }], messages: undefined, pending: undefined };
  assert.equal(usesCliEngine({ engineAvailable: false, boundToSession: false, hasLocalHistory: hasLocalHistory(conversation) }), false);
  assert.equal(usesCliEngine({ engineAvailable: true, boundToSession: false, hasLocalHistory: hasLocalHistory(conversation) }), false);
});
