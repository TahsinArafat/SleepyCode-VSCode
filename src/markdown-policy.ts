/*
 * What sanitized model output is allowed to contain.
 *
 * `marked` passes raw HTML through, so the transcript's HTML is written by the
 * model as much as by us. A denylist ("remove script, iframe, on*) leaves any
 * element the denylist did not think of, so the rule here is an allowlist:
 * markdown's own elements, plus the two sets of controls THIS transcript emits
 * as raw HTML — the fenced-code chrome and developer-reference anchors.
 *
 * Every table lives here, away from the DOM, because the interesting failures
 * are policy failures: a tag we forgot to allow silently deletes a Copy button,
 * and a scheme we forgot to check silently keeps `javascript:`. The walker in
 * `webview-ui/shared/markdown.ts` applies these answers; it does not decide.
 */

/** Kept, with only the attributes {@link attributeAllowed} permits. */
const ALLOWED = new Set([
  'p', 'a', 'code', 'pre', 'em', 'strong', 'del', 's', 'b', 'i', 'u', 'mark', 'small', 'sub', 'sup', 'kbd',
  'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br', 'img', 'span', 'div',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'details', 'summary',
  'input',
  // Code-block chrome (`src/code-block-html.ts`): the language chip is a span,
  // the controls are buttons, because raw HTML cannot carry a React handler.
  'button',
  // Inline icons inside mention pills.
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'ellipse',
]);

/** Removed together with their contents. Anything else unknown is unwrapped. */
const DROPPED = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'form',
  'textarea', 'select', 'option', 'optgroup', 'noscript', 'template', 'math', 'video', 'audio', 'source',
  'track', 'canvas', 'dialog', 'portal', 'foreignobject', 'title', 'head', 'xmp', 'plaintext', 'noembed',
  'noframes',
]);

const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'ellipse']);

/** Attributes that carry no script on any element. */
const COMMON = new Set(['title', 'class', 'dir', 'align', 'role', 'tabindex', 'aria-label', 'aria-expanded', 'aria-hidden']);

const TAG_ATTRS: Record<string, Set<string>> = {
  // `data-open-path`/`data-line`/`data-col` are a contract with the transcript's
  // delegated click handler (`src/dev-refs.ts`).
  a: new Set(['href', 'data-open-path', 'data-line', 'data-col']),
  // `data-lang` marks the fence's language on the block wrapper.
  div: new Set(['data-lang']),
  // `data-copy-code`/`data-expand-code` are the same kind of contract.
  button: new Set(['type', 'disabled', 'data-copy-code', 'data-expand-code']),
  img: new Set(['src', 'alt', 'width', 'height']),
  ol: new Set(['start']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
  col: new Set(['span']),
  input: new Set(['type', 'checked', 'disabled']),
  details: new Set(['open']),
  span: new Set(['data-kind', 'data-path']),
  code: new Set(['data-language']),
};

const SVG_ATTRS = new Set([
  'xmlns', 'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'fill-rule', 'clip-rule', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points',
  'transform', 'aria-hidden', 'focusable', 'opacity',
]);

export function tagAllowed(tag: string): boolean {
  return ALLOWED.has(String(tag).toLowerCase());
}

/** True when the element must vanish rather than be replaced by its children. */
export function tagDropped(tag: string): boolean {
  return DROPPED.has(String(tag).toLowerCase());
}

export function isSvgTag(tag: string): boolean {
  return SVG_TAGS.has(String(tag).toLowerCase());
}

/**
 * URL scheme after browser-style normalization: leading/trailing control and
 * space characters are stripped before the scheme is read, which is how
 * `java\tscript:`, `\u0000javascript:` and ` javascript:` stay dangerous if a
 * check looks at the raw string.
 */
export function schemeOf(value: string | null | undefined): string | undefined {
  const compact = String(value ?? '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '');
  return /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase();
}

/** A link may be http(s), mailto, or relative — never a protocol-relative URL. */
export function hrefAllowed(value: string | null | undefined): boolean {
  const found = schemeOf(value);
  return found === undefined ? !/^[\\/]{2}/.test(String(value ?? '').trim()) : found === 'http' || found === 'https' || found === 'mailto';
}

/** An image may be https, or inline raster bytes — never svg (it scripts). */
export function srcAllowed(value: string | null | undefined): boolean {
  const found = schemeOf(value);
  return found === 'https' || (found === 'data' && /^\s*data:image\/(?:png|gif|jpe?g|webp|avif|bmp);/i.test(String(value ?? '')));
}

/** A task-list checkbox is display only; any other form control is discarded. */
export function inputAllowed(type: string | null | undefined): boolean {
  return String(type ?? '').toLowerCase() === 'checkbox';
}

/**
 * Whether one attribute survives. `href` and `src` are answered by
 * {@link hrefAllowed}/{@link srcAllowed} in the walker, which rewrites a bad
 * `href` to `#` rather than dropping it (the link stays, the target does not).
 */
export function attributeAllowed(tag: string, name: string, value: string | null | undefined): boolean {
  const element = String(tag).toLowerCase();
  const attribute = String(name).toLowerCase();
  if (/^on/i.test(attribute) || attribute === 'style' || attribute === 'srcset' || attribute === 'formaction') return false;
  if (isSvgTag(element)) {
    if (!(SVG_ATTRS.has(attribute) || COMMON.has(attribute))) return false;
    // A presentation attribute can still reach the network or script.
    return !/url\s*\(|javascript:/i.test(String(value ?? ''));
  }
  if (COMMON.has(attribute)) return true;
  const allowed = TAG_ATTRS[element];
  if (!allowed || !allowed.has(attribute)) return false;
  if (element === 'input' && attribute === 'type') return inputAllowed(value);
  return true;
}