import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  normalizeReasoningEffort,
  reasoningEffortBody,
  reasoningEffortLabel,
  supportsReasoningControl,
  supportsReasoningEffort,
} from '../src/reasoning-effort.ts';

test('none is the default and sends no reasoning parameter at all', () => {
  // This is the load-bearing safety property: a model that does not know the
  // field must never receive one, or every request 400s.
  assert.equal(DEFAULT_REASONING_EFFORT, 'none');
  assert.deepEqual(reasoningEffortBody('none', 'gpt-5'), {});
  assert.deepEqual(reasoningEffortBody(undefined, 'gpt-5'), {});
  assert.deepEqual(reasoningEffortBody(null, 'o4-mini'), {});
});

test('none sends nothing even for a model that does support effort', () => {
  // Absence is deliberate: the model falls back to its own default, which is
  // what choosing "None" means.
  assert.deepEqual(reasoningEffortBody('none', 'gpt-5'), {});
});

test('an unsupported model never receives a reasoning parameter', () => {
  // Unknown models are the common case; sending an unknown field would break
  // them, so the guard is what makes the dropdown safe to show globally.
  assert.deepEqual(reasoningEffortBody('high', 'claude-sonnet-4'), {});
  assert.deepEqual(reasoningEffortBody('max', 'llama-3.3-70b'), {});
  assert.deepEqual(reasoningEffortBody('high', ''), {});
  assert.deepEqual(reasoningEffortBody('high', undefined), {});
});

test('OpenAI-style models receive reasoning_effort', () => {
  assert.deepEqual(reasoningEffortBody('high', 'gpt-5'), { reasoningEffort: 'high' });
  assert.deepEqual(reasoningEffortBody('medium', 'gpt-5.1-codex'), { reasoningEffort: 'medium' });
  assert.deepEqual(reasoningEffortBody('xhigh', 'o4-mini'), { reasoningEffort: 'xhigh' });
  assert.deepEqual(reasoningEffortBody('max', 'gpt-oss-120b'), { reasoningEffort: 'xhigh' });
});

test('"minimal" is downgraded to "low" for OpenAI-compatible endpoints', () => {
  // Not every endpoint accepts `minimal`; `low` is the portable neighbour, so
  // the request is not rejected outright.
  assert.deepEqual(reasoningEffortBody('minimal', 'gpt-5'), { reasoningEffort: 'low' });
});

test('max maps to the strongest reasoning value supported by the installed AI SDK', () => {
  assert.deepEqual(reasoningEffortBody('max', 'gpt-5'), { reasoningEffort: 'xhigh' });
});

test('Gemini is not advertised because local providers use the OpenAI-compatible transport', () => {
  assert.equal(supportsReasoningControl('gemini-2.5-pro'), false);
  assert.deepEqual(reasoningEffortBody('high', 'gemini-2.5-pro'), {});
});

test('an unknown or malformed level coerces to the default instead of leaking through', () => {
  assert.equal(normalizeReasoningEffort('bogus'), 'none');
  assert.equal(normalizeReasoningEffort(''), 'none');
  assert.equal(normalizeReasoningEffort(42), 'none');
  assert.equal(normalizeReasoningEffort({}), 'none');
  assert.equal(normalizeReasoningEffort(undefined), 'none');
  // Casing and stray whitespace from the UI are tolerated.
  assert.equal(normalizeReasoningEffort('  HIGH '), 'high');
  assert.deepEqual(reasoningEffortBody('  HIGH ', 'gpt-5'), { reasoningEffort: 'high' });
});

test('every advertised level is accepted by the normalizer', () => {
  for (const level of REASONING_EFFORTS) {
    assert.equal(normalizeReasoningEffort(level), level);
  }
});

test('model capability detection is case-insensitive and prefix tolerant', () => {
  assert.equal(supportsReasoningEffort('GPT-5'), true);
  assert.equal(supportsReasoningEffort('openai/gpt-5-turbo'), true);
  assert.equal(supportsReasoningEffort('o3'), true);
  assert.equal(supportsReasoningEffort('claude-sonnet-4'), false);
  assert.equal(supportsReasoningControl('gemini-2.5-pro'), false);
  assert.equal(supportsReasoningControl('gpt-5'), true);
  assert.equal(supportsReasoningControl('claude-sonnet-4'), false);
  assert.equal(supportsReasoningControl(''), false);
  assert.equal(supportsReasoningControl(undefined), false);
});

test('the composer label is human readable and defaults to None', () => {
  assert.equal(reasoningEffortLabel('none'), 'None');
  assert.equal(reasoningEffortLabel('xhigh'), 'Extra high');
  assert.equal(reasoningEffortLabel('max'), 'Max');
  assert.equal(reasoningEffortLabel('nonsense'), 'None');
  assert.equal(reasoningEffortLabel(undefined), 'None');
});

test('reasoningEffortBody is pure and does not mutate a shared object', () => {
  const first = reasoningEffortBody('high', 'gpt-5');
  const second = reasoningEffortBody('low', 'gpt-5');
  assert.deepEqual(first, { reasoningEffort: 'high' });
  assert.deepEqual(second, { reasoningEffort: 'low' });
  assert.notEqual(first, second);
});
