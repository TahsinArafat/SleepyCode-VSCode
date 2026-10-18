/**
 * Tool-payload shaping (Phase 2).
 *
 * A tool card shows what the agent actually ran. That means this module puts two short strings in
 * front of the user, and the one property that matters most is the asymmetry it encodes: results are
 * truncated from the **tail** so the failure survives, while arguments are truncated from the
 * **head** so the call still reads.
 *
 * These tests pin that asymmetry directly — a head-truncated `stderr` would satisfy a naive
 * "output is capped" test while hiding exactly the line the user opened the card to read, which is
 * the failure mode worth guarding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_ARGS_MAX,
  TOOL_RESULT_MAX,
  durationMs,
  toolArgsText,
  toolResultText,
  truncateHead,
  truncateTail,
} from '../src/tool-payload-core.ts';

test('short text passes through both truncators untouched', () => {
  assert.equal(truncateHead('abc', 10), 'abc');
  assert.equal(truncateTail('abc', 10), 'abc');
  assert.equal(toolArgsText('abc'), 'abc');
  assert.equal(toolResultText('abc'), 'abc');
});

test('truncateHead keeps the beginning and states how much was dropped', () => {
  const out = truncateHead('x'.repeat(50), 10);
  assert.ok(out.startsWith('x'.repeat(10)));
  assert.match(out, /40 more characters hidden/);
  // Singular grammar, so the copy never reads "1 more characters hidden".
  assert.match(truncateHead('x'.repeat(11), 10), /1 more character hidden/);
});

test('truncateTail keeps the END, which is where a failure lives', () => {
  const input = 'START\n' + 'noise\n'.repeat(30) + 'FATAL: the real error';
  const out = truncateTail(input, 40);
  assert.ok(out.endsWith('FATAL: the real error'), `tail truncated the failure: ${JSON.stringify(out.slice(-60))}`);
  assert.ok(!out.includes('START'), 'head of the output should have been dropped');
  assert.match(out, /earlier characters hidden/);
});

test('truncateTail drops whole lines so the block stays aligned', () => {
  const input = 'a'.repeat(40) + '\n'.repeat(0) + Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n') + '\nLAST';
  const out = truncateTail(input, 60);
  const kept = out.split('\n').slice(1); // skip the "N earlier characters hidden" marker line
  for (const line of kept) {
    assert.ok(line.length <= 60, `truncation cut mid-line: ${JSON.stringify(line)}`);
  }
  assert.ok(out.endsWith('LAST'));
  assert.ok(!out.includes('line-0'), 'the earliest line should have been dropped');
});

test('a custom marker is honoured by both truncators', () => {
  assert.match(truncateHead('abcdef', 3, '[cut]'), /\[cut\]/);
  assert.match(truncateTail('abcdef', 3, '[cut]'), /\[cut\]/);
});

test('toolArgsText pretty-prints objects and tolerates hostile shapes', () => {
  assert.match(toolArgsText({ path: 'src/a.ts' }), /"path": "src\/a\.ts"/);
  assert.equal(toolArgsText('raw string'), 'raw string');
  assert.equal(toolArgsText(null), '');
  assert.equal(toolArgsText(undefined), '');
  assert.equal(toolArgsText(42), '42');

  // Must not throw: a transcript that renders beats one that throws mid-run.
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.match(toolArgsText(cyclic), /circular/);

  const deep = {};
  let cursor = deep;
  for (let i = 0; i < 20; i++) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.doesNotThrow(() => toolArgsText(deep));
});

test('toolArgsText is head-truncated, so the call still reads', () => {
  const out = toolArgsText({ path: 'a'.repeat(TOOL_ARGS_MAX * 2) });
  assert.ok(out.includes('"path"'), 'the identifying key must survive');
  assert.match(out, /more characters hidden/);
});

test('toolResultText unwraps the AI SDK envelopes instead of printing the wrapper', () => {
  assert.equal(toolResultText({ type: 'text', value: 'hello' }), 'hello');
  assert.equal(toolResultText({ type: 'tool-error', error: { message: 'boom' } }), 'boom');
  assert.equal(toolResultText({ type: 'tool-error', error: 'boom' }), 'boom');
  assert.equal(toolResultText({ type: 'json', value: { a: 1 } }), '{\n  "a": 1\n}');
  assert.equal(toolResultText(null), '');
});

test('toolResultText is tail-truncated, so stderr keeps its error', () => {
  // Distinct, numbered noise: uniform filler would still match a "head was dropped" check, because
  // the same string repeats throughout the retained window.
  const noise = Array.from({ length: 4000 }, (_, i) => `step ${i + 1}`).join('\n');
  const output = { type: 'text', value: `${noise}\nerror TS2345: Argument of type string is not assignable` };
  const out = toolResultText(output);
  assert.ok(
    out.endsWith('error TS2345: Argument of type string is not assignable'),
    `the actual error was truncated away: ${JSON.stringify(out.slice(-80))}`,
  );
  assert.ok(!out.includes('step 1\n'), 'the head of the output should have been dropped');
  assert.ok(out.length < TOOL_RESULT_MAX + 120, 'result must stay bounded');
});

test('durationMs reports a non-negative whole number and refuses unknown starts', () => {
  assert.equal(durationMs(1000, 1250), 250);
  assert.equal(durationMs(1000, 1000), 0);
  // A clock that jumps backwards must not render as a negative duration.
  assert.equal(durationMs(2000, 1000), 0);
  assert.equal(durationMs(undefined), undefined);
  assert.equal(durationMs(Number.NaN), undefined);
});
