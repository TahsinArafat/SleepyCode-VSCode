import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTEXT_WINDOW_INFER_SOURCE,
  contextWindowFromError,
  inferContextWindow,
  pickContextWindow,
} from '../src/context-window-core.ts';
import {
  DEFAULT_CONTEXT_WINDOW,
  STRUCTURED_HISTORY_BUDGET_TOKENS,
  estimateHistoryTokens,
  estimateMessageTokens,
  shouldAutoCompact,
  structuredHistoryBudget,
} from '../src/compaction-core.ts';
import { prepareStructuredHistory } from '../src/iteration-core.ts';
import { assertSource } from './source-assert.mjs';

const agent = readFileSync('src/agent.ts', 'utf8');
const runtime = readFileSync('src/webview/runtime.ts', 'utf8');

test('a learned window beats a reported one beats a price-list one beats a name guess', () => {
  assert.deepEqual(pickContextWindow(128_000, 128_000, 'gpt-4o', 64_000), { window: 64_000, source: 'learned' });
  assert.deepEqual(pickContextWindow(1_000_000, 256_000, 'deepseek-v3'), { window: 1_000_000, source: 'reported' });
  assert.deepEqual(pickContextWindow(undefined, 1_000_000, 'some-model'), { window: 1_000_000, source: 'price' });
  assert.deepEqual(pickContextWindow(0, null, 'gemini-2.5-pro'), { window: 1_000_000, source: 'inferred' });
  // Nothing known: callers keep their conservative fallback rather than borrowing a window.
  assert.deepEqual(pickContextWindow(undefined, undefined, 'mystery-model'), {});
  assert.deepEqual(pickContextWindow(0, 0, ''), {});
  // A junk value from a provider must not become a "reported" window.
  assert.deepEqual(pickContextWindow(-1, Number.NaN, ''), {});
});

test('the name guess covers exactly the families the meter already assumed', () => {
  assert.equal(inferContextWindow('sleepy/deepseek-v3'), 256_000);
  assert.equal(inferContextWindow('qwen-256k'), 256_000);
  assert.equal(inferContextWindow('mimo-7b'), 256_000);
  assert.equal(inferContextWindow('gemini-2.5-flash'), 1_000_000);
  assert.equal(inferContextWindow('gemini-2.5-pro'), 1_000_000);
  assert.equal(inferContextWindow('some-pro-model'), 1_000_000);
  assert.equal(inferContextWindow(''), undefined);
  assert.equal(inferContextWindow(undefined), undefined);
});

test('a window is learned from the rejection the provider actually sent', () => {
  // Every vendor words it differently; the number in it is the only authoritative
  // figure available for an endpoint whose catalog reports nothing.
  assert.equal(contextWindowFromError("This model's maximum context length is 128000 tokens."), 128_000);
  assert.equal(contextWindowFromError('prompt is too long: 210000 tokens > 200000 maximum'), 200_000);
  assert.equal(contextWindowFromError('input token count exceeds the maximum number of tokens allowed: 1048576'), 1_048_576);
  assert.equal(contextWindowFromError('context window of 32768 exceeded'), 32_768);
  assert.equal(contextWindowFromError('context 8192 exceeded'), 8_192);
  assert.equal(contextWindowFromError('max context: 200,000'), 200_000);
  assert.equal(contextWindowFromError('invalid request: limit of 65536 tokens reached'), 65_536);
  // A message with no plausible window in it must not invent one.
  assert.equal(contextWindowFromError('rate limit reached: 3 requests'), undefined);
  assert.equal(contextWindowFromError('stream closed unexpectedly'), undefined);
  // Prose that happens to contain the word must not become a budget.
  assert.equal(contextWindowFromError('in the context of 2024 we did fine'), undefined);
  assert.equal(contextWindowFromError(''), undefined);
  assert.equal(contextWindowFromError(undefined), undefined);
});

test('a 1M-window conversation is sent whole, never cut to fit a budget', () => {
  // The reported bug: "400 older messages left this request..." on a 1M-window model
  // whose measured occupancy was ~150k. The budget that produced it was the 60k
  // fallback for a model nobody could describe — and the cut itself was the loss.
  const messages = [];
  for (let index = 0; index < 400; index++) {
    messages.push({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(1_500) });
  }
  const total = messages.length * estimateMessageTokens(messages[0]);
  assert.equal(total, 150_000);
  assert.ok(total > STRUCTURED_HISTORY_BUDGET_TOKENS, 'the fixture must exceed the conservative budget');
  // No budget argument: the send path is not allowed to shrink the transcript.
  assert.equal(prepareStructuredHistory(messages).length, messages.length);
  const budget = structuredHistoryBudget(1_000_000);
  assert.ok(budget > total, `a 1M window has room for the whole transcript (budget ${budget})`);
});

test('preparation repairs orphans and aligns to a user turn without dropping turns', () => {
  const stored = [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'missing', toolName: 'read_file', input: {} }] },
    { role: 'user', content: 'carry on' },
  ];
  const prepared = prepareStructuredHistory(stored);
  assert.equal(prepared.length, 3, 'no turn is dropped');
  assert.equal(prepared[0].role, 'user');
  // The unanswered call becomes a note: the model still knows it asked for the tool.
  assert.match(JSON.stringify(prepared[1].content), /did not finish/);
  // A leading tool result cannot start a request, so it is dropped — the only drop
  // that exists, and it is about validity, not size.
  const leadingOrphan = [
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'gone' }] },
    { role: 'user', content: 'hello' },
  ];
  assert.deepEqual(prepareStructuredHistory(leadingOrphan).map(message => message.role), ['user']);
});

