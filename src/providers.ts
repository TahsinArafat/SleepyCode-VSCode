import { fetchSleepyModels, getSleepyToken, sleepyApiBase } from './sleepyai';

export interface Provider {
  id: string;
  name: string;
  baseURL: string;
  customHeaders?: Record<string, string>;
  modelList?: string[];
  isSleepy?: boolean;
}

const NON_TEXT = /(?:^|[^a-z0-9])(?:vision|image|audio|speech|voice|tts|stt|asr|whisper|embed(?:dings?)?|rerank|moderation|transcri|imagen|dall-?e|flux|sora|veo|midjourney|stable-diffusion|4v|vl)(?:[^a-z0-9]|$)/i;

export function isTextModel(id: string): boolean {
  return !NON_TEXT.test(id);
}

export const SLEEPY_AUTO_MODEL_ID = '__sleepyai_auto__';

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputLimit?: number;
  recommended?: boolean;
  isAuto?: boolean;
}

export type ModelEntry = { id: string; name?: string; raw?: Record<string, unknown> };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function entryId(item: Record<string, unknown>): string {
  const raw = typeof item.id === 'string'
    ? item.id
    : typeof item.name === 'string'
      ? item.name
      : typeof item.model === 'string'
        ? item.model
        : '';
  return raw.replace(/^models\//, '').trim();
}

export function modelEntries(body: unknown): ModelEntry[] {
  const record = asRecord(body);
  if (!record) return [];
  const candidateLists = [record.data, record.models, record.objects];
  const values = candidateLists.find(Array.isArray) as unknown[] | undefined;
  if (!values) return [];
  const result: ModelEntry[] = [];
  for (const value of values) {
    const item = asRecord(value);
    if (!item) continue;
    const id = entryId(item);
    if (!id) continue;
    const name = typeof item.name === 'string' && !item.name.startsWith('models/') ? item.name : undefined;
    result.push({ id, name, raw: item });
  }
  return result;
}

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'sleepyai',
    name: 'SleepyAI',
    baseURL: sleepyApiBase(),
    isSleepy: true,
  },
];

export function cloneProviders(providers: Provider[] = DEFAULT_PROVIDERS): Provider[] {
  return providers.map(provider => ({
    ...provider,
    customHeaders: provider.customHeaders ? { ...provider.customHeaders } : undefined,
    modelList: provider.modelList ? [...provider.modelList] : undefined,
  }));
}

export function getProvider(providers: Provider[], id: string | undefined): Provider | undefined {
  return providers.find(p => p.id === id);
}

export function listProviders(providers: Provider[]): Provider[] {
  return providers;
}

export function providerModelsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`;
}

function numericField(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function modelInfo(entry: ModelEntry): ModelInfo {
  return {
    id: entry.id,
    name: entry.name || entry.id,
    contextWindow: numericField(entry.raw, 'contextWindow', 'context_window', 'context_length'),
    maxOutputLimit: numericField(entry.raw, 'maxOutputLimit', 'max_output_limit', 'max_output_tokens'),
  };
}

function mergeExtraModels(models: ModelInfo[], extraModels: string[]): ModelInfo[] {
  if (!extraModels.length) return models;
  const existing = new Set(models.map(model => model.id));
  for (const id of extraModels.map(item => item.trim()).filter(Boolean)) {
    if (isTextModel(id) && !existing.has(id)) {
      existing.add(id);
      models.push({ id, name: id });
    }
  }
  return models;
}

export async function fetchProviderModels(
  provider: Provider,
  apiKey: string,
  extraModels: string[] = [],
): Promise<ModelInfo[]> {
  if (provider.isSleepy) {
    const token = await getSleepyToken();
    if (!token) throw new Error(`${provider.name} is not signed in. Open Settings and sign in to continue.`);
    let models: ModelInfo[] = [];
    try {
      models = await fetchSleepyModels(token);
    } catch {
      // Fall through to a provider-level fallback model list if one is configured.
    }
    if (!models.length && provider.modelList?.length) {
      models = provider.modelList.filter(isTextModel).map(id => ({ id, name: id }));
    }
    mergeExtraModels(models, extraModels);
    if (!models.length) throw new Error(`${provider.name} lists no compatible models. Sign in to load your models.`);
    return models;
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...provider.customHeaders,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let entries: ModelEntry[] = [];
  let requestError = '';
  try {
    const response = await fetch(providerModelsUrl(provider.baseURL), { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      requestError = `${provider.name} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} from /models.`;
    } else {
      const body = await response.json().catch(() => undefined);
      entries = modelEntries(body);
      if (!entries.length) requestError = `${provider.name} returned an unsupported or empty /models response.`;
    }
  } catch (error) {
    requestError = error instanceof Error ? error.message : String(error);
  }

  let models: ModelInfo[] = [];
  if (entries.length) {
    const textEntries = entries.filter(entry => isTextModel(entry.id));
    // Generic providers sometimes use model names that trip the conservative filter.
    // If every returned model is filtered out, keep the provider's raw list rather than hiding all models.
    models = (textEntries.length ? textEntries : entries).map(modelInfo);
  } else if (provider.modelList?.length) {
    models = provider.modelList.filter(isTextModel).map(id => ({ id, name: id }));
  }

  mergeExtraModels(models, extraModels);
  if (!models.length) {
    throw new Error(requestError || `${provider.name} lists no compatible models.`);
  }
  return models;
}
