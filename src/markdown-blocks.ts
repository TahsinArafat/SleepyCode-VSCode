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
  /**
   * True when the last block is a code fence still being streamed.
   *
   * The caller must render that block as escaped text rather than highlighted code.
   * A highlighted fence is ~10,000 elements at 64k characters versus 7 for escaped
   * text, and `sanitize` pays for elements, so mid-stream highlighting is 30-35x more
   * expensive for output that is thrown away on the next delta anyway. See the note on
   * `isOpenFence` for the measurements.
   */
  openFence: boolean;
}

/** Tokens that render to nothing and would only pollute the block list. */
const SKIPPED = new Set(['space', 'def']);

type Lexer = { lexer(src: string): any; walkTokens(tokens: any, walk: (token: any) => void): void };

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * Whether a fenced code token is still open at end of document — i.e. the reply is
 * still streaming inside it.
 *
 * A closed fence's `raw` ends with its own delimiter; an unterminated one runs to EOF.
 * Indented code blocks have no delimiter and are never "open", because they cannot be
 * closed by a delimiter arriving on a later delta.
 *
 * This matters because an open fence is the transcript's worst case by a wide margin,
 * and not for the reason the block cache suggests. Measured on the shipping pipeline
 * (a 64k-char fenced block streamed as 969 deltas of 66 chars):
 *
 *   lex                      51 ms
 *   parser + highlight     1179 ms
 *   linkify                  79 ms
 *   sanitize                4997 ms      <- the dominant term
 *   textDirections           80 ms
 *
 * `sanitize` pays for NODE COUNT, not bytes: the same 64k of code is ~9,853 elements
 * when highlighted and 7 when escaped as text, so one `sanitize` costs 10.3 ms
 * highlighted versus 0.2 ms escaped and the whole stream is 30-35x cheaper (6262 ms
 * to 178 ms at 64k). While the fence is open its content is re-rendered from scratch on
 * every delta anyway — the block's cache key is its raw text, which changes each time —
 * so highlighting early buys nothing and is thrown away. It is highlighted once, when
 * the fence closes and the block stops changing.
 *
 * The classic webview already works this way (`closeCode(open)` in
 * `src/webview/runtime.ts`); this brings the React path in line.
 */
function isOpenFence(token: any): boolean {
  const raw = String(token?.raw ?? '');
  if (!FENCE_OPEN.test(raw)) return false;
  const lines = raw.split('\n');
  const lastContent = lines.length > 1 && lines[lines.length - 1] === '' ? lines[lines.length - 2] : lines[lines.length - 1];
  return !FENCE_CLOSE.test(String(lastContent ?? ''));
}

export function splitMarkdownBlocks(marked: Lexer, source: unknown): MarkdownSplit {
  const src = String(source ?? '');
  if (!src.trim()) return { whole: false, blocks: [], openFence: false };

  const tokens = marked.lexer(src);
  let rawHtml = false;
  marked.walkTokens(tokens, (token) => { if (token.type === 'html') rawHtml = true; });
  if (rawHtml) return { whole: true, blocks: [], openFence: false };

  // Reference definitions live outside the tokens, so they are part of the key:
  // identical paragraph text with a different target must not share a cache row.
  const links = Object.keys(tokens.links ?? {}).length ? JSON.stringify(tokens.links) : '';
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    if (SKIPPED.has(token.type)) continue;
    blocks.push({ key: `${token.type}\u0000${links}\u0000${token.raw}`, raw: token.raw, token });
  }
  const last = blocks[blocks.length - 1];
  const openFence = last !== undefined && last.token?.type === 'code' && isOpenFence(last.token);
  return { whole: false, blocks, openFence };
}
