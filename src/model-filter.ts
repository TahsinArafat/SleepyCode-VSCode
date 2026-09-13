/**
 * Chat-completion model filter for provider /models payloads.
 *
 * Providers (SleepyAI's GET /v1/models in particular) list image, video, TTS,
 * and STT models alongside chat models, but the extension can only drive chat
 * completions. The SleepyAI gateway classifies every entry with a `modelType`
 * field whose chat values are exactly "chat-completion" and
 * "anthropic-responses" (see dashboard app/api/v1/[...path]/route.ts
 * buildModelRunnabilityContext) — every other value is a metered modality.
 * That classification field is decisive when present; modality/capability
 * fields only matter for providers that omit it; the ID heuristic is the last
 * resort.
 */

/** Decisive classification fields (type / modelType / category / kind). */
const TYPE_FIELDS = ['type', 'modelType', 'model_type', 'category', 'kind'];

/** Modality/capability fields used only when no classification field exists. */
const MODALITY_FIELDS = ['modalities', 'outputModalities', 'output_modalities', 'inputModalities', 'input_modalities', 'capabilities'];

/** Normalized chat-capable classification values. */
const CHAT_TYPES = new Set([
  'chat', 'chatcompletion', 'text', 'textchat', 'llm', 'language',
  'code', 'completion', 'textgeneration', 'texttotext', 'anthropicresponses',
]);

/** Normalized metered-modality values (the gateway's non-chat classifications). */
const NON_CHAT_TYPES = new Set([
  'image', 'video', 'tts', 'stt', 'audio', 'speech', 'asr', 'voice',
  'embedding', 'embeddings', 'moderation', 'rerank', 'transcription',
  'speechtotext', 'texttospeech', 'imagegeneration', 'text2img', 'text2video',
  'dalle', 'imagen', 'flux', 'sora', 'veo', 'midjourney', 'stablediffusion',
]);

/** Conservative ID fragments for payloads that carry no signal at all. */
const NON_CHAT_ID = /(?:^|[^a-z0-9])(?:image|video|tts|stt|audio|speech|voice|asr|whisper|transcri|embed(?:dings?)?|rerank|moderation|dall-?e|flux|sora|veo|midjourney|stable-diffusion)(?:[^a-z0-9]|$)/i;

const normalized = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const isChatSignal = (value: string): boolean => {
  const n = normalized(value);
  return CHAT_TYPES.has(n) || n.includes('chat');
};

const isNonChatSignal = (value: string): boolean => {
  const n = normalized(value);
  if (NON_CHAT_TYPES.has(n)) return true;
  return n.startsWith('image') || n.startsWith('video') || n.startsWith('audio') || n.startsWith('speech')
    || n.startsWith('embed') || n.startsWith('moderation') || n.startsWith('transcri') || n.startsWith('rerank');
};

function collectSignals(model: Record<string, unknown>, fields: string[]): string[] {
  const values: string[] = [];
  for (const key of fields) {
    const value = model[key];
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (item !== null && item !== undefined) values.push(String(item));
    } else if (value && typeof value === 'object') {
      for (const [flagKey, flagValue] of Object.entries(value)) {
        if (flagValue === true) values.push(flagKey);
        else if (typeof flagValue === 'string') values.push(flagValue);
      }
    }
  }
  return values;
}

/** Decide whether a /models entry can be used through chat completions. */
export function isChatModel(model: Record<string, unknown>, id: string): boolean {
  // 1. Classification field is decisive (the gateway's own answer). A model whose
  //    declared types are ALL chat-capable is usable — e.g. a vision chat model is
  //    still modelType "chat-completion".
  const typeValues = collectSignals(model, TYPE_FIELDS);
  if (typeValues.length) return typeValues.every(value => isChatSignal(value));

  // 2. Modality/capability fields: chat or text wins (vision models still emit
  //    text); a pure non-chat set is rejected; unknown sets are kept.
  const modalityValues = collectSignals(model, MODALITY_FIELDS);
  if (modalityValues.length) {
    if (modalityValues.some(value => isChatSignal(value))) return true;
    if (modalityValues.some(value => isNonChatSignal(value))) return false;
  }

  // 3. No signal at all: conservative ID heuristic.
  return !NON_CHAT_ID.test(id);
}