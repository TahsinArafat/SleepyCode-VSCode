import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTEXT_WINDOW_INFER_SOURCE,
  inferContextWindow,
  pickContextWindow,
} from '../src/context-window-core.ts';
import {
  DEFAULT_CONTEXT_WINDOW,
  STRUCTURED_HISTORY_BUDGET_TOKENS,
  estimateMessageTokens,
  structuredHistoryBudget,
} from '../src/compaction-core.ts';
import { droppedMessageCount, selectStructuredHistory } from '../src/iteration-core.ts';
import { assertSource } from './source-assert.mjs';

const agent = readFileSync('src/agent.ts', 'utf8');
const runtime = readFileSync('src/webview/runtime.ts', 'utf8');

test('a reported window beats a price-list window beats a name guess', () => {
  assert.deepEqual(pickContextWindow(1_000_000, 256_000, 'deepseek-v3'), { window: 1_000_000, source: 'reported' });
  assert.deepEqual(pickContextWindow(undefined, 1_000_000, 'some-model'), { window: 1_000_000, source: 'price' });
  assert.deepEqual(pickContextWindow(0, null, 'gemini-2.5-pro'), { window: 1_000_000, source: 'inferred' });
  // Nothing known: callers keep their conservative fallback rather than borrowing a window.
  assert.deepEqual(pickContextWindow(undefined, undefined, 'mystery-model'), {});
  assert.deepEqual(pickContextWindow(0, 0, ''), {});
  // A junk value from a provider must not become a "reported" window.
  assert.deepEqual(pickContextWindow(-1, Number.NaN, 'claude-sonnet-4'), {});
});

test('the name guess covers exactly the families the meter already assumed', () => {
  assert.equal(inferContextWindow('sleepy/deepseek-v3'), 256_000);
  assert.equal(inferContextWindow('qwen-256k'), 256_000);
  assert.equal(inferContextWindow('mimo-7b'), 256_000);
  assert.equal(inferContextWindow('gemini-2.5-flash'), 1_000_000);
  assert.equal(inferContextWindow('gemini-2.5-pro'), 1_000_000);
  assert.equal(inferContextWindow('some-pro-model'), 1_000_000);
  assert.equal(inferContextWindow('claude-sonnet-4'), undefined);
  assert.equal(inferContextWindow(''), undefined);
  assert.equal(inferContextWindow(undefined), undefined);
});

test('the in-page meter runs the compiled copy of the same rules', () => {
  const pageInfer = new Function(`${CONTEXT_WINDOW_INFER_SOURCE};return inferContextWindow;`)();
  const ids = ['deepseek-v3', 'qwen-256k', 'mimo-7b', 'gemini-2.5-flash', 'gemini-2.5-pro', 'some-pro-model', 'claude-sonnet-4', ''];
  for (const id of ids) {
    // The page uses 0 for "no idea"; the host uses undefined. Same answer otherwise.
    assert.equal(pageInfer(id) || undefined, inferContextWindow(id), `window for ${JSON.stringify(id)}`);
  }
  assert.equal(pageInfer('claude-sonnet-4'), 0, 'an unknown name must stay unknown in the page');
});

