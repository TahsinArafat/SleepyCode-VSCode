/**
 * Whitespace-tolerant matching for source-pinning assertions.
 *
 * `runtime.ts` is a deliberately minified single-`String.raw` template. Assertions that pin its
 * source text break the moment anything reformats it — a Prettier run over the file turned 16 of
 * them red without changing a single behavior. Those failures are pure noise: they cost a full gate
 * run to re-triage and the fix is invisible in the diff.
 *
 * So: match with whitespace normalized away on both sides. These assertions exist to pin *behavior*
 * ("an approval gate exists on this path"), never formatting, and this keeps that promise while
 * surviving reformatting.
 *
 * The two sides are normalized *asymmetrically*, and that asymmetry is the whole trick:
 *
 *   Haystack = real source text. A `\s` in it is two literal characters (a backslash and an s) —
 *   notably when the source itself embeds a regex literal, as `skillPickerQuery` does with
 *   `/\/^\/skill(?:\s+(?:"([^"]*)|([^\s]*)))?$/i`. Rewriting those would corrupt the very behavior
 *   under test. So the haystack only ever loses real whitespace characters.
 *
 *   Pattern = an actual RegExp. Here `\s` genuinely *is* a matcher, so it must be reduced to
 *   something that can match the empty string, since the haystack no longer has whitespace to
 *   match. Its quantifier must be consumed too, or "one or more" silently becomes "zero or more,
 *   then a literal +": `\s+` `\s*` `\s?`, the escaped forms `\s\+` `\s\*` `\s\?`, and `\s{2,}`.
 *
 * Character classes are left intact in both. `[\s\S]` is an "any character" matcher, not a
 * whitespace matcher, and rewriting the `\s` inside it would change what it accepts.
 */
import assert from 'node:assert/strict';

/** Reduce one whitespace matcher, quantifier included, to something that matches the empty string. */
function consumeWhitespaceMatcher(source, index) {
  // index points at the backslash of `\s`.
  let end = index + 2;
  const next = source[end];
  if (next === '\\' && '+*?'.includes(source[end + 1] ?? '')) {
    end += 2; // escaped quantifier: `\s\+`
  } else if (next === '{') {
    const close = source.indexOf('}', end);
    end = close === -1 ? end + 1 : close + 1;
  } else if (next === '+' || next === '*' || next === '?') {
    end += 1;
  }
  return { text: '\\s*', next: end };
}

/** Haystack normalization: delete real whitespace only, leaving every backslash untouched. */
export function stripSourceWhitespace(source) {
  return source.replace(/\s+/g, '');
}

/** Pattern normalization: delete real whitespace, and defang whitespace matchers. */
export function stripPatternWhitespace(pattern) {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === '[') {
      inClass = true;
      out += char;
      continue;
    }
    if (char === ']') {
      inClass = false;
      out += char;
      continue;
    }

    if (char === '\\') {
      if (!inClass && pattern[i + 1] === 's') {
        const { text, next } = consumeWhitespaceMatcher(pattern, i);
        out += text;
        i = next - 1;
        continue;
      }
      // Any other escape — and every escape inside a class — is literal. Copy it verbatim.
      out += char + (pattern[i + 1] ?? '');
      i += 1;
      continue;
    }

    if (!inClass && /\s/.test(char)) continue;
    out += char;
  }
  return out;
}

/** Treat a plain string as a literal pattern so callers can pin source text without regex escaping. */
function toPattern(pattern) {
  if (typeof pattern !== 'string') return pattern;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped);
}

/** True when `pattern` matches `source` ignoring whitespace differences. */
export function matchesSource(source, pattern) {
  const target = toPattern(pattern);
  const normalized = new RegExp(
    stripPatternWhitespace(target.source),
    target.flags.replace('g', ''),
  );
  return normalized.test(stripSourceWhitespace(source));
}

/** `assert.match` with whitespace normalized away, for pinning source text. Accepts a string or RegExp. */
export function assertSource(source, pattern, message) {
  assert.ok(
    matchesSource(source, pattern),
    message ?? `expected source to match ${pattern}`,
  );
}