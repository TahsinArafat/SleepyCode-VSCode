import test from 'node:test';
import assert from 'node:assert/strict';
import { warmDelayMs, warmVerdict } from '../src/mcp-warm-core.ts';

/*
 * The reported symptom: after a VS Code restart every saved MCP server read
 * "idle" until Reconnect was pressed by hand. The transport was fine — the retry
 * DECISION was wrong.
 *
 *   `if (connected === 0 && stillDown > 0) retry()`
 *
 * stops as soon as ONE server answers, and counts a switched-off server as down.
 * One reachable remote plus one disabled entry therefore ended the retries while
 * the rest were still down, and nothing ever noticed them coming back.
 */

test('retries while any enabled server is down, not only when all are', () => {
  const verdict = warmVerdict([
    { name: 'ShamelaWs', connected: true },
    { name: 'ShamelaLink', connected: false },
    { name: 'mobbin', connected: false },
  ]);
  assert.equal(verdict.retry, true, 'one healthy server must not end the retries');
  assert.deepEqual(verdict.down, ['ShamelaLink', 'mobbin']);
  assert.equal(verdict.connected, 1);
  assert.equal(verdict.total, 3);
});

test('a switched-off server is not a failure', () => {
  // This is the shape that looked broken: enabled servers all up, plus two the
  // user deliberately disabled. The probe only connects enabled rows, so the
  // disabled ones are honestly `connected: false`.
  const verdict = warmVerdict([
    { name: 'ShamelaWs', connected: true },
    { name: 'ShamelaLink', connected: true },
    { name: 'archiveorg', connected: false, disabled: true },
    { name: 'mobbin', connected: false, disabled: true },
  ]);
  assert.equal(verdict.retry, false, 'nothing is actually wrong, so stop retrying');
  assert.deepEqual(verdict.down, []);
  assert.deepEqual(verdict.enabled, ['ShamelaWs', 'ShamelaLink']);
  assert.equal(verdict.total, 4);
});

test('everything healthy means no retry', () => {
  assert.equal(warmVerdict([{ name: 'a', connected: true }, { name: 'b', connected: true }]).retry, false);
});

test('everything down means keep retrying', () => {
  const verdict = warmVerdict([{ name: 'a', connected: false }, { name: 'b', connected: false }]);
  assert.equal(verdict.retry, true);
  assert.deepEqual(verdict.down, ['a', 'b']);
});

test('only disabled servers means nothing to connect', () => {
  const verdict = warmVerdict([{ name: 'a', connected: false, disabled: true }]);
  assert.equal(verdict.retry, false);
  assert.deepEqual(verdict.enabled, []);
});

test('no saved servers means no retry', () => {
  assert.equal(warmVerdict([]).retry, false);
  assert.equal(warmVerdict(undefined).retry, false);
  assert.equal(warmVerdict(null).retry, false);
});

test('a malformed row cannot crash the decision', () => {
  const verdict = warmVerdict([null, undefined, { name: 'ok', connected: true }]);
  assert.equal(verdict.retry, false);
  assert.equal(verdict.connected, 1);
});

// ---------------------------------------------------------------- delays

test('the retry ladder backs off and then holds a steady heartbeat', () => {
  const ladder = [5_000, 15_000, 45_000, 120_000];
  assert.equal(warmDelayMs(0, { backoffMs: ladder, heartbeatMs: 90_000 }), 5_000);
  assert.equal(warmDelayMs(1, { backoffMs: ladder, heartbeatMs: 90_000 }), 15_000);
  assert.equal(warmDelayMs(3, { backoffMs: ladder, heartbeatMs: 90_000 }), 120_000);
  // Past the ladder it never stops — it settles into the heartbeat.
  assert.equal(warmDelayMs(4, { backoffMs: ladder, heartbeatMs: 90_000 }), 90_000);
  assert.equal(warmDelayMs(500, { backoffMs: ladder, heartbeatMs: 90_000 }), 90_000);
});

test('a user-triggered pass starts the fast ladder again', () => {
  // After a deliberate Reconnect the rows should come back in seconds, not at
  // the next two-minute tick.
  assert.equal(warmDelayMs(7, { backoffMs: [5_000, 15_000], heartbeatMs: 60_000, immediate: true }), 5_000);
});

test('delays are sane with no configuration at all', () => {
  assert.ok(warmDelayMs(0) > 0);
  assert.ok(warmDelayMs(99) > 0);
  assert.ok(Number.isFinite(warmDelayMs(-1)));
});