test('a 1M-window model keeps the history the conservative fallback drops', () => {
  // The reported bug: "400 older messages left this request..." on a 1M-window model whose
  // measured occupancy was ~150k. 60k is the budget used when the window is unknown, so the
  // trim was a window-resolution failure, not a real overflow.
  const messages = [];
  for (let index = 0; index < 400; index++) {
    messages.push({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(1_500) });
  }
  const perMessage = estimateMessageTokens(messages[0]);
  const total = messages.length * perMessage;
  assert.equal(total, 150_000);
  assert.ok(total > STRUCTURED_HISTORY_BUDGET_TOKENS, 'the fixture must exceed the conservative budget');

  const fallback = selectStructuredHistory(messages, STRUCTURED_HISTORY_BUDGET_TOKENS, estimateMessageTokens);
  assert.ok(droppedMessageCount(messages, fallback) > 200, 'the conservative budget drops most of the transcript');

  const budget = structuredHistoryBudget(1_000_000);
  assert.ok(budget > total, `a 1M window has room for the whole transcript (budget ${budget})`);
  const kept = selectStructuredHistory(messages, budget, estimateMessageTokens);
  assert.equal(droppedMessageCount(messages, kept), 0, 'no stored message may be dropped below the real window');
  assert.equal(kept.length, messages.length);
  // The same transcript on a genuinely small window still trims: the guard is the window,
  // not a blanket "never trim".
  const smallBudget = structuredHistoryBudget(32_000);
  assert.ok(droppedMessageCount(messages, selectStructuredHistory(messages, smallBudget, estimateMessageTokens)) > 0);
});

test('the send budget is resolved from the model that actually runs', () => {
  const routed = agent.indexOf('model = route.id;');
  const resolved = agent.indexOf('const modelInfo = this.getEffectiveModelInfo(selection.provider, model);');
  assert.ok(routed > 0, 'auto routing must still assign the concrete model id');
  assert.ok(resolved > routed, 'the window must be resolved after the model id is final');
  // The old shape resolved it from `selection.model` before any routing happened.
  assert.doesNotMatch(agent, /let modelInfo = this\.getEffectiveModelInfo\(selection\.provider, model\)/);
});

test('the window is read from the price list too, not only the catalog', () => {
  // A catalog only fills in after refreshModels; the price list is what the meter used.
  assertSource(agent, /this\.lastSleepyModelPrices\.find\(item => item\.modelId === modelId \|\| item\.name === modelId\)/);
  assertSource(agent, /pickContextWindow\(entry\?\.contextWindow, price\?\.contextWindow, modelId\)/);
  // No more borrowing an unrelated model's window.
  assert.doesNotMatch(agent, /const first = models\.find\(model => typeof model !== 'string'\)/);
});

test('sends and compaction budget with the same window and output reserve', () => {
  assertSource(agent, /structuredHistoryBudget\(contextWindow, maxOutputLimit\)/);
  assertSource(agent, /structuredHistoryBudget\(modelInfo\.contextWindow, modelInfo\.maxOutputLimit\)/);
  const calls = agent.match(/structuredHistory\(conversation, modelInfo\.contextWindow, modelInfo\.maxOutputLimit\)/g) ?? [];
  assert.equal(calls.length, 2, 'both send paths (first attempt and every iteration) pass both limits');
});

test('the meter is fed by the shared resolver instead of a private copy', () => {
  assertSource(runtime, /\$\{CONTEXT_WINDOW_INFER_SOURCE\}/);
  assertSource(runtime, /if\(!ctxLimit\)ctxLimit=inferContextWindow\(effectiveModel\)\|\|128000/);
  assert.doesNotMatch(runtime, /low\.includes\('256k'\)/, 'the hand-copied guess must be gone');
});

test('a real trim names the budget it was measured against', () => {
  // "400 messages left this request" with no figures is unactionable: next to a meter
  // reading 150k / 1M it looks like a 1M model misbehaving, not like a 60k budget.
  assertSource(agent, /left this request to stay within \$\{within\}/);
  assertSource(agent, /\$\{Math\.round\(budgetTokens \/ 1_000\)\}k of the model's \$\{Math\.round\(contextWindow \/ 1_000\)\}k-token window/);
  assertSource(agent, /no context window is known for this model/);
});

test('the unknown-window fallback is unchanged and still conservative', () => {
  // Only the resolution changed: a model no source can describe keeps the 60k budget.
  assert.equal(structuredHistoryBudget(undefined), STRUCTURED_HISTORY_BUDGET_TOKENS);
  assert.ok(STRUCTURED_HISTORY_BUDGET_TOKENS < DEFAULT_CONTEXT_WINDOW);
});
