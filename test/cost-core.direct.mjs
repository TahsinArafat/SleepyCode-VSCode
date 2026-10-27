import test from 'node:test';
import assert from 'node:assert/strict';
import * as cost from '../src/cost-core.ts';

/*
 * The classic composer showed what a turn cost: a per-request figure from the
 * account's model prices, a session total, throughput, and a measured context
 * readout. The React UI shows a context ring and nothing else — no cost anywhere,
 * in the chat or in settings.
 *
 * The arithmetic is the part worth pinning. Prompt tokens include cache READS, so
 * billing the whole prompt at the input rate would overcharge every cached turn,
 * and cache writes are billed on top rather than inside the prompt count.
 */

const price = { modelId: 'sleepy-pro', name: 'Sleepy Pro', inputPrice: 3, outputPrice: 15, cacheReadPrice: 0.3, cacheWritePrice: 3.75 };
const tokens = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test('a price is found by model id or by display name', () => {
  const prices = [price, { modelId: 'other', name: 'Other', inputPrice: 1, outputPrice: 2 }];
  assert.equal(cost.findPrice(prices, 'sleepy-pro')?.modelId, 'sleepy-pro');
  assert.equal(cost.findPrice(prices, 'Sleepy Pro')?.modelId, 'sleepy-pro');
  // An unknown model prices at nothing rather than at someone else's rate.
  assert.equal(cost.findPrice(prices, 'unknown'), undefined);
  assert.equal(cost.findPrice(undefined, 'sleepy-pro'), undefined);
  assert.equal(cost.findPrice(prices, undefined), undefined);
});

test('cached reads are billed at the cache rate, not the input rate', () => {
  // 1000 prompt tokens of which 800 were cache reads.
  const result = cost.costOf(tokens(1000, 500, 800), price);
  assert.ok(result);
  // 200 uncached * 3/1e6 + 800 cached * 0.3/1e6
  assert.equal(Number(result.input.toFixed(9)), Number((200 * 3 / 1e6).toFixed(9)));
  assert.equal(Number(result.cacheRead.toFixed(9)), Number((800 * 0.3 / 1e6).toFixed(9)));
  assert.equal(Number(result.output.toFixed(9)), Number((500 * 15 / 1e6).toFixed(9)));
  assert.equal(Number(result.total.toFixed(9)), Number((result.input + result.cacheRead + result.cacheWrite + result.output).toFixed(9)));
});

test('cache writes are billed on top of the prompt, not inside it', () => {
  // Anthropic-style: the write is a separate charge and is not part of the prompt
  // count, so it must not be counted twice.
  const withWrite = cost.costOf(tokens(1000, 0, 0, 400), price);
  assert.ok(withWrite);
  assert.equal(Number(withWrite.cacheWrite.toFixed(9)), Number((400 * 3.75 / 1e6).toFixed(9)));
  assert.equal(withWrite.input + withWrite.cacheRead, Number((1000 * 3 / 1e6).toFixed(9)));
});

test('missing cache rates fall back to the input rate', () => {
  // A provider that does not price caching separately charges it as input.
  const plain = { modelId: 'm', name: 'M', inputPrice: 2, outputPrice: 8 };
  const result = cost.costOf(tokens(100, 0, 50, 20), plain);
  assert.ok(result);
  assert.equal(Number(result.cacheRead.toFixed(9)), Number((50 * 2 / 1e6).toFixed(9)));
  assert.equal(Number(result.cacheWrite.toFixed(9)), Number((20 * 2 / 1e6).toFixed(9)));
});

test('cached reads are capped at the prompt count', () => {
  // A provider reporting more cache reads than prompt tokens would otherwise bill
  // negative uncached input.
  const result = cost.costOf(tokens(100, 0, 500), price);
  assert.ok(result);
  assert.equal(result.input, 0, 'nothing left to bill at the input rate');
  assert.equal(Number(result.cacheRead.toFixed(9)), Number((100 * 0.3 / 1e6).toFixed(9)), 'billed for what was actually read');
});

test('an unpriced model has no cost rather than a zero one', () => {
  // Zero would render as "$0.00", which reads as "this was free".
  assert.equal(cost.costOf(tokens(1000, 1000), undefined), null);
  assert.equal(cost.costOf(tokens(1000, 1000), { modelId: 'm', name: 'M' }), null);
  assert.equal(cost.costOf(tokens(0, 0), price), null, 'nothing spent, nothing to report');
});

test('costs are shown with enough precision to be useful', () => {
  // A single small turn costs well under a cent; "$0.00" would say nothing.
  assert.equal(cost.formatCost(0.0012), '$0.0012');
  assert.equal(cost.formatCost(0.000123), '$0.00012');
  assert.equal(cost.formatCost(0.5), '$0.50');
  assert.equal(cost.formatCost(12.345), '$12.35');
  // Unknown is stated as unknown, not as zero.
  assert.equal(cost.formatCost(null), '—');
  assert.equal(cost.formatCost(undefined), '—');
  assert.equal(cost.formatCost(0), '$0');
});

