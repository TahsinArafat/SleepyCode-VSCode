import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAutoModel, sortModelsA2Z } from '../src/model-routing-core.ts';

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
