/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { Marked } from "marked";
import katex from "katex";
import { escapeCodeHtml, getCodeLanguage, highlightCode } from "./codeLanguages";
import { codeBlockHtml } from "../../src/code-block-html.ts";
import { linkifyDevRefs } from "../../src/dev-refs.ts";
import { splitMarkdownBlocks } from "../../src/markdown-blocks.ts";
import {
  createMathRenderer,
  protectInlineMath,
  restoreMath,
  type MathRenderer,
} from "../../src/math-blocks.ts";
import {
  attributeAllowed,
  hrefAllowed,
  inputAllowed,
  srcAllowed,
  tagAllowed,
  tagDropped,
} from "../../src/markdown-policy.ts";

// GFM markdown (tables, task lists, fenced code, etc.). marked passes raw HTML
// through, so the output is filtered before it reaches the webview.
// Keep highlighting bounded across all blocks in a streaming response.
const HIGHLIGHT_BUDGET = 128_000;
// And math bounded separately: a formula is rendered by KaTeX, which is not cheap, and a
// reply that is one enormous formula must not stall the frame it arrives on.
const MATH_BUDGET = 64_000;
let highlightRemaining = 0;
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const code = text.replace(/\n$/, "") + "\n";
      const prefix = code.slice(0, Math.min(64_000, highlightRemaining));
      highlightRemaining -= prefix.length;
      const resolved = getCodeLanguage(prefix, lang?.trim().split(/\s+/, 1)[0]);
      const content = highlightCode(prefix, resolved.id) + escapeCodeHtml(code.slice(prefix.length));
      // Language chip, copy control and collapse live in `src/code-block-html.ts`
      // so the markup is assertable without a DOM. The transcript delegates the
      // clicks, since raw HTML cannot carry a React handler.
      return codeBlockHtml({ language: resolved.id, label: resolved.label, content });
    },
  },
});