test('token counts are abbreviated the way the classic pills were', () => {
  assert.equal(cost.formatTokens(999), '999');
  assert.equal(cost.formatTokens(1000), '1k');
  assert.equal(cost.formatTokens(1500), '1.5k');
  assert.equal(cost.formatTokens(1_000_000), '1M');
  assert.equal(cost.formatTokens(2_450_000), '2.45M');
  assert.equal(cost.formatTokens(0), '0');
  assert.equal(cost.formatTokens(undefined), '0');
});

test('the context readout grades how full the window is', () => {
  // The classic bar turned amber then red; the colour is the only signal that a
  // turn is about to be trimmed.
  assert.equal(cost.contextLevel(0), 'safe');
  assert.equal(cost.contextLevel(49), 'safe');
  assert.equal(cost.contextLevel(50), 'warn');
  assert.equal(cost.contextLevel(79), 'warn');
  assert.equal(cost.contextLevel(80), 'danger');
  assert.equal(cost.contextLevel(100), 'danger');
  // A limit of zero cannot be a percentage, and dividing by it would be Infinity.
  assert.equal(cost.contextPercent(500, 0), 0);
  assert.equal(cost.contextPercent(500, undefined), 0);
  assert.equal(cost.contextPercent(50, 100), 50);
  assert.equal(cost.contextPercent(200, 100), 100, 'clamped, never above 100%');
});

test('a session summary totals tokens and cost across models', () => {
  const prices = [price, { modelId: 'cheap', name: 'Cheap', inputPrice: 1, outputPrice: 1 }];
  const summary = cost.sessionSummary([
    { model: 'sleepy-pro', input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
    { model: 'cheap', input: 2000, output: 2000, cacheRead: 0, cacheWrite: 0 },
  ], prices);
  assert.equal(summary.tokens.input, 3000);
  assert.equal(summary.tokens.output, 2500);
  // 1000*3/1e6 + 500*15/1e6 + 2000*1/1e6 + 2000*1/1e6 = 0.003 + 0.0075 + 0.002 + 0.002
  assert.equal(Number(summary.cost.total.toFixed(9)), Number((0.003 + 0.0075 + 0.002 + 0.002).toFixed(9)));
});

test('a session with an unpriced model reports tokens but no cost', () => {
  // Half a number is worse than none: a total that silently omits a model says
  // the session was cheaper than it was.
  const summary = cost.sessionSummary([{ model: 'mystery', input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }], []);
  assert.equal(summary.tokens.input, 100);
  assert.equal(summary.cost.total, null);
  assert.equal(cost.formatCost(summary.cost.total), '—');
});

test('an empty session has no cost rather than a zero one', () => {
  const summary = cost.sessionSummary([], []);
  assert.equal(summary.tokens.input, 0);
  assert.equal(summary.cost.total, null);
});

test('throughput is only stated when it was measured', () => {
  // The classic hid the pill unless the provider reported a rate; a fabricated
  // rate is worse than no rate.
  assert.equal(cost.formatSpeed(42.4), '42 tok/s');
  assert.equal(cost.formatSpeed(0), null);
  assert.equal(cost.formatSpeed(undefined), null);
});
// ---------------------------------------------------------------- session records
//
// A session total needs the records for THIS conversation. UsageRecord had no
// conversation id, so a per-conversation figure could not be derived at all.

test('a record carries the conversation it belongs to', () => {
  assert.equal(cost.recordConversation({ conversationId: 'c1' }), 'c1');
  // Older records predate the field; they are unscoped rather than mis-scoped.
  assert.equal(cost.recordConversation({}), '');
  assert.equal(cost.recordConversation(undefined), '');
  assert.equal(cost.recordConversation({ conversationId: 7 }), '');
});

test('records are filtered to one conversation, oldest first', () => {
  const records = [
    { conversationId: 'c1', timestamp: 3 },
    { conversationId: 'c2', timestamp: 1 },
    { conversationId: 'c1', timestamp: 2 },
    { timestamp: 0 },
  ];
  assert.deepEqual(cost.recordsFor(records, 'c1').map(r => r.timestamp), [2, 3]);
  assert.deepEqual(cost.recordsFor(records, 'c2').map(r => r.timestamp), [1]);
  // An unscoped record belongs to no conversation, so it is in no total.
  assert.deepEqual(cost.recordsFor(records, '').map(r => r.timestamp), []);
  assert.deepEqual(cost.recordsFor(undefined, 'c1'), []);
});

test('the newest record decides the speed shown for a session', () => {
  // The readout is "how fast is this going", not an average across models.
  const records = [
    { conversationId: 'c1', timestamp: 1, tokensPerSecond: 10 },
    { conversationId: 'c1', timestamp: 3, tokensPerSecond: 55 },
    { conversationId: 'c1', timestamp: 2, tokensPerSecond: 30 },
  ];
  assert.equal(cost.latestSpeed(records), 55);
  assert.equal(cost.latestSpeed([]), undefined);
  assert.equal(cost.latestSpeed([{ timestamp: 1 }]), undefined);
});
