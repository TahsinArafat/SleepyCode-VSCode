/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { Marked } from "marked";
import { escapeCodeHtml, getCodeLanguage, highlightCode } from "./codeLanguages";
import { codeBlockHtml } from "../../src/code-block-html.ts";
import { linkifyDevRefs } from "../../src/dev-refs.ts";
import { splitMarkdownBlocks } from "../../src/markdown-blocks.ts";
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

/** Whole-document path, for documents whose blocks cannot be rendered independently. */
function renderWhole(src: string): string {
  return cached("doc\u0000" + src, () => {
    try {
      highlightRemaining = HIGHLIGHT_BUDGET;
      // References are linkified before filtering, so the anchors this creates go
      // through the same allowlist as everything else rather than bypassing it.
      const html = textDirections(sanitize(linkifyDevRefs(marked.parse(src, { async: false }) as string)));
      return { html, highlighted: HIGHLIGHT_BUDGET - highlightRemaining };
    } catch {
      // Fallback: render as escaped plain text on parser failure.
      return { html: '<p dir="auto">' + src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>", highlighted: 0 };
    }
  }).html;
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
    for (const block of split.blocks) {
      const start = budget;
      const entry = cached(`${start}\u0000${block.key}`, () => {
        highlightRemaining = start;
        const html = textDirections(sanitize(linkifyDevRefs(marked.parser([block.token]))));
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