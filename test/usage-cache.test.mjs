import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
  // The React UI reads its numbers from the host's sessionStats, which come from
  // `costOf` (src/cost-core.ts). The cache-rate split is pinned in detail by
  // cost-core.direct.mjs -- this test used to pin it against the legacy webview's
  // private copy of the same arithmetic.
  assert.match(read('src/cost-core.ts'), /const cacheReadPrice = typeof price\.cacheReadPrice === 'number' \? price\.cacheReadPrice : inputPrice;/);
  assert.match(read('src/cost-core.ts'), /const cacheWritePrice = typeof price\.cacheWritePrice === 'number' \? price\.cacheWritePrice : inputPrice;/);
  assert.match(read('src/cost-core.ts'), /const cachedRead = Math\.min\(Math\.max\(0, tokens\.cacheRead \|\| 0\), input\);/);
  assert.match(read('src/cost-core.ts'), /const uncachedInput = input - cachedRead;/);
});

test('usage aggregate reports the cache tokens the webview renders', () => {
  const usage = read('src/usage.ts');
  // Live tokens and session totals must both count cache reads/writes.
  assert.match(usage, /cacheRead:/);
  assert.match(usage, /cacheWrite:/);
});
