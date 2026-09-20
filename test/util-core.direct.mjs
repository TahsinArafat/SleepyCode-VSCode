import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeInput, toolTask } from '../src/util.ts';

test('summarizeInput includes the installed skill name', () => {
  assert.equal(summarizeInput({ name: 'brainstorming' }), 'brainstorming');
  assert.equal(summarizeInput({ path: 'src/util.ts', name: 'ignored' }), 'src/util.ts');
});

test('reading an installed skill shows which skill is being read', () => {
  assert.equal(
    toolTask('skillsmp_read_installed', { name: 'brainstorming' }),
    'Reading installed skill · brainstorming',
  );
});
