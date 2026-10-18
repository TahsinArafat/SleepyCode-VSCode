/**
 * Incremental rendering for the streaming assistant answer.
 *
 * `runtime.ts` is a single `String.raw` template of browser JavaScript, so nothing in it can
 * be imported or unit-tested. Anything that must be *proven* correct lives here instead and is
 * injected into the template as source — the same trick `runtime-core.ts` uses for `esc`.
 *
 * ## Why this exists
 *
 * The stream handler used to do `element.innerHTML = markdown(element.dataset.raw)` on every
 * single token delta. That re-tokenizes the whole answer so far and throws away the DOM, so the
 * cost of rendering an answer is quadratic in its length: a 5,000-token reply meant roughly
 * 5,000 full markdown passes. On a long answer the webview visibly stalls and the composer
 * feels frozen.
 *
 * ## The contract
 *
 * `streamBlockCut` returns the offset just past the last *finished* top-level block, or `from`
 * when the region under the cursor is still incomplete. The renderer settles the prefix once and
 * only ever re-renders the trailing partial block, which makes the total work linear.
 *
 * Splitting on blank lines is safe because `markdown()` is already context-free at those
 * boundaries: a blank line flushes the paragraph, closes the list, and flushes the table, so
 * `markdown(a) + markdown(b)` is byte-identical to `markdown(a + b)` whenever the split lands on
 * one. `test/streaming-render.direct.mjs` asserts that identity across every fixture.
 *
 * ## Known limit (deliberate)
 *
 * A fence that is still open at the tail cannot be settled, because `markdown()` emits one
 * `<pre><code>` for the whole fence and splitting it would change the output. The tail then
 * re-renders on every frame. That path is only an `esc()` pass — no tokenizing — and the frame
 * coalescing below caps it at one repaint per animation frame, so it stays cheap. Making fences
 * settle would require a different DOM strategy (growing a single `<pre>` in place), which is not
 * worth the divergence risk for the gain.
 */

/** A block boundary is only safe at these positions; mirrors `markdown()`'s own state machine. */
const FENCE = '```';

/**
 * Offset just past the last complete top-level markdown block at or after `from`.
 *
 * The scan deliberately reproduces `markdown()`'s *precedence*, not just its tokens: `markdown()`
 * tests for a math delimiter before it tests for a fence, so a `$$` line inside a fence does flip
 * its math state. Reordering here would make settled blocks disagree with a full render.
 *
 * @param raw Full buffer. Must be called with `from` pointing at a boundary the previous call
 *            returned, so fence/math state is known to be closed at that offset.
 * @param from Offset to resume scanning from.
 * @param allowMath Whether `markdown()` is rendering math for this buffer.
 */
export function streamBlockCut(raw: unknown, from: number, allowMath: boolean): number {
  const text = String(raw ?? '');
  const start = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
  if (start >= text.length) return text.length;

  let pos = start;
  let cut = start;
  let inCode = false;
  let inMath = false;

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 || nl + 1 > text.length ? text.length : nl + 1;
    const line = text.slice(pos, nl < 0 ? text.length : nl);

    if (inMath) {
      if (/^\s*(\$\$|\\\])\s*$/.test(line)) {
        inMath = false;
        cut = end;
      }
    } else if (allowMath !== false && /^\s*(\$\$|\\\[)\s*$/.test(line)) {
      inMath = true;
    } else if (line.trim().startsWith(FENCE)) {
      inCode = !inCode;
      if (!inCode) cut = end;
    } else if (!inCode && line.trim() === '') {
      cut = end;
    }

    pos = end;
  }

  return cut;
}

/**
 * Browser-side incremental renderer, as source text for injection into the webview template.
 *
 * `md` is the page's own `markdown(raw, allowMath)` so both paths stay in lockstep.
 *
 * No template-literal interpolation (`${`) may appear in this string: it is spliced into a
 * `String.raw` template in `runtime.ts`, where `${` would be parsed as an interpolation.
 */
export const STREAM_RENDER_SOURCE = String.raw`
function streamBlockCut(raw,from,allowMath){
  const text=String(raw==null?'':raw);
  const start=Number.isFinite(from)&&from>0?Math.floor(from):0;
  if(start>=text.length)return text.length;
  const fence=String.fromCharCode(96).repeat(3);
  let pos=start,cut=start,inCode=false,inMath=false;
  while(pos<text.length){
    const nl=text.indexOf('\n',pos);
    const end=nl<0||nl+1>text.length?text.length:nl+1;
    const line=text.slice(pos,nl<0?text.length:nl);
    if(inMath){
      if(/^\s*(\$\$|\\\])\s*$/.test(line)){inMath=false;cut=end}
    }else if(allowMath!==false&&/^\s*(\$\$|\\\[)\s*$/.test(line)){
      inMath=true;
    }else if(line.trim().indexOf(fence)===0){
      inCode=!inCode;
      if(!inCode)cut=end;
    }else if(!inCode&&!line.trim()){
      cut=end;
    }
    pos=end;
  }
  return cut;
}
function createStreamRenderer(md){
  let settled='',settledHtml='';
  return{
    reset(){settled='';settledHtml=''},
    html(raw,allowMath){
      const text=String(raw==null?'':raw);
      if(text.lastIndexOf(settled,0)!==0){settled='';settledHtml=''}
      const cut=streamBlockCut(text,settled.length,allowMath);
      if(cut>settled.length){settledHtml+=md(text.slice(settled.length,cut),allowMath);settled=text.slice(0,cut)}
      return settledHtml+md(text.slice(settled.length),allowMath);
    }
  };
}
`;

/**
 * One animation frame of coalescing for token deltas.
 *
 * The extension posts a message per streamed chunk, which on a fast provider is many per frame.
 * Without this the webview re-renders — and re-lays-out — once per token. Buffering and flushing
 * on `requestAnimationFrame` caps every DOM write at the display rate.
 */
export const STREAM_FRAME_SOURCE = String.raw`
function createFrameCoalescer(paint){
  let pending=null,handle=0;
  const flush=()=>{
    if(handle){cancelAnimationFrame(handle);handle=0}
    if(pending===null)return;
    const run=pending;pending=null;paint(run);
  };
  return{
    schedule(value){
      pending=value;
      if(!handle&&typeof requestAnimationFrame==='function')handle=requestAnimationFrame(flush);
    },
    flushNow(value){
      if(arguments.length)pending=value;
      flush();
    },
    cancel(){if(handle){cancelAnimationFrame(handle);handle=0}pending=null}
  };
}
`;
