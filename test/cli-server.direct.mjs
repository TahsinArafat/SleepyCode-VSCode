// Server selection seams. These drive startOrAttach with stubbed probes so the
// workspace-scoping rules can be asserted without a real `sleepy serve`.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DIRECTORY_HEADER, isDirectoryDenied, parseDirectoryDenied, startOrAttach } from '../src/cli-server.ts';

const BANNER = 'sleepycode server listening on http://127.0.0.1:7777\n';

/** A `sleepy serve` child that prints its banner without running anything. */
function fakeChild(banner = BANNER) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.resume = () => { };
  child.stderr = new EventEmitter();
  child.stderr.resume = () => { };
  child.stderr.on = () => { }; // stderrLines capture; stubbed for tests
  child.kill = () => { };
  queueMicrotask(() => child.stdout.emit('data', Buffer.from(banner)));
  return child;
}

test('a healthy server scoped to another workspace is not adopted', async () => {
  const spawned = [];
  const server = await startOrAttach({
    directory: '/tmp/workspace-a',
    // Something healthy is already listening, but it is another project's.
    probeFn: async () => true,
    directoryFn: async () => undefined,
    spawnFn: (binary, args, options) => {
      spawned.push({ binary, args, cwd: options?.cwd });
      return fakeChild();
    },
  });

  assert.equal(server.url, 'http://127.0.0.1:7777');
  assert.equal(server.owned, true, 'a foreign server must never be adopted');
  assert.equal(spawned.length, 1, 'so we start our own instead');
  // The child runs in the workspace, because the CLI scopes sessions by cwd.
  assert.equal(spawned[0].cwd, '/tmp/workspace-a');
});

test('a server already serving this workspace is attached to', async () => {
  // A real directory, so the symlink normalization is genuinely exercised: on
  // macOS the caller says /tmp/... and the server answers /private/tmp/....
  const workspace = await mkdtemp(join(tmpdir(), 'sleepy-serve-test-'));
  let spawned = 0;
  const server = await startOrAttach({
    directory: workspace,
    probeFn: async () => true,
    directoryFn: async () => realpathSync(workspace),
    spawnFn: () => {
      spawned += 1;
      return fakeChild();
    },
  });

  assert.equal(server.url, 'http://127.0.0.1:4096');
  assert.equal(server.owned, false, 'an already-running server is reused');
  assert.equal(spawned, 0, 'and no second server is started');
  await rm(workspace, { recursive: true, force: true });
});

test('a denied directory is recognised, not mistaken for a transport failure', () => {
  // The CLI answers a directory outside its cwd with this stable code.
  const denied = { code: 'directory_not_allowed', error: 'Access denied', directory: '/tmp/workspace-a' };
  assert.equal(isDirectoryDenied(denied), true);
  assert.equal(parseDirectoryDenied(JSON.stringify(denied)), true);

  // Matching on prose would break the moment the wording changes.
  assert.equal(isDirectoryDenied({ error: 'Access denied' }), false);
  assert.equal(isDirectoryDenied(null), false);
  assert.equal(parseDirectoryDenied('not json'), false);
});

test('the workspace travels as a header, not as a spawn argument', async () => {
  // `sleepy serve` prints help and exits when given a directory, so the header
  // is the only way to name a workspace the server did not start in.
  const spawned = [];
  await startOrAttach({
    directory: '/tmp/workspace-a',
    probeFn: async () => false,
    spawnFn: (binary, args) => {
      spawned.push(args);
      return fakeChild();
    },
  });
  assert.deepEqual(spawned[0], ['serve', '--port', '0', '--hostname', '127.0.0.1']);
  assert.equal(DIRECTORY_HEADER, 'x-sleepycode-directory');
});
