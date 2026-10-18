import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assertSource } from './source-assert.mjs';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('usage aggregate carries cache read and write tokens', () => {
  const usage = read('src/usage.ts');
  assert.match(usage, /cacheRead: number/);
  assert.match(usage, /cacheWrite: number/);
  assert.match(usage, /target\.cacheRead \+= record\.cacheReadTokens \?\? 0/);
  assert.match(usage, /target\.cacheWrite \+= record\.cacheWriteTokens \?\? 0/);
  // Both per-model and totals must be fed the same record so cache is included.
  assert.match(usage, /addTokens\(entry\.periods\.today, record\); addTokens\(totals\.today, record\)/);
});

test('usage records persist cache token fields', () => {
  const types = read('src/types.ts');
  assert.match(types, /cacheReadTokens\?: number;/);
  assert.match(types, /cacheWriteTokens\?: number;/);
  const usage = read('src/usage.ts');
  assert.match(usage, /record\.cacheReadTokens/);
});

test('agent reads provider cache token details', () => {
  const agent = read('src/agent.ts');
  assert.match(agent, /inputTokenDetails\?\.cacheReadTokens/);
  assert.match(agent, /inputTokenDetails\?\.cacheWriteTokens/);
  assert.match(agent, /cacheReadTokens: liveCacheRead/);
  assert.match(agent, /cacheWriteTokens: liveCacheWrite/);
  assert.match(agent, /cacheReadTokens: ucacheRead/);
});

test('webview cost model bills cache reads at the cache rate', () => {
  const runtime = read('src/webview/runtime.ts');
  assertSource(runtime, /cacheReadPrice/);
  assertSource(runtime, /cacheWritePrice/);
  assertSource(runtime, /cachedRead=Math\.min\(cacheReadTok,inTok\)/);
  assertSource(runtime, /uncachedInput=Math\.max\(0,inTok-cachedRead\)/);
  assertSource(runtime, /cacheRead:cacheReadCost/);
  assertSource(runtime, /total:inputCost\+cacheReadCost\+cacheWriteCost\+outputCost/);
});

test('webview live usage and session info surface cache tokens', () => {
  const runtime = read('src/webview/runtime.ts');
  assertSource(runtime, /cacheRead:m\.cacheReadTokens\|\|0/);
  assertSource(runtime, /cacheReadTok\+=live\.cacheRead\|\|0/);
  assertSource(runtime, /cacheCell/);
});
