/**
 * Pure helpers shared by the webview runtime.
 *
 * `runtime.ts` is a single `String.raw` template of browser JavaScript, so nothing in it
 * can be imported or unit-tested. Anything that must be *proven* correct — especially
 * escaping, which sits between untrusted model output and `innerHTML` — lives here
 * instead and is injected into the template.
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
