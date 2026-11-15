/**
 * HTML escaping for untrusted text, as a pure testable module.
 *
 * Everything that reaches `innerHTML` comes from somewhere untrusted: model output, file
 * names, conversation titles, and file paths derived from them. Missing one of the five
 * metacharacters is an injection point, so they are escaped together and covered by tests
 * rather than trusted to review.
 *
 * This module was `src/webview/runtime-core.ts`, extracted from the vanilla webview's
 * `String.raw` template so it could be tested at all. That webview is being removed, but this
 * file is not going with it: escaping is exactly the code that must survive a UI rewrite,
 * because a rewrite is when hand-rolled copies multiply. The `*_SOURCE` exports remain for
 * the one remaining template consumer, and `test/webview-escape.direct.mjs` pins this module
 * as the single implementation.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 *
 * Model output, file names, and conversation titles all reach `innerHTML`. Missing any
 * one of these five characters is an injection point, so they are escaped together and
 * covered by tests rather than trusted to review.
 */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => HTML_ESCAPES[char] ?? char);
}

/** Escape a value for use inside a single- or double-quoted HTML attribute. */
export function escapeAttribute(value: unknown): string {
  return escapeHtml(value);
}

/**
 * The escaping table as source text, for injection into the webview template.
 *
 * `escapeHtml` and the in-page `esc` must stay identical. Rather than hand-copy the
 * replacement map twice, this exports the map as a literal that both use, and a test
 * asserts the template's `esc` is built from it.
 */
export const HTML_ESCAPES_SOURCE = String.raw`{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}`;

/** The in-page sanitizer, built from the same table the tests exercise. */
export const ESCAPE_HTML_SOURCE = String.raw`const esc=s=>String(s).replace(/[&<>"']/g,c=>(${HTML_ESCAPES_SOURCE}[c]));const escAttr=esc;`;
