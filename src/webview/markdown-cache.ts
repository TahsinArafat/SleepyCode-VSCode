/**
 * Memoization for the webview's markdown renderer, as source text for injection into the
 * `String.raw` template in `runtime.ts` (the same trick `runtime-core.ts` and `stream-render.ts`
 * use, so the behavior can be exercised directly instead of only grepped for).
 *
 * ## Why this exists
 *
 * Every transcript sync republishes the whole conversation, and the renderer rebuilds the whole
 * transcript from it. `markdown()` was therefore re-tokenizing every unchanged message on every
 * sync — on a long conversation that is hundreds of regex passes plus a KaTeX pass per formula,
 * per sync, for text that did not change. Caching the html by input makes a rebuild cost one
 * parse per *changed* message instead.
 *
 * The cache is bounded three ways so a long streaming answer cannot grow it without limit:
 * by entry count, by total characters held, and by refusing inputs above `maxInput`.
 *
 * Streaming does not use this: every slice the stream renderer asks for is fresh text, so it
 * would never hit and would evict the transcript entries the cache exists to keep.
 *
 * No template-literal interpolation or backticks may appear below: this string is spliced into a
 * `String.raw` template.
 */
export const MARKDOWN_CACHE_SOURCE = String.raw`
function createMarkdownCache(render,maxEntries,maxChars,maxInput){
  const cache=new Map();
  let chars=0;
  return function markdown(raw,allowMath){
    const text=String(raw==null?'':raw);
    // The renderer enables math for anything except an explicit false (allowMath !== false),
    // so the key must make the same distinction: 'undefined' and 'false' are different renders.
    const key=(allowMath===false?'T':'M')+text;
    const hit=cache.get(key);
    if(hit!==undefined){cache.delete(key);cache.set(key,hit);return hit}
    const html=render(text,allowMath);
    if(text.length<=maxInput){
      cache.set(key,html);
      chars+=key.length+html.length;
      while(cache.size>maxEntries||chars>maxChars){
        const oldest=cache.keys().next().value;
        const value=cache.get(oldest);
        cache.delete(oldest);
        chars-=oldest.length+(value?value.length:0);
      }
    }
    return html;
  };
}
`;
