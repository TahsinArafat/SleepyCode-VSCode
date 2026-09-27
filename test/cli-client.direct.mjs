// Direct tests for the CLI client helpers. Dependency-free on purpose: this file
// imports only src/cli-client.ts, which must never import vscode.
import assert from 'node:assert/strict';
import test from 'node:test';

import { isPreferredCliModel, pickCliModel } from '../src/cli-client.ts';

// Shaped like a real `GET /provider` from sleepy 0.1.19, reduced to one
// connected provider. `connected` is what makes a provider runnable at all.
const catalog = {
  providers: [
    { id: 'sleepy', models: { 'claude-sonnet-4.6-thinking': {}, 'longcat-2.5-preview:free': {} } },
    { id: 'openai', models: { 'gpt-5.3-chat-latest': {} } },
  ],
  defaults: { sleepy: 'claude-sonnet-4.6-thinking', openai: 'gpt-5.3-chat-latest' },
  connected: ['sleepy'],
};

test('the sidebar model wins when the CLI actually has it', () => {
  assert.deepEqual(
    pickCliModel(catalog, { providerID: 'sleepy', modelID: 'longcat-2.5-preview:free' }),
    { providerID: 'sleepy', modelID: 'longcat-2.5-preview:free' },
  );
});

test('a SleepyCode model the CLI never heard of is not sent', () => {
  // This is the failure the user hit: the sidebar lists SleepyCode's models,
  // which mean nothing to the CLI, so passing one through fails the turn.
  assert.deepEqual(
    pickCliModel(catalog, { providerID: 'sleepycode-openai', modelID: 'gpt-4o' }),
    { providerID: 'sleepy', modelID: 'claude-sonnet-4.6-thinking' },
  );
});

test('with no sidebar model the CLI default is used instead of its broken placeholder', () => {
  // The CLI resolved `sleepy/auto-best-coding`, which is in no provider's list.
  // Omitting the model reproduced that, so the chooser names a real one.
  assert.deepEqual(pickCliModel(catalog), { providerID: 'sleepy', modelID: 'claude-sonnet-4.6-thinking' });
});

test('a stale default falls back to the first real model of a connected provider', () => {
  const stale = {
    providers: [{ id: 'sleepy', models: { 'real-model': {} } }],
    defaults: { sleepy: 'auto-best-coding' },
    connected: ['sleepy'],
  };
  assert.deepEqual(pickCliModel(stale), { providerID: 'sleepy', modelID: 'real-model' });
});

test('a provider with no credentials is never chosen', () => {
  // `openai` has models and a default, but is not connected, so it cannot run.
  const onlyOpenai = { providers: catalog.providers, defaults: catalog.defaults, connected: [] };
  assert.equal(pickCliModel(onlyOpenai), undefined);
});

test('a preferred model on an unconnected provider is not chosen either', () => {
  assert.equal(pickCliModel(catalog, { providerID: 'openai', modelID: 'gpt-5.3-chat-latest' })?.providerID, 'sleepy');
});

test('an empty or unknown catalog yields nothing rather than a guess', () => {
  assert.equal(pickCliModel({ providers: [], defaults: {}, connected: [] }), undefined);
  assert.equal(pickCliModel({ providers: [{ id: 'sleepy', models: {} }], defaults: {}, connected: ['sleepy'] }), undefined);
});

// The account provider is `sleepyai` in the sidebar and `sleepy` in sleepy
// 0.1.19. Matching ids exactly threw away a model the CLI really does have, so
// every send fell back to `sleepy/claude-sonnet-4.6-thinking` behind a
// "has no model" notice.
const accountCatalog = {
  providers: [
    { id: 'sleepy', models: { 'gemini-3.5-flash-lite': {}, 'claude-sonnet-4.6-thinking': {} } },
    { id: 'openai', models: { 'gpt-5.3-chat-latest': {} } },
  ],
  defaults: { sleepy: 'claude-sonnet-4.6-thinking' },
  connected: ['sleepy'],
};

test('the sidebar account provider matches the CLI under either name', () => {
  assert.deepEqual(
    pickCliModel(accountCatalog, { providerID: 'sleepyai', modelID: 'gemini-3.5-flash-lite' }),
    { providerID: 'sleepy', modelID: 'gemini-3.5-flash-lite' },
  );
});

test('the alias never invents a model the CLI does not have', () => {
  // The model is what is missing, so the real mismatch notice must still fire
  // and the CLI default must be used.
  assert.deepEqual(
    pickCliModel(accountCatalog, { providerID: 'sleepyai', modelID: 'no-such-model' }),
    { providerID: 'sleepy', modelID: 'claude-sonnet-4.6-thinking' },
  );
});

test('an exact provider match still wins over the alias', () => {
  const both = {
    providers: [
      { id: 'sleepyai', models: { 'shared-model': {} } },
      { id: 'sleepy', models: { 'shared-model': {} } },
    ],
    defaults: { sleepy: 'shared-model' },
    connected: ['sleepyai', 'sleepy'],
  };
  assert.deepEqual(
    pickCliModel(both, { providerID: 'sleepyai', modelID: 'shared-model' }),
    { providerID: 'sleepyai', modelID: 'shared-model' },
  );
});

test('the alias only covers the account provider, not every SleepyCode id', () => {
  // A third-party provider keeps its own id: no alias, so an unknown model is
  // rejected rather than silently mapped onto the account provider.
  assert.deepEqual(
    pickCliModel(accountCatalog, { providerID: 'sleepycode-openai', modelID: 'gpt-5.3-chat-latest' }),
    { providerID: 'sleepy', modelID: 'claude-sonnet-4.6-thinking' },
  );
});

test('a mismatch notice is only raised when the pick was not honoured', () => {
  assert.equal(
    isPreferredCliModel({ providerID: 'sleepyai', modelID: 'gemini-3.5-flash-lite' }, { providerID: 'sleepy', modelID: 'gemini-3.5-flash-lite' }),
    true,
  );
  assert.equal(
    isPreferredCliModel({ providerID: 'sleepyai', modelID: 'claude-sonnet-4.6-thinking' }, { providerID: 'sleepy', modelID: 'claude-sonnet-4.6-thinking' }),
    true,
  );
  // Model id changed: a real fallback, so the notice belongs on.
  assert.equal(
    isPreferredCliModel({ providerID: 'sleepyai', modelID: 'gemini-3.5-flash-lite' }, { providerID: 'sleepy', modelID: 'claude-sonnet-4.6-thinking' }),
    false,
  );
  // Same model on a provider that is not the account provider: still a mismatch.
  assert.equal(
    isPreferredCliModel({ providerID: 'sleepycode-openai', modelID: 'gpt-5.3-chat-latest' }, { providerID: 'sleepy', modelID: 'gpt-5.3-chat-latest' }),
    false,
  );
  assert.equal(
    isPreferredCliModel({ providerID: 'sleepyai', modelID: 'gemini-3.5-flash-lite' }, undefined),
    false,
  );
});
