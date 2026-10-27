/*
 * Developer references in prose.
 *
 * The classic transcript made a model's file references clickable: a bare
 * `src/app.ts:42`, `src/app.ts:42:7` or `file:///abs/path.ts` opened at that
 * position. The React markdown renderer leaves them inert.
 *
 * Runs on rendered HTML rather than on plain text, because the reference has to be
 * recognised in prose and NOT in code — a code block is full of things that look
 * like references, and rewriting them would change what the code says. So segments
 * inside `pre`/`code` are left exactly as they are.
 *
 * This produces the anchor and its data attributes only. The host checks that a
 * path is inside a root it owns before opening anything, so the most this can do is
 * hand it an honest path.
 */

/**
 * A reference: an optional `file://` prefix, path segments with separators, a
 * filename with an extension, and an optional `:line[:col]`.
 *
 * One pattern rather than two alternatives. A `file://` URL matched lazily stopped
 * at the last `.`-less segment, so `/proj/src/app.ts:10` became `/proj/src/app`
 * with `.ts:10` leaking into the prose. An extension is required, which is what
 * keeps `12:30` and `16:9` out — they are prose, not files.
 */
const REF_RE = new RegExp(
  String.raw`(file:\/\/\/?)?((?:[\w.@~-]+[\\/])*[\w.@-]+\.[A-Za-z0-9]+)(?::(\d{1,6})(?::(\d{1,6}))?)?(?=[\s<>),.;:!?]|$)`,
  'gi',
);

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
  return escapeAttribute(value);
}

/** The anchor for one matched reference, or the original text when it is not one. */
function reference(match: string, scheme: string | undefined, path: string, line?: string, col?: string): string {
  const target = scheme ? `/${path}` : path;
  const attrs = [
    'class="dev-ref"',
    `data-open-path="${escapeAttribute(target)}"`,
    line ? `data-line="${escapeAttribute(line)}"` : '',
    col ? `data-col="${escapeAttribute(col)}"` : '',
    'role="link"',
    'tabindex="0"',
  ].filter(Boolean).join(' ');
  return `<a ${attrs}>${escapeText(match)}</a>`;
}

/** Rewrite references in one prose segment. */
function inProse(segment: string): string {
  return segment.replace(REF_RE, (match, scheme: string | undefined, path: string, line?: string, col?: string) =>
    reference(match, scheme, path, line, col));
}

/**
 * Linkify references in rendered HTML, leaving code and existing links untouched.
 *
 * Split on `pre`/`code`/`a` elements and transform only what lies between them, so
 * the child content of those elements never passes through the matcher.
 */
export function linkifyDevRefs(html: unknown): string {
  if (typeof html !== 'string' || !html) return typeof html === 'string' ? html : '';
  const parts = html.split(/(<(?:pre|code|a)\b[\s\S]*?<\/(?:pre|code|a)>)/gi);
  return parts.map((part, index) => (index % 2 === 1 ? part : inProse(part))).join('');
}