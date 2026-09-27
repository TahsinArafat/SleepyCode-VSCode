// Event-routing seams for the CLI client. These drive CliChatSession with a
// stub transport, so they assert sidebar behavior without a running server.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CliChatSession, CliSessionRegistry } from '../src/cli-engine.ts';

const HISTORY = [
  { info: { id: 'msg_user', role: 'user' }, parts: [{ id: 'prt_1', type: 'text', text: 'fix the build' }] },
  { info: { id: 'msg_asst', role: 'assistant' }, parts: [{ id: 'prt_2', type: 'text', text: 'on it' }] },
];

/** Minimal stand-in for CliClient that records updates and captures the SSE handler. */
function stubClient(history = HISTORY) {
  const updates = [];
  const permissions = [];
  const errors = [];
  let emit = () => { };
  return {
    updates,
    permissions,
    errors,
    emit: event => emit(event),
    client: {
      messages: async () => history,
      events: onEvent => {
        emit = onEvent;
        return Promise.resolve();
      },
    },
    onUpdate: items => updates.push(items),
    onError: message => errors.push(message),
    onPermission: permission => permissions.push(permission),
  };
}

async function openChat(overrides = {}) {
  const stub = stubClient();
  const chat = new CliChatSession(
    { ...stub.client, ...overrides },
    'ses_1',
    tool => tool,
    stub.onUpdate,
    stub.onError,
    stub.onPermission,
  );
  await chat.open();
  return { chat, stub };
}

test('an approval prompt shows the pending permission and keeps the transcript', async () => {
  const { stub } = await openChat();
  assert.ok(stub.updates.at(-1).length > 0, 'opening the chat should render history');

  // The CLI publishes Request as { id, sessionID, permission, patterns }.
  stub.emit({ type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'per_1', permission: 'bash' } });

  assert.equal(stub.permissions.length, 1, 'the approval prompt should reach the sidebar');
  assert.equal(stub.permissions[0].id, 'per_1');
  // Marking the session busy must not blank the conversation the user is reading.
  assert.ok(
    stub.updates.at(-1).length > 0,
    'a permission prompt must not wipe the transcript it is interrupting',
  );
});

test('a permission prompt for another session does not touch this sidebar', async () => {
  const { stub } = await openChat();
  const before = stub.updates.length;

  stub.emit({ type: 'permission.asked', properties: { sessionID: 'ses_other', id: 'per_9' } });

  assert.equal(stub.permissions.length, 0, 'another session\'s prompt is not ours to show');
  assert.equal(stub.updates.length, before, 'and must not republish our transcript');
});

test('session errors surface without clearing the transcript', async () => {
  const { stub } = await openChat();

  stub.emit({ type: 'session.error', properties: { sessionID: 'ses_1', error: 'provider exploded' } });

  assert.ok(stub.errors.includes('provider exploded'));
  assert.ok(stub.updates.at(-1).length > 0, 'a session error must not blank the history');
});

test('a session error surfaces the CLI message instead of a generic placeholder', async () => {
  // Observed against sleepy 0.1.19: the payload nests the detail under
  // data.message, so a `typeof === 'string'` check hides the real reason and
  // the user is left with "The CLI reported a session error."
  const { stub } = await openChat();

  stub.emit({
    type: 'session.error',
    properties: {
      sessionID: 'ses_1',
      error: { name: 'UnknownError', data: { message: 'Model not found: sleepy/auto-best-coding.' } },
    },
  });

  assert.ok(
    stub.errors.includes('Model not found: sleepy/auto-best-coding.'),
    `expected the real CLI message, got ${JSON.stringify(stub.errors)}`,
  );
});

test('an unrecognised session error shape still produces a readable message', async () => {
  const { stub } = await openChat();

  stub.emit({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'ProviderModelNotFoundError' } } });
  assert.ok(stub.errors.at(-1), 'a name-only payload must still say something');

  stub.emit({ type: 'session.error', properties: { sessionID: 'ses_1', error: undefined } });
  const fallback = stub.errors.at(-1);
  assert.equal(typeof fallback, 'string');
  assert.ok(fallback.length > 0, 'an empty payload must not produce an empty error');
  assert.ok(stub.updates.at(-1).length > 0, 'a session error must never blank the history');
});

test('a send carries the selected model so the CLI does not fall back to its own default', async () => {
  // Without a model the CLI resolves one from its own config, which on a fresh
  // install is `sleepy/auto-best-coding` -- a model that does not exist, so
  // every prompt fails with "Model not found".
  const sent = [];
  const { chat } = await openChat({
    prompt: async (id, text, model) => { sent.push({ id, text, model }); },
  });

  await chat.send('hi', { providerID: 'sleepy', modelID: 'claude-sonnet-4.6-thinking' });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].model, { providerID: 'sleepy', modelID: 'claude-sonnet-4.6-thinking' });
});

