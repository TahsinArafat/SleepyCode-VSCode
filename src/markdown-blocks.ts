/*
 * Split a markdown document into the top-level blocks the transcript renders
 * one at a time.
 *
 * The transcript re-parses a message on every streamed delta, so it renders each
 * block separately and reuses the blocks that did not change. That is only sound
 * when splitting cannot change the output, so two documents are refused here and
 * rendered whole instead:
 *
 *   - raw HTML, because an element may open in one block and close in a later
 *     one (and the HTML parser carries unclosed formatting tags across
 *     paragraphs, so even inline HTML is enough to disqualify);
 *   - nothing else — link reference definitions are folded into every block key
 *     rather than refused, since they only change how links resolve.
 *
 * DOM-free on purpose: `marked` is injected, the answers are strings, and the
 * policy these keys feed is asserted by `test/markdown-blocks.direct.mjs`.
 */

export interface MarkdownBlock {
  /**
   * Cache identity for this block's rendered HTML. Carries the token type and
   * the document's link definitions, because both change what the same raw text
   * renders to.
   */
  key: string;
  /** The block's source text, used only for assertions and diagnostics. */
  raw: string;
  /** The parsed token, so the caller renders it without lexing the document again. */
  token: any;
}

export interface MarkdownSplit {
  /** Render the document in one pass; `blocks` is empty when true. */
  whole: boolean;
  blocks: MarkdownBlock[];
}

/** Tokens that render to nothing and would only pollute the block list. */
const SKIPPED = new Set(['space', 'def']);

type Lexer = { lexer(src: string): any; walkTokens(tokens: any, walk: (token: any) => void): void };

export function splitMarkdownBlocks(marked: Lexer, source: unknown): MarkdownSplit {
  const src = String(source ?? '');
  if (!src.trim()) return { whole: false, blocks: [] };

  const tokens = marked.lexer(src);
  let rawHtml = false;
  marked.walkTokens(tokens, (token) => { if (token.type === 'html') rawHtml = true; });
  if (rawHtml) return { whole: true, blocks: [] };

  // Reference definitions live outside the tokens, so they are part of the key:
  // identical paragraph text with a different target must not share a cache row.
  const links = Object.keys(tokens.links ?? {}).length ? JSON.stringify(tokens.links) : '';
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    if (SKIPPED.has(token.type)) continue;
    blocks.push({ key: `${token.type}\u0000${links}\u0000${token.raw}`, raw: token.raw, token });
  }
  return { whole: false, blocks };
}