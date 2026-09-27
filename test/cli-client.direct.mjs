// Direct tests for the CLI client helpers. Dependency-free on purpose: this file
// imports only src/cli-client.ts, which must never import vscode.
import assert from 'node:assert/strict';
import test from 'node:test';

import { pickCliModel } from '../src/cli-client.ts';

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
