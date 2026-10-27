/*
 * Fenced-code markup for the transcript.
 *
 * The transcript renders sanitized HTML from `marked`, not a React tree, so a
 * copy button cannot carry a React handler. It carries a data attribute instead
 * and the transcript delegates the click — which is why the attribute names here
 * are a contract, not a detail.
 *
 * Kept pure and free of DOM access so the markup can be asserted directly: the
 * webview modules import each other extensionlessly and cannot be loaded by the
 * node test runner, while this can.
 */

/** Lines before a block is collapsed. Matches the classic webview's threshold. */
export const COLLAPSE_LINES = 24;

/** HTML-escape a text node. Only used for the label, never for the body. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface CodeBlockInput {
  /** Highlighter id, e.g. `ts`. Empty when the fence had no language. */
  language: string;
  /** Display name for the chip, e.g. `TypeScript`. Falls back to `language`. */
  label: string;
  /** Already-highlighted and already-escaped code. Passed through verbatim. */
  content: string;
}

/**
 * Wrap highlighted code in the transcript's block chrome: a language chip, a
 * copy control, and a collapse for anything long enough to bury the next answer.
 *
 * The body is inserted as-is. It has already been highlighted and escaped by
 * `markdown.ts`; escaping it again would render `&lt;div&gt;` instead of `<div>`.
 * The label, by contrast, comes from the model's fence and is escaped here.
 */
export function codeBlockHtml(input: CodeBlockInput): string {
  const language = typeof input.language === 'string' ? input.language.trim() : '';
  const rawLabel = typeof input.label === 'string' ? input.label.trim() : '';
  const label = rawLabel || language;
  const content = typeof input.content === 'string' ? input.content : '';
  const lines = content ? content.replace(/\n$/, '').split('\n').length : 0;
  const collapsible = lines > COLLAPSE_LINES;

  const chip = label ? `<span class="code-block-lang">${escapeText(label)}</span>` : '';
  const expand = collapsible
    ? `<button type="button" class="code-block-expand" data-expand-code="1" aria-expanded="false">Show all ${lines} lines</button>`
    : '';

  return (
    `<div class="code-block${collapsible ? ' collapsed' : ''}"${language ? ` data-lang="${escapeText(language)}"` : ''}>` +
    `<div class="code-block-head">${chip}` +
    `<button type="button" class="code-block-copy" data-copy-code="1" aria-label="Copy code">Copy</button>` +
    `</div>` +
    `<pre dir="ltr"><code${language ? ` class="language-${escapeText(language)}"` : ''}>${content}</code></pre>` +
    expand +
    `</div>\n`
  );
}
