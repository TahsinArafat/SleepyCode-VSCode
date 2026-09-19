import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBAGENT_EMPTY_RESPONSE,
  classifySubagentStep,
  harvestSubagentText,
  rememberVisibleText,
  stripInvokeBlocks,
  visibleStepText,
} from '../src/subagent-core.ts';

const T = '<' + 'think' + '>';
const TC = '<' + '/' + 'think' + '>';
const INV = (body) => `<invoke name="read_file"><parameter name="path">${body}</parameter></invoke>`;

test('visibleStepText strips thinking and XML tool tags', () => {
  const raw = `${T}look at the file${TC}Found the bug in src/agent.ts.\n${INV('src/agent.ts')}\nAlso check the tests.`;
  assert.equal(visibleStepText(raw), 'Found the bug in src/agent.ts.\n\nAlso check the tests.');
});

test('think-only output is not a valid parent-facing answer', () => {
  assert.equal(visibleStepText(`${T}I will inspect the repo then answer.${TC}`), '');
  assert.equal(classifySubagentStep(`${T}hidden${TC}`, 0, 0).kind, 'empty');
});

test('native tool steps preserve leftover prose instead of discarding the turn', () => {
  const decision = classifySubagentStep('I will inspect src/agent.ts next.', 1, 0);
  assert.equal(decision.kind, 'native-tools');
  assert.equal(decision.visibleText, 'I will inspect src/agent.ts next.');
});

test('XML tool steps keep leftover prose for harvest after the invoke tags are gone', () => {
  const raw = `Read the harvest helper.\n${INV('src/subagent-core.ts')}`;
  const decision = classifySubagentStep(raw, 0, 1);
  assert.equal(decision.kind, 'xml-tools');
  assert.equal(decision.visibleText, 'Read the harvest helper.');
  assert.equal(stripInvokeBlocks(raw), 'Read the harvest helper.');
});

test('a later empty or think-only step does not wipe earlier leftover text', () => {
  let leftover = '';
  leftover = rememberVisibleText(leftover, 'Found 2 call sites in src/agent.ts.');
  leftover = rememberVisibleText(leftover, '');
  leftover = rememberVisibleText(leftover, `${T}still thinking${TC}`);
  leftover = rememberVisibleText(leftover, '   ');
  assert.equal(leftover, 'Found 2 call sites in src/agent.ts.');
});

test('harvest prefers leftover tool-step prose over the empty-response placeholder', () => {
  const harvested = harvestSubagentText('', 'Found the empty-response loop in src/agent.ts:2615.');
  assert.equal(harvested.usedFallback, false);
  assert.equal(harvested.text, 'Found the empty-response loop in src/agent.ts:2615.');
});

test('harvest uses a dedicated final step when the model actually answered', () => {
  const harvested = harvestSubagentText('Review complete. No issues found.', 'earlier note');
  assert.equal(harvested.usedFallback, false);
  assert.equal(harvested.text, 'Review complete. No issues found.');
});

test('harvest falls back only when no step produced visible text', () => {
  const harvested = harvestSubagentText('', '');
  assert.equal(harvested.usedFallback, true);
  assert.equal(harvested.text, SUBAGENT_EMPTY_RESPONSE);
});
