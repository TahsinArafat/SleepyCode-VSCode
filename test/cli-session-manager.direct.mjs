import assert from 'node:assert/strict';
import test from 'node:test';

import { CliSessionRegistry } from '../src/cli-engine.ts';
import { CliSessionManager } from '../src/cli-session-manager.ts';
import { CliApiError } from '../src/cli-client.ts';

function harness() {
  const persisted = new Map();
  const registry = new CliSessionRegistry({
    get: key => persisted.get(key),
    set: (key, value) => persisted.set(key, value),
  });
  const created = [];
  const prompted = [];
  const messages = new Map();
  let releaseCreate;
  const createGate = new Promise(resolve => { releaseCreate = resolve; });
  let sequence = 0;
  const client = {
    async createSession() {
      await createGate;
      const id = `ses_${++sequence}`;
      created.push(id);
      messages.set(id, []);
      return { id };
    },
    async messages(id) {
      if (!messages.has(id)) throw new Error('missing');
      return messages.get(id);
    },
    events() { return new Promise(() => {}); },
    async prompt(id, text) { prompted.push({ id, text }); },
  };
  const manager = new CliSessionManager(client, registry, '/workspace', () => ({
    label: tool => tool,
    update: () => {},
    error: () => {},
    permission: () => {},
  }));
  return { manager, registry, created, prompted, releaseCreate };
}

test('two new conversations always create and prompt two distinct CLI sessions', async () => {
  const { manager, registry, created, prompted, releaseCreate } = harness();
  const first = manager.open('conv_first');
  const second = manager.open('conv_second');
  releaseCreate();
  const [firstChat, secondChat] = await Promise.all([first, second]);
  await firstChat.send('first');
  await secondChat.send('second');

  assert.equal(created.length, 2);
  assert.notEqual(registry.sessionFor('conv_first'), registry.sessionFor('conv_second'));
  assert.deepEqual(prompted, [
    { id: registry.sessionFor('conv_first'), text: 'first' },
    { id: registry.sessionFor('conv_second'), text: 'second' },
  ]);
});

test('concurrent opens for one conversation create exactly one CLI session', async () => {
  const { manager, registry, created, releaseCreate } = harness();
  const first = manager.open('conv_one');
  const raced = manager.open('conv_one');
  assert.equal(first, raced, 'callers must share the same in-flight opener');
  releaseCreate();
  const [a, b] = await Promise.all([first, raced]);

  assert.equal(a, b);
  assert.deepEqual(created, ['ses_1']);
  assert.equal(registry.sessionFor('conv_one'), 'ses_1');
});

function probeHarness(messagesImpl) {
  const persisted = new Map();
  const registry = new CliSessionRegistry({
    get: key => persisted.get(key),
    set: (key, value) => persisted.set(key, value),
  });
  const created = [];
  let sequence = 0;
  const known = new Set(['ses_existing']);
  const client = {
    async createSession() {
      const id = `ses_${++sequence}`;
      created.push(id);
      known.add(id);
      return { id };
    },
    messages: messagesImpl(known),
    events() { return new Promise(() => {}); },
  };
  const lost = [];
  const manager = new CliSessionManager(client, registry, '/workspace', () => ({
    label: tool => tool,
    update: () => {},
    error: () => {},
    permission: () => {},
  }));
  manager.onSessionLost = id => lost.push(id);
  return { manager, registry, created, lost };
}

test('a transient probe failure does NOT start a new CLI session', async () => {
  // The old probe was `catch { return false }`, so a timeout, a 5xx, or the CLI
  // restarting all minted a fresh session and orphaned the conversation's history.
  const { manager, registry, created, lost } = probeHarness(known => async id => {
    if (id === 'ses_existing') throw new CliApiError('gateway timeout', 504);
    if (!known.has(id)) throw new CliApiError('missing', 404);
    return [];
  });
  registry.bind('conv', 'ses_existing');
  await manager.open('conv');
  assert.deepEqual(created, [], 'a non-404 failure must not create a session');
  assert.equal(registry.sessionFor('conv'), 'ses_existing', 'the binding is kept');
  assert.deepEqual(lost, [], 'and the conversation is not reported as lost');
});

test('a genuine 404 does start a new session and reports the loss', async () => {
  const { manager, registry, created, lost } = probeHarness(known => async id => {
    if (!known.has(id)) throw new CliApiError('missing', 404);
    return [];
  });
  registry.bind('conv', 'ses_existing');
  // Simulate the CLI having dropped it.
  await manager.open('conv');
  assert.equal(created.length, 0, 'still present, so no new session');

  const gone = probeHarness(() => async () => {
    throw new CliApiError('missing', 404);
  });
  gone.registry.bind('conv2', 'ses_existing');
  await gone.manager.open('conv2');
  assert.equal(gone.created.length, 1, 'a 404 replaces the session');
  assert.deepEqual(gone.lost, ['conv2'], 'and tells the user their history was orphaned');
});
