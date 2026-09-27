// Verifies the CLI client against a real `sleepy serve` process.
// Skips cleanly when the CLI is not installed, so CI without it still passes.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';

import { CliClient } from '../src/cli-client.ts';
import { findCliBinary, parseListeningUrl, startOrAttach } from '../src/cli-server.ts';
import { projectMessage, recoverableAssistant } from '../src/cli-projection.ts';

const binary = findCliBinary();
const scratch = '/tmp/sleepy-vscode-client-test';
// node:test skips when this is falsy or a skip reason string.
const installed = binary ? false : 'sleepy CLI not installed';

// One server for the whole file. It must be torn down or the child keeps the
// runner's event loop alive and the suite hangs.
let server = null;
let client = null;

test.before(async () => {
  if (!binary) return;
  server = await startOrAttach({ directory: scratch });
  client = new CliClient(server.url);
});

test.after(async () => {
  if (server?.owned) server.child?.kill();
});

test('parseListeningUrl pulls the base URL out of serve output', () => {
  const banner = 'sleepycode server listening on http://127.0.0.1:4096\n';
  assert.equal(parseListeningUrl(banner), 'http://127.0.0.1:4096');
  assert.equal(parseListeningUrl('nothing to see here'), undefined);
});

test('every request names the workspace, so the server cannot guess wrong', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const scoped = new CliClient('http://127.0.0.1:4096', '/tmp/workspace-a');
    await scoped.listSessions('/tmp/workspace-a');
    await scoped.listSessions();
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(seen.length >= 2, 'both calls should have been made');
  for (const call of seen) {
    // Without this the server falls back to its own cwd and files our sessions
    // under whichever project it was started in.
    assert.equal(call.headers['x-sleepycode-directory'], '/tmp/workspace-a');
  }
});

test('a refused workspace is reported clearly, not as a generic failure', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: 'directory_not_allowed', error: 'Access denied: directory must be within the server\'s working directory' }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
  try {
    const scoped = new CliClient('http://127.0.0.1:4096', '/tmp/elsewhere');
    await assert.rejects(() => scoped.listSessions('/tmp/elsewhere'), /cannot serve this folder/i);
  } finally {
    globalThis.fetch = original;
  }
});

test('startOrAttach fails clearly when the CLI is absent', async () => {
  if (binary) return;
  await assert.rejects(() => startOrAttach({ env: { PATH: '/nonexistent', HOME: '/nonexistent' } }), /not found/);
});

test('the client creates and lists a session for this workspace', { skip: installed }, async () => {
  const session = await client.createSession(scratch, 'vscode client test');
  assert.ok(session.id, 'createSession should return an id');
  // The CLI resolves the directory, so /tmp becomes /private/tmp on macOS.
  assert.equal(session.directory, realpathSync(scratch), 'the session must belong to the workspace directory');

  const listed = await client.listSessions(scratch);
  assert.ok(listed.some(entry => entry.id === session.id), 'created session should be listed');
  // Filtering must not leak another workspace's sessions into this one.
  const resolved = realpathSync(scratch);
  assert.ok(listed.every(entry => entry.directory === resolved));
});

test('a symlinked workspace still matches its sessions', { skip: installed }, async () => {
  // Guard the realpath normalization: an exact string match would drop these.
  const resolved = realpathSync(scratch);
  assert.notEqual(resolved, scratch, 'scratch should be reached through a symlink on this platform');
  const listed = await client.listSessions(scratch);
  assert.ok(listed.length > 0, 'sessions should be found through the symlinked path');
});

test('prompt_async creates the real user turn the CLI will answer', { skip: installed }, async () => {
  const session = await client.createSession(scratch, 'prompt test');
  await client.prompt(session.id, 'hello from the vscode client');
  // prompt_async answers 204 before the loop writes the turn, so poll for it
  // rather than assuming the message exists when the call returns.
  let text = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const messages = await client.messages(session.id);
    text = messages
      .filter(message => message.info?.role === 'user')
      .flatMap(message => message.parts ?? [])
      .map(part => part.text)
      .filter(Boolean);
    if (text.length) break;
    await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(
    text.some(value => value.includes('hello from the vscode client')),
    `user text should round-trip, saw ${JSON.stringify(text)}`,
  );
});

test('permission replies use `response` and reject an unknown permission id', { skip: installed }, async () => {
  const session = await client.createSession(scratch, 'permission test');
  // `reply` is the wrong key; the CLI answers with a validation error.
  await assert.rejects(
    () => fetch(`${server.url}/session/${session.id}/permissions/per_test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply: 'reject' }),
    }).then(response => {
      if (!response.ok) throw new Error(`failed (${response.status})`);
      return response.json();
    }),
    /failed/,
  );
  // A well-formed reply resolves even when nothing is pending.
  await assert.doesNotReject(() => client.respondToPermission(session.id, 'per_missing', 'reject'));
});

test('abort and recovery are safe on an idle session', { skip: installed }, async () => {
  const session = await client.createSession(scratch, 'abort test');
  await client.abort(session.id);
  assert.deepEqual(await client.recovery(session.id), []);
  assert.ok(Array.isArray(await client.messages(session.id)));
});

test('revert requires a message id and surfaces the error', { skip: installed }, async () => {
  const session = await client.createSession(scratch, 'revert test');
  await assert.rejects(() => client.revert(session.id, ''), /failed/);
});

test('events stream delivers server.connected', { skip: installed }, async () => {
  const controller = new AbortController();
  const seen = [];
  const stream = client.events(event => {
    seen.push(event.type);
    if (event.type === 'server.connected') controller.abort();
  }, controller.signal);
  await Promise.race([stream, new Promise(done => setTimeout(done, 8000))]);
  assert.ok(seen.includes('server.connected'), `expected server.connected, saw ${seen.join(',')}`);
});

test('the projection turns real CLI rows into sidebar items', { skip: installed }, async () => {
  const session = await client.createSession(scratch, 'projection test');
  await client.prompt(session.id, 'say hi');
  const messages = await client.messages(session.id);
  const items = messages.flatMap(message => projectMessage(message));
  assert.ok(items.length > 0, 'expected at least one projected item');
  assert.ok(items.every(item => typeof item.text === 'string'));
  // The user turn must project as a user item, not as a fabricated assistant turn.
  assert.ok(items.some(item => item.role === 'user'));
  // A completed assistant is not resumable; recovery keys off the CLI, not us.
  for (const message of messages.filter(entry => entry.info?.role === 'assistant')) {
    if (message.info?.finish === 'stop') assert.equal(recoverableAssistant(message.info), false);
  }
});
