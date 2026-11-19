import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../webview-ui/sidebar/interaction-perf-core.ts';

/*
 * Interaction timing.
 *
 * Everything measurable from the build machine said the UI was fine: 16.7 ms scroll
 * frames, a 14.4 ms tab click. Those numbers came from the shipped bundle in a headless
 * browser with a synthetic transcript -- the environment least likely to reproduce a slow
 * machine. This records what happens on the reporter's hardware instead, and these pin
 * that it stays cheap and honest.
 */

test('only interactions slower than a frame are kept', () => {
  // A frame is 16.7 ms. Keeping everything under the threshold would bury the real
  // samples in noise and make the report unreadable.
  let samples = [];
  samples = p.recordSample(samples, 'click', 4, 0);
  samples = p.recordSample(samples, 'click', 16, 1);
  assert.equal(samples.length, 0, 'sub-frame work is not recorded');
  samples = p.recordSample(samples, 'click', 120, 2);
  assert.equal(samples.length, 1, 'a slow interaction is recorded');
  assert.equal(samples[0].label, 'click');
});

test('the ring is bounded, so a long session cannot grow it', () => {
  let samples = [];
  for (let i = 0; i < p.MAX_SAMPLES * 3; i++) samples = p.recordSample(samples, `s${i}`, 200, i);
  assert.equal(samples.length, p.MAX_SAMPLES, 'kept to the cap');
  assert.equal(samples[samples.length - 1].label, `s${p.MAX_SAMPLES * 3 - 1}`, 'and keeps the newest');
});

test('long tasks are recorded with their source when the browser names one', () => {
  let tasks = [];
  tasks = p.recordLongTask(tasks, 900, 10, 'script');
  tasks = p.recordLongTask(tasks, 200, 20);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].source, 'script');
  assert.equal(tasks[1].source, undefined, 'a task with no attribution says nothing rather than guessing');
});

test('a non-finite duration is ignored instead of poisoning the percentiles', () => {
  let samples = [];
  samples = p.recordSample(samples, 'bad', Number.NaN, 0);
  samples = p.recordSample(samples, 'bad', Number.POSITIVE_INFINITY, 0);
  assert.equal(samples.length, 0);
});

test('the report gives percentiles and names the worst interactions', () => {
  let samples = [];
  for (const [label, ms] of [['scroll', 60], ['scroll', 80], ['click', 400], ['tab', 120]]) {
    samples = p.recordSample(samples, label, ms, 0);
  }
  const text = p.formatInteractionReport(samples, [], { frameRate: 42 });
  assert.match(text, /p50 \d+ ms · p95 \d+ ms · worst 400 ms/);
  assert.match(text, /400 ms {2}click/, 'the worst interaction is named, not just counted');
  assert.match(text, /42 fps/, 'frame rate travels with it, because slow-but-smooth and blocked differ');
});

test('an empty report says nothing was slow rather than showing an empty table', () => {
  // "No interaction took longer than 50 ms" is a finding; a blank section is not.
  assert.match(p.formatInteractionReport([], []), /No interaction took longer than 50 ms/);
});

test('long tasks are summarised with a total, since a count alone hides the cost', () => {
  let tasks = [];
  for (const ms of [100, 300, 900]) tasks = p.recordLongTask(tasks, ms, 0);
  const text = p.formatInteractionReport([], tasks);
  assert.match(text, /3 over 50 ms, 1300 ms total, worst 900 ms/);
});