test('continuing an unfinished assistant resumes that turn with no new user message', async () => {
  const resumed = [];
  const { chat } = await openChat({
    messages: async () => [
      { info: { id: 'msg_user', role: 'user' }, parts: [{ id: 'p1', type: 'text', text: 'do it' }] },
      { info: { id: 'msg_asst', role: 'assistant' }, parts: [{ id: 'p2', type: 'text', text: 'half' }] },
    ],
    resumeTurn: async (sessionId, messageId) => {
      resumed.push([sessionId, messageId]);
    },
  });

  assert.equal(await chat.continueTurn(), true);
  assert.deepEqual(resumed, [['ses_1', 'msg_asst']], 'resume keys off the assistant id, not a fake user turn');
});

test('a completed turn is not resumable', async () => {
  const { chat } = await openChat({
    messages: async () => [
      { info: { id: 'msg_user', role: 'user' }, parts: [{ id: 'p1', type: 'text', text: 'do it' }] },
      { info: { id: 'msg_asst', role: 'assistant', finish: 'stop' }, parts: [{ id: 'p2', type: 'text', text: 'done' }] },
    ],
    resumeTurn: async () => assert.fail('a finished turn must not be resumed'),
  });

  assert.equal(await chat.continueTurn(), false);
});

test('the registry keeps one CLI session per conversation', () => {
  const store = new Map();
  const registry = new CliSessionRegistry({
    get: key => store.get(key),
    set: (key, value) => store.set(key, value),
  });

  registry.bind('conv_a', 'ses_a');
  registry.bind('conv_b', 'ses_b');
  assert.equal(registry.sessionFor('conv_a'), 'ses_a');
  assert.equal(registry.sessionFor('conv_b'), 'ses_b');

  // A conversation that never used the CLI must not inherit somebody else's
  // session, or the next chat opens showing the previous chat's history.
  assert.equal(registry.sessionFor('conv_new'), undefined);

  // A reopened sidebar restores each conversation to its own session.
  const reopened = new CliSessionRegistry({
    get: key => store.get(key),
    set: (key, value) => store.set(key, value),
  });
  assert.equal(reopened.sessionFor('conv_a'), 'ses_a');
  assert.equal(reopened.sessionFor('conv_b'), 'ses_b');
});

test('a slow refresh cannot overwrite the newer transcript it raced', async () => {
  // Every CLI event fires `void this.refresh()`, and each refresh is its own
  // async fetch. A run emits a burst of message.part.updated, so responses
  // overlap. If they are not ordered, a slow EARLIER request resolves after a
  // fast LATER one and republishes a stale snapshot. Nothing else arrives to
  // correct it, so the sidebar freezes on an old transcript -- the turn looks
  // stuck even though the CLI finished and holds the full answer.
  const early = [{ info: { id: 'm1', role: 'user' }, parts: [{ id: 'p1', type: 'text', text: 'hi' }] }];
  const late = [
    ...early,
    {
      info: { id: 'm2', role: 'assistant' },
      parts: [{ id: 'p2', type: 'text', text: 'the finished answer' }],
    },
  ];

  let call = 0;
  let hold = false;
  const stub = stubClient(early);
  const chat = new CliChatSession(
    {
      ...stub.client,
      messages: async () => {
        call += 1;
        // A request already in flight when the run is still streaming: it will
        // resolve AFTER the newer one below and republish an old snapshot.
        if (hold) {
          await new Promise(done => setTimeout(done, 60));
          return early;
        }
        return late;
      },
    },
    'ses_1',
    tool => tool,
    stub.onUpdate,
    stub.onError,
    stub.onPermission,
  );
  await chat.open();

  // The streaming burst: this refresh is issued first but is slow, so it
  // resolves last and lands on top of the fresher snapshot published after it.
  hold = true;
  stub.emit({ type: 'message.part.updated', properties: { sessionID: 'ses_1' } });
  await new Promise(done => setTimeout(done, 5));
  hold = false;
  stub.emit({ type: 'message.part.updated', properties: { sessionID: 'ses_1' } });
  await new Promise(done => setTimeout(done, 200));

  const last = stub.updates.at(-1);
  assert.equal(
    last.at(-1)?.text,
    'the finished answer',
    `the newest snapshot must win, got ${JSON.stringify(last.at(-1))}`,
  );
});

test('a corrupt registry does not stop the extension from starting', () => {
  const registry = new CliSessionRegistry({
    get: () => '{not json',
    set: () => { },
  });

  assert.equal(registry.sessionFor('conv_a'), undefined);
  // Binding still works, so the conversation recovers on the next send.
  registry.bind('conv_a', 'ses_a');
  assert.equal(registry.sessionFor('conv_a'), 'ses_a');
});
