import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/providers.ts', import.meta.url), 'utf8');
const NON_TEXT = /(?:^|[^a-z0-9])(?:vision|image|audio|speech|voice|tts|stt|asr|whisper|embed(?:dings?)?|rerank|moderation|transcri|imagen|dall-?e|flux|sora|veo|midjourney|stable-diffusion|4v|vl)(?:[^a-z0-9]|$)/i;
const isTextModel = id => !NON_TEXT.test(id);
const providerModelsUrl = baseURL => `${baseURL.replace(/\/+$/, '')}/models`;

function modelEntries(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const values = [body.data, body.models, body.objects].find(Array.isArray);
  if (!values) return [];
  return values.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const raw = typeof value.id === 'string' ? value.id : typeof value.name === 'string' ? value.name : typeof value.model === 'string' ? value.model : '';
    const id = raw.replace(/^models\//, '').trim();
    return id ? [{ id }] : [];
  });
}

async function fetchProviderModels(provider, apiKey, extraModels = []) {
  const headers = { accept: 'application/json', ...provider.customHeaders };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let entries = [];
  let requestError = '';
  try {
    const response = await fetch(providerModelsUrl(provider.baseURL), { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) requestError = `${provider.name} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} from /models.`;
    else entries = modelEntries(await response.json().catch(() => undefined));
  } catch (error) {
    requestError = error instanceof Error ? error.message : String(error);
  }
  let models = [];
  if (entries.length) {
    const textEntries = entries.filter(entry => isTextModel(entry.id));
    models = (textEntries.length ? textEntries : entries).map(entry => ({ id: entry.id, name: entry.id }));
  } else if (provider.modelList?.length) {
    models = provider.modelList.filter(isTextModel).map(id => ({ id, name: id }));
  }
  const existing = new Set(models.map(model => model.id));
  for (const id of extraModels) if (isTextModel(id) && !existing.has(id)) { existing.add(id); models.push({ id, name: id }); }
  if (!models.length) throw new Error(requestError || `${provider.name} lists no compatible models.`);
  return models;
}

describe('provider source contract', () => {
  it('ships SleepyAI as the only built-in default', () => {
    const defaults = source.slice(source.indexOf('export const DEFAULT_PROVIDERS'), source.indexOf('export function cloneProviders'));
    assert.match(defaults, /id:\s*['"]sleepyai['"]/);
    assert.match(defaults, /isSleepy:\s*true/);
    assert.match(defaults, /sleepyApiBase\(\)/);
    for (const id of ['opencode', 'openrouter', 'groq', 'gemini', 'mistral', 'ollama']) {
      assert.doesNotMatch(defaults, new RegExp(`id:\\s*['"]${id}['"]`));
    }
  });

  it('keeps generic compatibility discovery without making it a default', () => {
    assert.match(source, /baseURL\.replace\(\/\\\/\+\$\/,[^)]*\).*\/models/);
    assert.ok(source.includes('record.models'));
    assert.ok(source.includes('record.objects'));
    assert.ok(source.includes('customHeaders'));
  });
});

describe('provider helpers', () => {
  it('filters known non-text models', () => {
    assert.equal(isTextModel('gpt-4'), true);
    assert.equal(isTextModel('gpt-4-vision'), false);
    assert.equal(isTextModel('whisper-1'), false);
    assert.equal(isTextModel('text-embedding-3-small'), false);
  });

  it('normalizes trailing slashes', () => {
    assert.equal(providerModelsUrl('https://example.com/v1/'), 'https://example.com/v1/models');
  });

  it('parses common model list shapes', () => {
    assert.deepEqual(modelEntries({ data: [{ id: 'a' }] }), [{ id: 'a' }]);
    assert.deepEqual(modelEntries({ models: [{ name: 'models/b' }] }), [{ id: 'b' }]);
    assert.deepEqual(modelEntries({ objects: [{ model: 'c' }] }), [{ id: 'c' }]);
  });
});

describe('fetchProviderModels behavior', () => {
  it('uses normalized URL and custom auth headers for an explicitly configured endpoint', async () => {
    const provider = { id: 'test', name: 'Test', baseURL: 'https://test.com/v1/', customHeaders: { 'X-Custom': 'value' } };
    let requestedUrl = '';
    let receivedHeaders;
    globalThis.fetch = async (url, init) => {
      requestedUrl = String(url); receivedHeaders = init.headers;
      return { ok: true, json: async () => ({ data: [{ id: 'model-a' }] }) };
    };
    await fetchProviderModels(provider, 'key123');
    assert.equal(requestedUrl, 'https://test.com/v1/models');
    assert.equal(receivedHeaders['X-Custom'], 'value');
    assert.equal(receivedHeaders.authorization, 'Bearer key123');
  });

  it('falls back to configured IDs and surfaces HTTP errors without fallback', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' });
    const fallback = await fetchProviderModels({ id: 'x', name: 'X', baseURL: 'https://x/v1', modelList: ['fallback'] }, '');
    assert.deepEqual(fallback.map(model => model.id), ['fallback']);
    await assert.rejects(fetchProviderModels({ id: 'x', name: 'X', baseURL: 'https://x/v1' }, ''), /HTTP 401 Unauthorized/);
  });

  it('does not hide every model if all IDs trip the conservative filter', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'custom-vl' }] }) });
    const models = await fetchProviderModels({ id: 'x', name: 'X', baseURL: 'https://x/v1' }, '');
    assert.deepEqual(models.map(model => model.id), ['custom-vl']);
  });
});
