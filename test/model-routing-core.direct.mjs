import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAutoModel, rankModelsByPrice, sortModelsA2Z } from '../src/model-routing-core.ts';

test('Auto chooses the cheapest fully-priced model and free models win', () => {
  const candidates = [
    { id: 'zeta', name: 'Zeta' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'free', name: 'Free Model' },
  ];
  const prices = [
    { modelId: 'zeta', inputPrice: 0.2, outputPrice: 0.8 },
    { modelId: 'alpha', inputPrice: 0.1, outputPrice: 0.2 },
    { modelId: 'free', inputPrice: 0, outputPrice: 0 },
  ];
  assert.deepEqual(chooseAutoModel(candidates, prices), {
    id: 'free', combinedPrice: 0, reason: 'Cheapest SleepyAI model · free',
  });
});

test('Auto breaks equal-price ties A-Z and falls back A-Z without complete pricing', () => {
  const candidates = [
    { id: 'z', name: 'Zulu 10' },
    { id: 'a2', name: 'Alpha 2' },
    { id: 'a10', name: 'Alpha 10' },
  ];
  assert.deepEqual(sortModelsA2Z(candidates).map(model => model.id), ['a2', 'a10', 'z']);
  assert.equal(chooseAutoModel(candidates, [
    { modelId: 'z', inputPrice: 1, outputPrice: 1 },
    { modelId: 'a2', inputPrice: 1, outputPrice: 1 },
  ])?.id, 'a2');
  assert.deepEqual(chooseAutoModel(candidates, [{ modelId: 'a2', inputPrice: 0.1 }]), {
    id: 'a2', reason: 'A–Z fallback',
  });
});

test('rankModelsByPrice orders cheapest-first with unpriced models appended A-Z', () => {
  const candidates = [
    { id: 'expensive', name: 'Expensive' },
    { id: 'free', name: 'Free Model' },
    { id: 'mid', name: 'Mid' },
    { id: 'unpriced', name: 'Unpriced' },
  ];
  const prices = [
    { modelId: 'expensive', inputPrice: 1, outputPrice: 1 },
    { modelId: 'free', inputPrice: 0, outputPrice: 0 },
    { modelId: 'mid', inputPrice: 0.1, outputPrice: 0.2 },
  ];
  const ranked = rankModelsByPrice(candidates, prices);
  assert.deepEqual(ranked.map(model => model.id), ['free', 'mid', 'expensive', 'unpriced']);
  assert.equal(ranked[0].combinedPrice, 0);
  assert.equal(ranked[3].combinedPrice, undefined);
});

test('rankModelsByPrice breaks equal-price ties A-Z', () => {
  const candidates = [
    { id: 'b', name: 'Beta' },
    { id: 'a', name: 'Alpha' },
  ];
  const prices = [
    { modelId: 'b', inputPrice: 0.5, outputPrice: 0.5 },
    { modelId: 'a', inputPrice: 0.5, outputPrice: 0.5 },
  ];
  assert.deepEqual(rankModelsByPrice(candidates, prices).map(model => model.id), ['a', 'b']);
});
