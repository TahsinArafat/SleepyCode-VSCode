/*
 * LaTeX math in the transcript: find it, render it, put it back.
 *
 * Math has to be pulled out of the markdown BEFORE marked sees it, because marked treats
 * `_`, `*`, `\` and `$` as markup and mangles LaTeX -- `a_1 + b_2` becomes emphasis, and
 * `\frac{1}{2}` loses its backslash. So each formula is replaced with a placeholder token,
 * the surrounding markdown is parsed normally, and the rendered HTML is substituted back
 * afterwards.
 *
 * Pure and DOM-free on purpose: `katex` is injected, the answers are strings, and both the
 * tokenizer's rules and the currency guards are asserted by `test/math-blocks.direct.mjs`.
 * The webview modules import each other extensionlessly and cannot be loaded by the node
 * test runner, while this can.
 *
 * The rules are the ones the classic webview shipped (`protectInlineMath` in
 * `src/webview/runtime.ts`), including its currency guards: `$5.00` and `costs $10 and $20`
 * are prose, not math, and rendering them as formulas is worse than leaving them alone.
 * This replaces that implementation, which was a single unreadable line.
 */

/** Placeholder delimiters: private-use code points that cannot occur in model output. */
const TOKEN_START = '\uE6C2';
const TOKEN_END = '\uE6C3';

/** How many formulas to keep rendered. The same formula is rendered on every frame. */
export const MATH_CACHE_MAX = 256;

export type MathRenderer = (tex: string, displayMode: boolean) => string;

/** Render one formula, with a bounded cache in front of an expensive renderer. */
export function createMathRenderer(
  render: MathRenderer | undefined,
  cacheMax: number = MATH_CACHE_MAX,
): { render: (tex: string, displayMode: boolean) => string; size: () => number } {
  const cache = new Map<string, string>();
  const fallback = (tex: string) => '<code>' + escapeHtml(tex) + '</code>';
  return {
    render(tex: string, displayMode: boolean): string {
      const src = String(tex ?? '');
      // An empty formula is not a formula; emitting an empty span would leave a gap.
      if (!src.trim()) return '';
      const key = (displayMode ? 'D:' : 'I:') + src;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      if (!render) {
        // No renderer yet, which normally means KaTeX is still loading. NOT cached: pinning
        // the fallback would show raw LaTeX in a code span for the rest of the session even
        // after KaTeX arrives. The next render of this formula typesets it properly.
        return fallback(src);
      }
      let html: string;
      try {
        html = render(src, displayMode);
      } catch {
        // A renderer that is present but failed -- unusable LaTeX, or a load error -- is a
        // real result, so it is cached: re-trying every frame is the expensive path.
        return fallback(src);
      }
      if (cache.size >= cacheMax) {
        // FIFO. A formula that falls out is simply rendered again.
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) return html;
        cache.delete(oldest);
      }
      cache.set(key, html);
      return html;
    },
    size: () => cache.size,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A price, not a formula. */
function isCurrency(tex: string): boolean {
  return /^\d[\d,]*\.?\d*$/.test(tex.replace(/\s/g, ''));
}

export interface MathSplit {
  /** The line with every formula replaced by a placeholder token. */
  text: string;
  /** Rendered HTML per token, in the order the tokens appear in `text`. */
  html: string[];
}

/**
 * Pull the math out of one line, rendering as it goes.
 *
 * Supports `\(...\)`, `\[...\]`, `$$...$$` and `$...$`. The bracketed and double-dollar forms
 * are display math; single dollars are inline.
 *
 * Returns the placeholder-substituted text plus the HTML to splice back in, so the caller can
 * hand `text` to marked and then call `restoreMath` on the result.
 */
export function protectInlineMath(
  line: unknown,
  allowMath: boolean | undefined,
  renderer: { render: (tex: string, displayMode: boolean) => string },
  budget: { remaining: number },
): MathSplit {
  const html: string[] = [];
  if (allowMath === false) return { text: String(line ?? ''), html };

  const take = (tex: string, display: boolean): string => {
    // Bound the work, the way the code highlighter is bounded: an answer that is one
    // enormous formula must not stall the frame it arrives on.
    const allowance = Math.min(4_000, budget.remaining);
    budget.remaining -= Math.max(0, allowance);
    const source = tex.length > allowance ? tex.slice(0, allowance) : tex;
    html.push(renderer.render(source, display));
    return TOKEN_START + (html.length - 1) + TOKEN_END;
  };

  let text = String(line ?? '');

  // \( \) and \[ \] first: their content is unambiguous, and doing them before the dollar
  // forms stops a `$` inside `\(...\)` from being read as a delimiter.
  text = text.replace(/\\([([])([\s\S]*?)\\([)\]])(?!\s*\$)/g, (_m, open: string, tex: string) => take(tex, open === '['));

  text = text.replace(/(^|[^\\$])\$\$([^$]+?)\$\$|(^|[^\\$])\$([^$\n]+?)\$/g, (match, leadD, texD, leadS, texS) => {
    const display = texD !== undefined;
    const tex = display ? texD : texS;
    if (!display) {
      // Currency guards. A leading or trailing space means the dollars are quoting a range,
      // and a bare number is a price. Both are far likelier in prose than a formula.
      if (/^\s/.test(tex) || /\s$/.test(tex) || isCurrency(tex)) return match;
    }
    return (display ? leadD : leadS) + take(tex, display);
  });

  return { text, html };
}

/** Put rendered math back into parsed HTML. */
export function restoreMath(html: unknown, tokens: readonly string[]): string {
  if (!tokens.length) return String(html ?? '');
  return String(html ?? '').replace(
    new RegExp(TOKEN_START + '(\\d+)' + TOKEN_END, 'g'),
    (_match, index: string) => tokens[Number(index)] ?? '',
  );
}

/** Whether a string still carries a placeholder, so callers can skip the restore pass. */
export function hasMathTokens(value: unknown): boolean {
  return String(value ?? '').includes(TOKEN_START);
}