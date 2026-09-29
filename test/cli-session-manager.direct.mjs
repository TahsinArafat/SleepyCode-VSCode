import assert from 'node:assert/strict';
import test from 'node:test';

import { CliSessionRegistry } from '../src/cli-engine.ts';
import { CliSessionManager } from '../src/cli-session-manager.ts';

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
