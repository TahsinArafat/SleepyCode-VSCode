/**
 *  thinking-block handling for models that emit chain-of-thought as XML in the
 * text channel instead of reasoning-delta parts. Pure module (no imports) so it
 * stays loadable by the strip-types test runner.
 */

/**
 * Splits streamed model text into visible answer content and  thinking
 * blocks. Keeps the chat answer clean while still surfacing the thinking.
 * Stateful: a block may span many chunks.
 */
export function createThinkSplitter(): (chunk: string) => { content: string; thinking: string } {
  let inThink = false;
  const OPEN = /<(think|thinking)\b[^>]*>/gi;
  const CLOSE = /<\/(think|thinking)\s*>/gi;
  return (chunk) => {
    let content = '';
    let thinking = '';
    let rest = chunk;
    if (inThink) {
      CLOSE.lastIndex = 0;
      const close = CLOSE.exec(rest);
      if (!close) {
        thinking += rest;
        return { content, thinking };
      }
      thinking += rest.slice(0, close.index);
      inThink = false;
      rest = rest.slice(close.index + close[0].length);
    }
    while (rest) {
      OPEN.lastIndex = 0;
      const open = OPEN.exec(rest);
      if (!open) {
        content += rest;
        break;
      }
      content += rest.slice(0, open.index);
      const tail = rest.slice(open.index + open[0].length);
      CLOSE.lastIndex = 0;
      const close = CLOSE.exec(tail);
      if (!close) {
        thinking += tail;
        inThink = true;
        break;
      }
      thinking += tail.slice(0, close.index);
      rest = tail.slice(close.index + close[0].length);
    }
    return { content, thinking };
  };
}

/** Stateless removal of  thinking blocks from a complete text (e.g. subagent results). */
export function stripThinkBlocks(text: string): string {
  return text.replace(/<(think|thinking)\b[^>]*>[\s\S]*?<\/(think|thinking)\s*>/gi, '');
}
