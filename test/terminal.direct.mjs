import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { TerminalManager } from '../src/terminal.ts';

test('terminal cap preserves running shells and requires an explicit stop', () => {
  const manager = new TerminalManager();
  try {
    for (let index = 0; index < 8; index++) manager.start(`session-${index}`, tmpdir());
    assert.throws(() => manager.start('ninth', tmpdir()), /Terminal limit reached \(8\)/);
    assert.equal(manager.list().length, 8);
    for (const session of manager.list()) assert.equal(session.running, true, 'running shells are not idle-killed');
  } finally {
    manager.dispose();
  }
});

test('explicit stop terminates an owned process and its grandchild', { skip: process.platform === 'win32' }, async () => {
  const manager = new TerminalManager();
  const name = 'tree-test';
  let childPid = 0;
  try {
    manager.start(name, tmpdir(), 'sleep 30 & echo $!; wait');
    for (let attempt = 0; attempt < 40 && !childPid; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const text = manager.read(name).output;
      childPid = Number(text.match(/\b(\d{2,})\b/)?.[1] ?? 0);
    }
    assert.ok(childPid > 0, 'the grandchild pid was printed');
    manager.stop(name);
    let exited = false;
    for (let attempt = 0; attempt < 40 && !exited; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      try { process.kill(childPid, 0); } catch { exited = true; }
    }
    assert.equal(exited, true, `grandchild ${childPid} survived process-tree termination`);
  } finally {
    manager.dispose();
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { } }
  }
});