test('the send budget is resolved from the model that actually runs', () => {
  const routed = agent.indexOf('model = route.id;');
  const resolved = agent.indexOf('const modelInfo = this.getEffectiveModelInfo(selection.provider, model);');
  assert.ok(routed > 0, 'auto routing must still assign the concrete model id');
  assert.ok(resolved > routed, 'the window must be resolved after the model id is final');
  assert.doesNotMatch(agent, /let modelInfo = this\.getEffectiveModelInfo\(selection\.provider, model\)/);
});

test('the window is read from the price list too, not only the catalog', () => {
  // A catalog only fills in after refreshModels; the price list is what the meter used.
  assertSource(agent, /this\.lastSleepyModelPrices\.find\(item => item\.modelId === modelId \|\| item\.name === modelId\)/);
  // SleepyAI models carry a window per model, so the learned one has to be consulted
  // alongside them or a relay's real limit is never used.
  assertSource(agent, /pickContextWindow\(entry\?\.contextWindow, price\?\.contextWindow, modelId, this\.learnedContextWindows\[modelId\]\)/);
  // No more borrowing an unrelated model's window.
  assert.doesNotMatch(agent, /const first = models\.find\(model => typeof model !== 'string'\)/);
});

test('the meter is fed by the shared resolver instead of a private copy', () => {
  assertSource(runtime, /\$\{CONTEXT_WINDOW_INFER_SOURCE\}/);
  assertSource(runtime, /if\(!ctxLimit\)ctxLimit=inferContextWindow\(effectiveModel\)\|\|128000/);
  assert.doesNotMatch(runtime, /low\.includes\('256k'\)/, 'the hand-copied guess must be gone');
});

test('nothing on the send path trims history to a token budget', () => {
  // The transcript and the request are the same history. Shrinking the request is
  // context loss with no summary, and it is what made the agent look forgetful.
  assert.doesNotMatch(agent, /selectStructuredHistory/);
  assert.doesNotMatch(agent, /trimToolResultsForRequest/);
  assert.doesNotMatch(agent, /liveSliceBudget/);
  assert.doesNotMatch(agent, /left this request to stay within/);
  assertSource(agent, /private structuredHistory\(conversation: Conversation\): ModelMessage\[\] \{/);
});

test('the unknown-window fallback is unchanged and still conservative', () => {
  // Only the resolution changed: a model no source can describe keeps the 60k budget.
  assert.equal(structuredHistoryBudget(undefined), STRUCTURED_HISTORY_BUDGET_TOKENS);
  assert.ok(STRUCTURED_HISTORY_BUDGET_TOKENS < DEFAULT_CONTEXT_WINDOW);
});

test('a 200k model with a 32k output limit no longer drops anything at 167k', () => {
  // The reported symptom: "every request after almost 167k context window starts
  // message dropping". 166_500 is exactly 200_000 - 1_500 overhead - 32_000 output
  // reserve, so the drop point was the send budget, not the model's window.
  const window = 200_000;
  const outputLimit = 32_000;
  const budget = structuredHistoryBudget(window, outputLimit);
  assert.equal(budget, 166_500);

  const messages = [];
  let tokens = 0;
  while (tokens < 175_000) {
    const content = 'x'.repeat(4_000);
    messages.push({ role: messages.length % 2 ? 'assistant' : 'user', content });
    tokens = messages.length * estimateMessageTokens(content.length ? { content } : {});
  }
  const sent = prepareStructuredHistory(messages);
  assert.equal(sent.length, messages.length, 'a history ABOVE the budget is still sent whole');
  // The budget is now only a compaction trigger. Compaction fires before the window
  // fills, and it leaves a summary; it never removes a message from the request.
  assert.equal(shouldAutoCompact(0, window, budget, budget), true, 'reaching the budget triggers a summary');
});

test('a 200k model with a 32k output limit no longer cuts at 167k', () => {
  // The reported symptom: "every request after almost 167k context window starts
  // message dropping". 166_500 is exactly 200_000 - 1_500 overhead - 32_000 output
  // reserve, so the drop point was the send budget, not anything the model said.
  const window = 200_000;
  const outputLimit = 32_000;
  const budget = structuredHistoryBudget(window, outputLimit);
  assert.equal(budget, 166_500);

  const page = 'x'.repeat(4_000);
  const messages = [];
  while (estimateHistoryTokens(messages, estimateMessageTokens) <= budget) {
    messages.push({ role: messages.length % 2 ? 'assistant' : 'user', content: page });
  }
  assert.ok(estimateHistoryTokens(messages, estimateMessageTokens) > budget, 'the fixture exceeds the old cut line');

  // Sent whole. The budget is a compaction trigger now, never a cut: it decides when
  // to summarize, not what to leave out of the request.
  assert.equal(prepareStructuredHistory(messages).length, messages.length);
  // And reaching that budget does trigger a summary, so the conversation still shrinks
  // — with a summary the user can read and undo, not by silently forgetting.
  assert.equal(shouldAutoCompact(0, window, budget, budget), true);
});
