import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMessageTokens, summarizeFileOperations, STRUCTURED_HISTORY_BUDGET_TOKENS } from '../src/compaction-core.ts';

test('estimateMessageTokens counts string, part, and tool-call payloads', () => {
  const plain = estimateMessageTokens({ role: 'user', content: 'a'.repeat(400) });
  assert.equal(plain, 100); // 400 chars / 4
  const withParts = estimateMessageTokens({ role: 'user', content: [{ type: 'text', text: 'b'.repeat(200) }] });
  assert.equal(withParts, 50);
  const withTools = estimateMessageTokens({ role: 'assistant', content: '', toolCalls: [{ id: 'x'.repeat(400) }] });
  assert.ok(withTools >= 100, 'tool call payload must be counted');
  assert.equal(estimateMessageTokens({ role: 'assistant' }), 0);
});

test('summarizeFileOperations separates read from modified files', () => {
  const items = [
    { work: [
      { kind: 'task', tool: 'read_file', text: 'Read · src/agent.ts' },
      { kind: 'task', tool: 'read_file', text: 'Read · src/tools.ts' },
      { kind: 'task', tool: 'write_file', text: 'Write · src/new.ts' },
      { kind: 'task', tool: 'replace_text', text: 'Edit · src/tools.ts' },
    ] },
  ];
  const summary = summarizeFileOperations(items);
  assert.match(summary, /Files already read .*src\/agent\.ts/);
  const modifiedLine = summary.split('\n').find(line => line.startsWith('Files modified')) ?? '';
  assert.match(modifiedLine, /src\/new\.ts/);
  assert.match(modifiedLine, /src\/tools\.ts/);
  // A modified file must not also be advertised as merely read.
  const readLine = summary.split('\n').find(line => line.startsWith('Files already read')) ?? '';
  assert.doesNotMatch(readLine, /src\/tools\.ts/);
  assert.doesNotMatch(readLine, /src\/new\.ts/);
});

test('summarizeFileOperations ignores non-task work and empty input', () => {
  assert.equal(summarizeFileOperations([]), '');
  const summary = summarizeFileOperations([{ work: [{ kind: 'reasoning', text: 'thinking about src/x.ts' }] }]);
  assert.equal(summary, '');
});

test('the structured history budget leaves room under the compaction threshold', () => {
  // Budget must be a real positive number and comfortably below default windows.
  assert.ok(STRUCTURED_HISTORY_BUDGET_TOKENS > 0);
  assert.ok(STRUCTURED_HISTORY_BUDGET_TOKENS < 128_000);
});
