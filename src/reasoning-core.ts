/**
 * Pure helpers for persisting chain-of-thought so later steps can reread it.
 * This module has NO imports so the strip-types test runner can load it.
 *
 * Compaction still summarizes visible answer text only. Reasoning is stored on
 * assistant messages as native `reasoning` parts (and on transcript work items
 * for the UI / resume backfill). Models that require previous thinking need
 * those parts on the next request, not a 3_000-character display clip.
 */

export const DEFAULT_PERSISTED_REASONING = 32_000;
export const MIN_PERSISTED_REASONING = 3_000;
export const MAX_PERSISTED_REASONING_LIMIT = 200_000;

const THINK_BLOCK = /<(think|thinking)\b[^>]*>[\s\S]*?<\/(think|thinking)\s*>/gi;
const THINK_OPEN = /^<(think|thinking)\b[^>]*>/i;
const THINK_CLOSE = /<\/(think|thinking)\s*>$/i;

/** Clamp a settings / config value to the persist budget range. */
export function normalizePersistedReasoningLimit(raw: unknown, fallback = DEFAULT_PERSISTED_REASONING): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_PERSISTED_REASONING, Math.min(MAX_PERSISTED_REASONING_LIMIT, Math.round(value)));
}

const TRUNCATION_MARK = '\n…(earlier thinking omitted)\n';

/** Hard-cap stored thinking, keeping the newest tokens models need to continue. */
export function clipPersistedReasoning(text: string, limit: number): { text: string; truncated: boolean } {
  const cap = normalizePersistedReasoningLimit(limit);
  if (text.length <= cap) return { text, truncated: false };
  const keep = Math.max(1, cap - TRUNCATION_MARK.length);
  return { text: `${TRUNCATION_MARK}${text.slice(-keep)}`, truncated: true };
}

/** Stored thinking without the clip marker, used when attaching to later requests. */
export function persistedReasoningBody(text: string): string {
  return text.replace(/^\n?…\(earlier thinking omitted\)\n?/, '').replace(/\n…\(truncated\)$/, '');
}

/** Append incoming thinking into the persist buffer without exceeding the budget. */
export function rememberReasoningText(previous: string, incoming: string, limit: number): { text: string; truncated: boolean } {
  if (!incoming) return clipPersistedReasoning(previous, limit);
  return clipPersistedReasoning(`${previous}${incoming}`, limit);
}

/** Concatenate reasoning work items from one assistant turn. */
export function collectReasoningText(work: readonly { kind?: string; text?: string }[] | undefined): string {
  return (work ?? [])
    .filter(item => item.kind === 'reasoning' && item.text?.trim())
    .map(item => persistedReasoningBody(item.text!).trim())
    .filter(Boolean)
    .join('\n\n');
}

/** One reasoning string per assistant transcript item, oldest first. */
export function reasoningTextsFromItems(
  items: readonly { role?: string; work?: readonly { kind?: string; text?: string }[] }[] | undefined,
): string[] {
  return (items ?? [])
    .filter(item => item.role === 'assistant')
    .map(item => collectReasoningText(item.work))
    .filter(Boolean);
}

/** Pull the inner text of XML think/thinking blocks. */
export function extractThinkBlocks(text: string): string {
  const matches = String(text ?? '').match(THINK_BLOCK);
  if (!matches?.length) return '';
  return matches
    .map(block => block.replace(THINK_OPEN, '').replace(THINK_CLOSE, ''))
    .join('\n')
    .trim();
}

export function messageHasReasoning(message: { role?: string; content?: unknown } | undefined): boolean {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.some(part => {
    if (!part || typeof part !== 'object') return false;
    const record = part as { type?: string; text?: string };
    return record.type === 'reasoning' && Boolean(record.text?.trim());
  });
}

function stripThinkFromText(text: string): string {
  return text.replace(THINK_BLOCK, '');
}

function mergeReasoningText(existing: string | undefined, incoming: string): string {
  const previous = existing?.trim() ?? '';
  const next = incoming.trim();
  if (!previous) return next;
  if (!next || previous.includes(next)) return previous;
  if (next.includes(previous)) return next;
  return `${previous}\n\n${next}`;
}

function cleanTextPart(part: unknown): unknown {
  if (!part || typeof part !== 'object') return part;
  const record = part as { type?: string; text?: string };
  if (record.type === 'text' && typeof record.text === 'string') {
    return { ...record, text: stripThinkFromText(record.text) };
  }
  return part;
}

/** Put reasoning first and keep visible text free of leftover XML think tags. */
export function withReasoningPart(content: unknown, reasoningText: string): unknown {
  const text = persistedReasoningBody(reasoningText).trim();
  if (!text) return content;
  const reasoning = { type: 'reasoning', text };
  if (typeof content === 'string') {
    const visible = stripThinkFromText(content);
    return visible ? [reasoning, { type: 'text', text: visible }] : [reasoning];
  }
  if (Array.isArray(content)) {
    const existing = content.find(part => part && typeof part === 'object' && (part as { type?: string }).type === 'reasoning') as { type?: string; text?: string } | undefined;
    const cleaned = content.filter(part => !(part && typeof part === 'object' && (part as { type?: string }).type === 'reasoning')).map(cleanTextPart);
    const merged = mergeReasoningText(existing?.text, text);
    return merged ? [{ type: 'reasoning', text: merged }, ...cleaned] : cleaned;
  }
  if (content == null || content === '') return [reasoning];
  return [reasoning, content];
}

/**
 * Attach thinking to the newest assistant message, merging later segments so
 * earlier thinking is not dropped when a later step already has a reasoning part.
 */
export function attachReasoningToLatestAssistant<T extends { role?: string; content?: unknown }>(
  messages: T[],
  reasoningText: string,
): T[] {
  const text = persistedReasoningBody(reasoningText).trim();
  if (!text) return messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    messages[index] = { ...message, content: withReasoningPart(message.content, text) };
    return messages;
  }
  messages.push({ role: 'assistant', content: [{ type: 'reasoning', text }] } as T);
  return messages;
}

/**
 * Pair transcript reasoning work (oldest first) onto assistant messages that
 * were persisted before thinking was stored on the message itself.
 */
export function backfillAssistantReasoning<T extends { role?: string; content?: unknown }>(
  messages: T[],
  reasoningTexts: readonly string[],
): T[] {
  if (!messages.length || !reasoningTexts.length) return messages;
  const assistantIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role === 'assistant') assistantIndexes.push(index);
  }
  let textCursor = reasoningTexts.length - 1;
  for (let cursor = assistantIndexes.length - 1; cursor >= 0 && textCursor >= 0; cursor--) {
    const index = assistantIndexes[cursor]!;
    const message = messages[index]!;
    if (messageHasReasoning(message)) continue;
    const text = reasoningTexts[textCursor--]?.trim();
    if (!text) continue;
    messages[index] = { ...message, content: withReasoningPart(message.content, text) };
  }
  return messages;
}
