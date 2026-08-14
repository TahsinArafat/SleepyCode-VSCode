import test from 'node:test';
import assert from 'node:assert/strict';
import { pausedByStepLimit } from '../src/iteration-core.ts';

test('max-step pause only triggers when a bounded tool loop stops on tool calls at the limit', () => {
  assert.equal(pausedByStepLimit(50, 50, 'tool-calls'), true);
  assert.equal(pausedByStepLimit(50, 49, 'tool-calls'), false);
  assert.equal(pausedByStepLimit(50, 50, 'stop'), false);
  assert.equal(pausedByStepLimit(0, 500, 'tool-calls'), false);
});
