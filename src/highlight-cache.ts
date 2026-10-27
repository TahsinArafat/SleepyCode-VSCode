/*
 * Remembering the composer's code-block colours.
 *
 * The decoration pass walks the whole draft, so typing inside one fenced block
 * re-tokenises and re-parses every other block in it. The results only depend on
 * the block's text and language, which is what makes them reusable — and a cheap
 * key is how that reuse goes wrong: two fields joined by a separator collide the
 * moment the text contains that separator, and the reader sees one block's
 * colours on another block's code.
 *
 * DOM-free so the key and the eviction order can be asserted directly; the
 * caller owns the map and the parsing.
 */

/** Identity of one highlight pass. Unambiguous by construction, not by luck. */
export function highlightCacheKey(text: string, language: string): string {
  // JSON encodes the pair as an array, so no value can be mistaken for a
  // separator or for a neighbouring field.
  return JSON.stringify([language, text]);
}

/**
 * Return the cached value for `key`, computing and remembering it on a miss and
 * dropping the oldest entry once `limit` is exceeded. The value must never be
 * `undefined`: that is the miss signal.
 */
export function rememberTokens<T>(cache: Map<string, T>, key: string, compute: () => T, limit: number): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}