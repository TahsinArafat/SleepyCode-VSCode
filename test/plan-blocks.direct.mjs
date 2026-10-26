import test from 'node:test';
import assert from 'node:assert/strict';

const work = await import('../webview-ui/sidebar/workPresentation.ts');

// SleepyCode has two plan tools: `plan` (stateful, re-called for progress, each
// call a new tool event) and `write_plan` (saves the .md file). Both render as a
// plan card, so a run produced several cards and the last one - a progress call
// that omits steps - was empty.

const planCall = (callId, input) => ({ kind: 'tool', callId, name: 'WritePlan', input, status: 'completed' });
const planFile = (callId, result) => ({ kind: 'tool', callId, name: 'write_plan', input: { title: 'T', content: '# T\n\nsteps' }, status: 'completed', result });

test('repeated stateful plan calls collapse to one card', () => {
  const blocks = [
    planCall('p1', { title: 'T', steps: ['a', 'b'], activeStep: 0 }),
    planCall('p2', { steps: undefined, activeStep: 1 }),
    planCall('p3', { steps: undefined, activeStep: 2 }),
  ];
  const out = work.collapsePlanBlocks(blocks);
  assert.equal(out.filter((b) => b.kind === 'tool').length, 1);
});

test('the surviving card is the one that still has the steps', () => {
  // A progress call omits steps, so keeping the last call would leave it empty.
  const blocks = [
    planCall('p1', { title: 'T', steps: ['a', 'b'], activeStep: 0 }),
    planCall('p2', { activeStep: 1 }),
  ];
  const [only] = work.collapsePlanBlocks(blocks).filter((b) => b.kind === 'tool');
  assert.deepEqual(only.input.steps, ['a', 'b']);
});

test('the plan file wins over the stateful card, so one card has the file', () => {
  const blocks = [planCall('p1', { steps: ['a'] }), planFile('w1', '.sleepycode/plans/t.md')];
  const tools = work.collapsePlanBlocks(blocks).filter((b) => b.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'write_plan');
  assert.match(tools[0].result, /\.md$/);
});

test('non-plan blocks keep their order when plans collapse', () => {
  const blocks = [
    { kind: 'text', text: 'hello' },
    planCall('p1', { steps: ['a'] }),
    planCall('p2', { activeStep: 1 }),
    { kind: 'tool', callId: 'r1', name: 'Read', input: {}, status: 'completed' },
  ];
  const out = work.collapsePlanBlocks(blocks);
  assert.deepEqual(out.map((b) => b.kind), ['text', 'tool', 'tool']);
  assert.equal(out[1].callId, 'p1', 'the card with steps survives, in place');
  assert.equal(out[2].name, 'Read');
});

test('a single plan block is left exactly as it is', () => {
  const blocks = [planCall('p1', { steps: ['a'] })];
  assert.equal(work.collapsePlanBlocks(blocks)[0].callId, 'p1');
});

test('a plan card with no steps at all still shows something', () => {
  // Nothing to recover: the card must not render as an empty shell.
  assert.equal(work.planBlockContent({ title: 'T' }), '');
  assert.match(work.planBlockContent({ steps: ['a', 'b'], doneSteps: [0] }), /\[x\] a/);
});

test('a file-backed plan uses its own content, not a synthesised checklist', () => {
  assert.equal(work.planBlockContent({ content: '# Plan\n\nbody', steps: ['a'] }), '# Plan\n\nbody');
});