// Filtering is an allowlist (`src/markdown-policy.ts`) applied to the parsed
// fragment: AI output is semi-trusted and marked passes its raw HTML through, so
// naming the tags that may run is the only rule that holds. Parsing through a
// <template> never executes scripts or loads images.
function cleanNode(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue; // text
    if (child.nodeType !== 1) { child.remove(); continue; } // comments, processing instructions
    const element = child as Element;
    const tag = element.localName.toLowerCase();
    if (tagDropped(tag)) { element.remove(); continue; }
    // A form control other than a task-list checkbox has no business in a reply.
    if (!tagAllowed(tag) || (tag === "input" && !inputAllowed(element.getAttribute("type")))) {
      if (tag === "input") { element.remove(); continue; }
      cleanNode(element);
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!attributeAllowed(tag, name, attribute.value)) { element.removeAttribute(attribute.name); continue; }
      // A bad link keeps its anchor and loses its target; a bad image source
      // would leave a broken box, so it goes.
      if (name === "href" && !hrefAllowed(attribute.value)) element.setAttribute(attribute.name, "#");
      else if (name === "src" && !srcAllowed(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (tag === "input") element.setAttribute("disabled", "");
    if (tag === "a" && element.hasAttribute("href")) element.setAttribute("rel", "noopener noreferrer");
    cleanNode(element);
  }
}

function sanitize(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  cleanNode(template.content);
  return template.innerHTML;
}

/** Resolve each prose block independently so mixed-language replies stay readable. */
function textDirections(html: string): string {
  return html.replace(/<(p|h[1-6]|ul|ol|li|blockquote|table|th|td|pre|code)\b([^>]*)>/gi, (_tag, name: string, attrs: string) => {
    if (/\sdir\s*=/i.test(attrs)) return `<${name}${attrs}>`;
    return `<${name} dir="${/^(pre|code)$/i.test(name) ? "ltr" : "auto"}"${attrs}>`;
  });
}

// Parsing, highlighting and filtering is the single most expensive thing the
// webview does per frame. Re-doing all of it for the ENTIRE text on every delta
// is quadratic in message length, so the document is split into its top-level
// blocks (`src/markdown-blocks.ts`) and each block is rendered and cached on its
// own: while streaming, only the trailing block changes and every earlier block
// is a cache hit.
// Bound both entries and string storage: streaming revisions can each contain
// hundreds of kilobytes even when the number of entries is small.
const CACHE_LIMIT = 240;
const CACHE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024;
interface Rendered { html: string; highlighted: number }
const cache = new Map<string, Rendered>();
let cacheBytes = 0;

function cached(key: string, compute: () => Rendered): Rendered {
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency (Map preserves insertion order).
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const entry = compute();
  // Account for UTF-16 source and output. Oversized documents still render, but
  // retaining their intermediate streaming revisions offers little reuse.
  const bytes = (key.length + entry.html.length) * 2;
  if (bytes > MAX_ENTRY_BYTES) return entry;
  cache.set(key, entry);
  cacheBytes += bytes;
  while (cache.size > CACHE_LIMIT || cacheBytes > CACHE_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cacheBytes -= (oldest.length + cache.get(oldest)!.html.length) * 2;
    cache.delete(oldest);
  }
  return entry;
}

/**
 * KaTeX, statically imported.
 *
 * A dynamic `import("katex")` does NOT work here: esbuild leaves a bare-specifier dynamic
 * import as a runtime `import()`, which the webview cannot resolve ("Failed to resolve module
 * specifier 'katex'") because the CSP allows only a nonce'd inline script and there is no
 * module loader. A static import is inlined into the IIFE bundle instead, so it just works --
 * it costs ~280 KB in `sidebar.js`, which is the trade for math actually rendering.
 *
 * `trust: false` is deliberate: `\href` and `\includegraphics` would let model output reach
 * the network or the filesystem, and the whole point of sanitising is that it cannot.
 */
const katexRender: MathRenderer = (tex, displayMode) => {
  const inner = katex.renderToString(tex, {
    displayMode: Boolean(displayMode),
    throwOnError: false,
    errorColor: "var(--vscode-errorForeground, #f14c4c)",
    strict: "ignore",
    trust: false,
    output: "html",
  });
  // A display equation is a block of its own: it scrolls horizontally when its width exceeds
  // the column, which the inline path must not. The classic webview had `.math-block`
  // for this; the React port rendered unwrapped, so a wide formula made the whole message
  // scroll sideways. Wrapping here keeps the chrome with the renderer, so it cannot be
  // forgotten by a new call site.
  return displayMode ? `<div class="math-block">${inner}</div>` : inner;
};

const math = createMathRenderer(katexRender);

/** Kept for callers that want to warm the renderer; a static import needs no preload. */
export function preloadMath(): void {}

/**
 * Pull the math out of one block so marked cannot mangle it.
 *
 * `token.raw` is what `marked.parser` re-reads, so protecting that is sufficient. A block with
 * no math is returned untouched, which keeps the common case allocation-free.
 */
function protectBlockMath(block: { raw: string; token: any }): { token: any; html: string[] } {
  const raw = String(block.token?.raw ?? "");
  if (!raw.includes("$") && !raw.includes("\\(") && !raw.includes("\\[")) {
    return { token: block.token, html: [] };
  }
  // Start the import the first time a formula is actually seen. The first one renders as a
  // code span while the module loads; every later one is typeset, because the import resolves
  // in a few milliseconds and the answer is still streaming.
  preloadMath();
  const budget = { remaining: MATH_BUDGET };
  const split = protectInlineMath(raw, undefined, math, budget);
  if (!split.html.length) return { token: block.token, html: [] };
  // Re-lex the protected text so the token tree matches what will be parsed. The block is
  // small relative to the document, and this only happens for blocks that contain math.
  const tokens = marked.lexer(split.text);
  return { token: tokens[0] ?? block.token, html: split.html };
}

/** Whole-document path, for documents whose blocks cannot be rendered independently. */
function renderWhole(src: string): string {
  return cached("doc\u0000" + src, () => {
    try {
      highlightRemaining = HIGHLIGHT_BUDGET;
      // Math is protected here too: this path is taken for any document with raw HTML, and a
      // formula in one of those would otherwise reach marked unmangled.
      if (src.includes("$") || src.includes("\\(") || src.includes("\\[")) preloadMath();
      const mathBudget = { remaining: MATH_BUDGET };
      const split = protectInlineMath(src, undefined, math, mathBudget);
      // References are linkified before filtering, so the anchors this creates go
      // through the same allowlist as everything else rather than bypassing it.
      let html = textDirections(sanitize(linkifyDevRefs(marked.parse(split.text, { async: false }) as string)));
      if (split.html.length) html = restoreMath(html, split.html);
      return { html, highlighted: HIGHLIGHT_BUDGET - highlightRemaining };
    } catch {
      // Fallback: render as escaped plain text on parser failure.
      return { html: '<p dir="auto">' + src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>", highlighted: 0 };
    }
  }).html;
}

/**
 * A code fence that is still being streamed, rendered as escaped text.
 *
 * It carries the same chrome as the closed path (`codeBlockHtml`) so nothing shifts when
 * the closing delimiter arrives: same wrapper, same language chip, same copy control, same
 * `pre > code`. Only the body differs -- escaped text instead of highlight `<span>`s --
 * and the line count that drives the collapse control is derived the same way.
 *
 * Not cached: the block's raw text changes on every delta, so there is nothing to reuse
 * and caching the revisions would retain a copy of the whole fence per frame.
 */
function openFenceHtml(block: { raw: string; token: any }): string {
  const token = block.token ?? {};
  const lang = String(token.lang ?? "").trim().split(/\s+/, 1)[0];
  const code = String(token.text ?? "").replace(/\n$/, "") + "\n";
  const resolved = getCodeLanguage(code, lang);
  // Escape the body rather than highlighting it, and escape the label with the same
  // helper the closed path uses so a language named from the fence cannot inject markup.
  // `textDirections` runs here too: the closed path sets `dir` on `pre`/`code`, and
  // skipping it would reflow the block the moment the closing delimiter arrives.
  return textDirections(sanitize(codeBlockHtml({
    language: resolved.id,
    label: resolved.label,
    content: escapeCodeHtml(code),
  })));
}

/**
 * Render markdown as filtered HTML fragments, one per top-level block. Joined
 * together they equal the whole-document render.
 */
export function renderMarkdownBlocks(srcIn: string): readonly string[] {
  const src = String(srcIn == null ? "" : srcIn);
  if (!src) return [];
  try {
    const split = splitMarkdownBlocks(marked, src);
    if (split.whole) return [renderWhole(src)];
    const blocks: string[] = [];
    // The highlight budget is shared across blocks in document order, so it is
    // part of the cache key: an identical block later in a long reply may get less.
    let budget = HIGHLIGHT_BUDGET;
    const lastIndex = split.blocks.length - 1;
    for (let i = 0; i < split.blocks.length; i++) {
      const block = split.blocks[i];
      // A fence still being streamed is emitted as escaped text, not highlighted code.
      // Its cache key is its raw text, which changes every delta, so highlighting it
      // would be redone from scratch each frame and then thrown away -- and a
      // highlighted fence is ~1,400x more DOM nodes to sanitize than escaped text.
      // It gets highlighted once, on the delta that closes it. See `isOpenFence` in
      // `src/markdown-blocks.ts` for the measurements.
      if (split.openFence && i === lastIndex) {
        blocks.push(openFenceHtml(block));
        continue;
      }
      const start = budget;
      const entry = cached(`${start}\u0000${block.key}`, () => {
        highlightRemaining = start;
        // Math is pulled out before marked sees the block, because marked reads `_`, `*`
        // and `\` as markup and mangles LaTeX. The token's `raw` is what `parser` will
        // re-read, so protecting that is enough; `restoreMath` puts the rendered HTML back
        // after sanitising, so KaTeX output goes through the same allowlist as everything
        // else rather than around it.
        const protectedBlock = protectBlockMath(block);
        let html = textDirections(sanitize(linkifyDevRefs(marked.parser([protectedBlock.token]))));
        if (protectedBlock.html.length) html = restoreMath(html, protectedBlock.html);
        return { html, highlighted: start - highlightRemaining };
      });
      budget = start - entry.highlighted;
      if (entry.html) blocks.push(entry.html);
    }
    return blocks;
  } catch {
    return [renderWhole(src)];
  }
}

export function renderMarkdown(srcIn: string): string {
  return renderMarkdownBlocks(srcIn).join("");
}

export function basename(p: string): string {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}