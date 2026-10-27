import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWork } from '../webview-ui/sidebar/workPresentation.ts';

/*
 * A settled response is split in two: the work that produced it, and the answer
 * itself. The answer stays visible; the work collapses behind "Worked for 12s".
 *
 * A steering update is part of the work — that is the point of showing it inline
 * instead of as a new message — so it belongs on the work side. It also arrives
 * in the MIDDLE of a run, which means a response can end with one: the model
 * takes the guidance and stops, or the user stops it. In that state the trailing
 * scan used to stop at the update, which pulled the answer into the collapsed
 * work section and left the reader looking at "Worked for 4s" with nothing under
 * it.
 */

const text = (value) => ({ kind: 'text', text: value });
const note = (value) => ({ kind: 'steering', text: value, at: 1 });
const tool = { kind: 'tool', callId: 't1', name: 'Read', input: {}, status: 'completed', result: 'ok' };
const turn = (blocks, extra = {}) => ({ role: 'assistant', blocks, startedAt: 1, endedAt: 2, ...extra });

test('an answer followed by an update keeps the answer, and files the update with the work', () => {
  const { activity, conclusion } = splitWork(turn([text('Here is the answer.'), note('use the helper')]), false);
  assert.deepEqual(conclusion.map((block) => block.text), ['Here is the answer.']);
  assert.deepEqual(activity.map((block) => block.kind), ['steering']);
});

test('work, answer, update: the answer is still the conclusion', () => {
  const { activity, conclusion } = splitWork(turn([tool, text('Done.'), note('also do x')]), false);
  assert.deepEqual(conclusion.map((block) => block.text), ['Done.']);
  assert.deepEqual(activity.map((block) => block.kind), ['tool', 'steering']);
});

test('an update between two answers keeps both answers in the conclusion', () => {
  // Two text blocks with no tool between them already merge into the conclusion;
  // the note must not break that.
  const { conclusion, activity } = splitWork(turn([text('one'), note('update'), text('two')]), false);
  assert.deepEqual(conclusion.map((block) => block.text), ['one', 'two']);
  assert.deepEqual(activity.map((block) => block.kind), ['steering']);
});

test('an update in the middle of the work stays where it happened', () => {
  const read1 = { ...tool, callId: 't1' };
  const read2 = { ...tool, callId: 't2' };
  const { activity } = splitWork(turn([read1, note('stop reading, edit instead'), read2, text('Done.')]), false);
  assert.deepEqual(activity.map((block) => block.kind), ['tool', 'steering', 'tool']);
});

test('a running response is all work, updates included', () => {
  const { activity, conclusion } = splitWork(turn([text('streaming'), note('update')], { endedAt: undefined }), true);
  assert.deepEqual(activity.map((block) => block.kind), ['text', 'steering']);
  assert.deepEqual(conclusion, []);
});

test('a response with no update is split exactly as before', () => {
  const { activity, conclusion } = splitWork(turn([tool, text('Done.')]), false);
  assert.deepEqual(activity.map((block) => block.kind), ['tool']);
  assert.deepEqual(conclusion.map((block) => block.text), ['Done.']);
});