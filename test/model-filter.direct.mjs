import test from 'node:test';
import assert from 'node:assert/strict';
import { isChatModel } from '../src/model-filter.ts';

// Entry shapes come from the real SleepyAI gateway GET /v1/models payload
// (dashboard app/api/v1/[...path]/route.ts): modelId/modelType/capabilities.
const chat = ({ modelType = 'chat-completion', id = 'gpt-4o', ...extra } = {}) => ({ id, modelId: id, name: 'Chat model', modelType, ...extra });
const entry = (model, id = typeof model.id === 'string' ? model.id : 'm') => isChatModel(model, id);

test('modelType chat-completion and anthropic-responses are chat models', () => {
  assert.equal(entry(chat({ modelType: 'chat-completion' })), true);
  assert.equal(entry(chat({ modelType: 'anthropic-responses' })), true);
  assert.equal(entry(chat({ modelType: 'Chat Completion' })), true); // case/space tolerant
});

test('modelType modalities are rejected', () => {
  for (const modelType of ['image', 'video', 'tts', 'stt', 'audio', 'speech', 'embedding', 'moderation', 'rerank']) {
    assert.equal(entry(chat({ modelType }), `m-${modelType}`), false, `${modelType} should be filtered out`);
  }
});

test('vision-capable chat model stays (capabilities merged with chat type)', () => {
  assert.equal(entry(chat({ modelType: 'chat-completion', capabilities: { chat: true, image: true } }), 'vision-chat'), true);
});

test('generic type/category fields are respected', () => {
  assert.equal(entry({ id: 'a', type: 'chat' }), true);
  assert.equal(entry({ id: 'b', category: 'text' }), true);
  assert.equal(entry({ id: 'c', kind: 'tts' }), false);
});

test('modality-only entries: text keeps, pure audio rejects, unknown keeps', () => {
  assert.equal(entry({ id: 'm1', modalities: ['text', 'image'] }), true);
  assert.equal(entry({ id: 'm2', outputModalities: ['text'] }), true);
  assert.equal(entry({ id: 'm3', modalities: ['audio'] }), false);
  assert.equal(entry({ id: 'm4', capabilities: { audio: true } }), false);
  assert.equal(entry({ id: 'm5', modalities: ['weird-modal'] }), true);
});

test('no signals: ID heuristic filters obvious modalities, keeps chat ids', () => {
  assert.equal(entry({ id: 'whisper-1' }), false);
  assert.equal(entry({ id: 'gpt-image-1' }), false);
  assert.equal(entry({ id: 'tts-1' }), false);
  assert.equal(entry({ id: 'sora' }), false);
  assert.equal(entry({ id: 'dall-e-3' }), false);
  assert.equal(entry({ id: 'sleepy-v2.5-pro' }), true);
  assert.equal(entry({ id: 'claude-3-5-sonnet' }), true);
  assert.equal(entry({ id: 'gpt-4o-mini' }), true);
});

test('default modelType when absent on a chat-like entry', () => {
  // The gateway defaults modelType to "chat-completion" when unset.
  assert.equal(entry({ id: 'free-chat', name: 'Free chat' }), true);
});