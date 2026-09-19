/**
 * Pure subagent-loop helpers. This module has NO imports so it can be loaded by
 * the dependency-free direct tests (node --experimental-strip-types).
 *
 * The parent agent delegates bounded work to explorer/reviewer/worker
 * subagents. Those subagents often finish "successfully" with no parent-visible
 * text because the custom loop:
 *   1. treats any native tool call as "not a final answer" and discards the
 *      accompanying visible text,
 *   2. treats XML <invoke> blocks the same way, even when leftover prose exists,
 *   3. only keeps the last empty-looking step in `lastTextOnly`, so think-only
 *      or whitespace-only finals wipe earlier usable text,
 *   4. returns the placeholder "(Subagent completed without a text response.)"
 *      when the harvested string is empty.
 */

export const SUBAGENT_EMPTY_RESPONSE = '(Subagent completed without a text response.)';

const THINK_BLOCK = /<(think|thinking)\b[^>]*>[\s\S]*?<\/(think|thinking)\s*>/gi;
const INVOKE_BLOCK = /<invoke[\s\S]*?<\/invoke>/gi;

export type SubagentStepKind = 'native-tools' | 'xml-tools' | 'final' | 'empty';

export type SubagentStepDecision = {
  kind: SubagentStepKind;
  /** Visible answer text after think/XML stripping. Empty when none remains. */
  visibleText: string;
};

export type HarvestedSubagentText = {
  text: string;
  usedFallback: boolean;
};

/** Stateless removal of thinking blocks from a complete model text. */
export function stripThinkBlocks(text: string): string {
  return text.replace(THINK_BLOCK, '');
}

/** Strip Claude-Code style XML tool tags and collapse leftover blank lines. */
export function stripInvokeBlocks(text: string): string {
  return text.replace(INVOKE_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Visible answer text from a raw model step: thinking and XML tool tags are
 * removed. Whitespace-only leftovers become an empty string.
 */
export function visibleStepText(rawText: string): string {
  return stripInvokeBlocks(stripThinkBlocks(rawText ?? ''));
}

/**
 * Classify one subagent generation step.
 *
 * Native tool calls win over XML parsing because streamText already executed
 * them. A step with leftover visible prose is still classified as a tool step
 * so the loop can continue, but that prose is preserved for harvest.
 */
export function classifySubagentStep(rawText: string, nativeCallCount: number, xmlCallCount: number): SubagentStepDecision {
  const visibleText = visibleStepText(rawText);
  if (nativeCallCount > 0) return { kind: 'native-tools', visibleText };
  if (xmlCallCount > 0) return { kind: 'xml-tools', visibleText };
  if (visibleText) return { kind: 'final', visibleText };
  return { kind: 'empty', visibleText: '' };
}

/**
 * Keep the most recent non-empty visible text from any step. Think-only or
 * whitespace-only later steps must not wipe an earlier usable answer.
 */
export function rememberVisibleText(previous: string, candidate: string): string {
  const next = visibleStepText(candidate);
  return next || previous;
}

/**
 * Final parent-visible subagent answer. Prefer a dedicated final step; otherwise
 * use leftover prose from tool steps. Never return the empty-response
 * placeholder when any usable text was harvested.
 */
export function harvestSubagentText(finalStepText: string, leftoverText: string): HarvestedSubagentText {
  const text = (finalStepText.trim() || leftoverText.trim());
  if (text) return { text, usedFallback: false };
  return { text: SUBAGENT_EMPTY_RESPONSE, usedFallback: true };
}
