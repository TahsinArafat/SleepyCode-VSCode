/**
 * Dependency-free syntax highlighting for code blocks in the chat transcript.
 *
 * ## Why this exists
 *
 * Code blocks are the highest-traffic surface in a coding agent's transcript, and they render as
 * one undifferentiated wall of monospace text: no keywords, no strings, no comments, no language
 * label, no copy button. For the developer audience this is the single most visible legibility gap
 * in the window.
 *
 * The obvious fix — Shiki or highlight.js — is rejected on purpose. Either one ships a highlighter
 * grammar (Shiki ships megabytes of TextMate grammars + WASM) into a webview whose entire job is
 * to stay under the frame budget while tokens stream in, and both re-tokenize on every call. What
 * this transcript actually needs is a small, bounded, single-pass scanner over the language families
 * agents emit most: JS/TS, Python, JSON, shell, diff, and a handful of others, with everything else
 * falling back to plain escaped text exactly as today.
 *
 * ## Contract
 *
 * 1. **Safety by construction.** Every character the scanner emits passes through `esc()` — the
 *    injected, independently-tested sanitizer. Token *classes* are chosen by the scanner, never by
 *    the input, so no code sample can smuggle markup into the transcript, no matter what language
 *    it claims. `test/highlight.direct.mjs` throws adversarial payloads at it.
 * 2. **Zero divergence risk.** An unknown language returns `esc(text)` — byte-identical to the
 *    current renderer. Highlighting is opt-in per language family, and `markdown` is excluded
 *    entirely (its "code" is prose, where markup would add noise).
 * 3. **Linear and streaming-safe.** One pass, no backtracking across the document, and the scanner
 *    is invoked on the trailing partial fence every streaming frame — so it must be cheap on a
 *    half-finished block, including one whose closing fence has not arrived yet.
 * 4. **Theme-native.** Emitted classes (`tok-key`, `tok-str`, ...) are styled from VS Code's own
 *    `--vscode-editor-token-*-foreground` variables in `styles.ts`, so light/dark/high-contrast
 *    themes are correct with no extra work.
 *
 * ## One implementation, two consumers
 *
 * The logic lives *only* in `HIGHLIGHT_SOURCE` below — the browser-side source spliced into the
 * webview template next to `STREAM_RENDER_SOURCE`. The direct test evaluates that same string
 * (the `new Function` extraction `test/streaming-render.direct.mjs` already uses for
 * `createFrameCoalescer`), so the tested code is the shipped code and the keyword tables cannot
 * drift between a Node mirror and a browser copy.
 */

/** Language aliases are normalized to one id; the table also drives CSS `data-lang` labels. */
const LANG_ALIASES: Record<string, string> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', javascript: 'js', node: 'js',
  ts: 'js', tsx: 'js', typescript: 'js', javascriptreact: 'js', typescriptreact: 'js',
  py: 'python', python: 'python',
  json: 'json', jsonc: 'json',
  sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', console: 'shell', terminal: 'shell',
  diff: 'diff', patch: 'diff',
  rs: 'rust', rust: 'rust',
  go: 'go', golang: 'go',
  css: 'css', scss: 'css',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
};

/** Public label for a fence language, or '' when the block should render unhighlighted. */
export function highlightLanguageId(lang: unknown): string {
  const id = String(lang ?? '').trim().toLowerCase();
  if (!id) return '';
  return LANG_ALIASES[id] ?? '';
}

/**
 * Browser-side source, spliced into the webview template by `runtime.ts`.
 *
 * No `${` may appear anywhere in this string: it is interpolated into a String.raw template.
 * Same for backticks — the scanner builds fence markers from `String.fromCharCode(96)` instead,
 * the trick `stream-render.ts` already uses.
 */
export const HIGHLIGHT_SOURCE = String.raw`
function highlightLanguageId(lang){
  const id=String(lang==null?'':lang).trim().toLowerCase();
  if(!id)return '';
  if(id==='ts'||id==='tsx'||id==='typescript'||id==='typescriptreact'||id==='js'||id==='jsx'||id==='javascript'||id==='javascriptreact'||id==='mjs'||id==='cjs'||id==='node')return 'js';
  if(id==='py'||id==='python')return 'python';
  if(id==='json'||id==='jsonc')return 'json';
  if(id==='sh'||id==='bash'||id==='shell'||id==='zsh'||id==='console'||id==='terminal')return 'shell';
  if(id==='diff'||id==='patch')return 'diff';
  if(id==='rs'||id==='rust')return 'rust';
  if(id==='go'||id==='golang')return 'go';
  if(id==='css'||id==='scss')return 'css';
  if(id==='html'||id==='xml'||id==='svg'||id==='vue')return 'html';
  if(id==='sql')return 'sql';
  if(id==='yaml'||id==='yml')return 'yaml';
  if(id==='toml')return 'toml';
  return '';
}
const tick=String.fromCharCode(96);
function highlightSpec(id){
  if(id==='js')return{line:['//'],block:[['/*','*/']],str:['"',"'",tick],triple:[tick],stopAtNewline:true,varPrefix:true,keywords:'abstract arguments async await break case catch class const constructor continue debugger declare default defer delete do else enum export extends false finally for from function get if implements import in instanceof interface is keyof let new null of package private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield'};
  if(id==='python')return{line:['#'],block:[],str:['"',"'"],triple:['"""',"'''"],stopAtNewline:true,varPrefix:true,keywords:'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self'};
  if(id==='json')return{line:[],block:[],str:['"'],triple:[],jsonKey:true,keywords:'true false null'};
  if(id==='shell')return{line:['#'],block:[],str:['"',"'"],triple:[],stopAtNewline:true,varPrefix:true,keywords:'if then else elif fi for while until do done case esac function in select timecoproc exit return export local source set shift trap read echo printf unset break continue eval exec test alias cd'};
  if(id==='rust')return{line:['//'],block:[['/*','*/']],str:['"',"'" ],triple:[],stopAtNewline:true,varPrefix:true,keywords:'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'};
  if(id==='go')return{line:['//'],block:[['/*','*/']],str:['"',"'",tick],triple:[tick],stopAtNewline:true,varPrefix:false,keywords:'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota'};
  if(id==='css')return{line:['/*','//'],block:[['/*','*/']],str:['"',"'"],triple:[],stopAtNewline:true,varPrefix:true,keywords:'important inherit initial unset none auto'};
  if(id==='html')return{html:true,line:[],block:[['<!--','-->']],str:['"',"'"],triple:[],stopAtNewline:true,keywords:''};
  if(id==='sql')return{line:['--'],block:[['/*','*/']],str:["'"],triple:[],stopAtNewline:true,varPrefix:false,keywords:'select from where insert into values update set delete create table alter drop index join left right inner outer on as and or not null is in between order by group having limit offset union all distinct primary key foreign references default unique constraint check having asc desc'};
  if(id==='yaml')return{line:['#'],block:[],str:['"',"'"],triple:[],stopAtNewline:true,varPrefix:false,keywords:'true false null yes no on off'};
  if(id==='toml')return{line:['#'],block:[],str:['"',"'"],triple:['"""',"'''"],stopAtNewline:true,varPrefix:false,keywords:'true false'};
  return null;
}
function highlightDiff(text){
  const lines=text.split('\n');
  let out='';
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    let cls='';
    if(line.indexOf('@@')===0)cls='tok-meta';
    else if(line.indexOf('+++')===0||line.indexOf('---')===0||line.indexOf('diff ')===0||line.indexOf('index ')===0)cls='tok-com';
    else if(line.charAt(0)==='+')cls='tok-add';
    else if(line.charAt(0)==='-')cls='tok-del';
    out+=cls?'<span class="'+cls+'">'+esc(line)+'</span>':esc(line);
    if(i<lines.length-1)out+='\n';
  }
  return out;
}
function highlightHtml(text,spec){
  let out='',i=0;
  const n=text.length;
  while(i<n){
    if(text.substr(i,4)==='<!--'){
      const at=text.indexOf('-->',i+4);
      const end=at<0?n:at+3;
      out+='<span class="tok-com">'+esc(text.slice(i,end))+'</span>';
      i=end;
      continue;
    }
    if(text.charAt(i)==='<'&&/[A-Za-z!/]/.test(text.charAt(i+1))){
      const at=text.indexOf('>',i+1);
      const end=at<0?n:at+1;
      out+='<span class="tok-key">'+esc(text.slice(i,end))+'</span>';
      i=end;
      continue;
    }
    let j=i+1;
    while(j<n&&text.charAt(j)!=='<'&&text.charAt(j)!=='&')j++;
    out+=esc(text.slice(i,j));
    i=j;
  }
  return out;
}
function highlightTokens(text,spec){
  const kw=spec.keywords?new Set(spec.keywords.split(' ')):null;
  const wordStart=/[A-Za-z_$]/;
  const wordChar=/[A-Za-z0-9_$]/;
  const digit=/[0-9]/;
  const numberChar=/[0-9A-Za-z_.]/;
  const boring=new RegExp("["+tick+String.fromCharCode(39)+String.fromCharCode(34)+String.fromCharCode(47)+"/0-9A-Za-z_$@<>]");
  const escapes='\\';
  let out='',i=0;
  const n=text.length;
  outer: while(i<n){
    const ch=text.charAt(i);
    for(let l=0;l<spec.line.length;l++){
      const marker=spec.line[l];
      if(marker&&text.substr(i,marker.length)===marker){
        const nl=text.indexOf('\n',i);
        const end=nl<0?n:nl;
        out+='<span class="tok-com">'+esc(text.slice(i,end))+'</span>';
        i=end;
        continue outer;
      }
    }
    for(let b=0;b<spec.block.length;b++){
      const open=spec.block[b][0];
      if(text.substr(i,open.length)===open){
        const close=spec.block[b][1];
        const at=text.indexOf(close,i+open.length);
        const end=at<0?n:at+close.length;
        out+='<span class="tok-com">'+esc(text.slice(i,end))+'</span>';
        i=end;
        continue outer;
      }
    }
    const quotes=spec.str||[];
    for(let q=0;q<quotes.length;q++){
      const mark=quotes[q];
      if(text.substr(i,mark.length)===mark){
        const triple=spec.triple&&spec.triple.indexOf(mark)>=0;
        let j=i+mark.length;
        let closed=false;
        while(j<n){
          const c=text.charAt(j);
          if(c===escapes){j+=2;continue}
          if(c===mark){j++;closed=true;break}
          if(c==='\n'&&!triple)break;
          j++;
        }
        if(!closed&&j>n)j=n;
        let cls='tok-str';
        if(spec.jsonKey){
          let k=closed?j:j;
          while(k<n&&(text.charAt(k)===' '||text.charAt(k)==='\t'))k++;
          if(text.charAt(k)===':')cls='tok-key';
        }
        out+='<span class="'+cls+'">'+esc(text.slice(i,j))+'</span>';
        i=j;
        continue outer;
      }
    }
    if(spec.at&&ch==='@'&&/[A-Za-z-]/.test(text.charAt(i+1))){
      let j=i+2;
      while(j<n&&/[A-Za-z-]/.test(text.charAt(j)))j++;
      out+='<span class="tok-key">'+esc(text.slice(i,j))+'</span>';
      i=j;
      continue outer;
    }
    if(spec.varPrefix&&ch==='$'){
      let j=i+1;
      if(text.charAt(j)==='{')j++;
      while(j<n&&/[A-Za-z0-9_}]/.test(text.charAt(j)))j++;
      out+='<span class="tok-key">'+esc(text.slice(i,j))+'</span>';
      i=j;
      continue outer;
    }
    if(digit.test(ch)){
      let j=i+1;
      while(j<n&&numberChar.test(text.charAt(j)))j++;
      out+='<span class="tok-num">'+esc(text.slice(i,j))+'</span>';
      i=j;
      continue outer;
    }
    if(wordStart.test(ch)){
      let j=i+1;
      while(j<n&&wordChar.test(text.charAt(j)))j++;
      const word=text.slice(i,j);
      out+=kw&&kw.has(word)?'<span class="tok-keyword">'+word+'</span>':esc(word);
      i=j;
      continue outer;
    }
    let j=i+1;
    while(j<n&&!boring.test(text.charAt(j)))j++;
    out+=esc(text.slice(i,j));
    i=j;
  }
  return out;
}
function highlight(code,lang){
  const text=String(code==null?'':code);
  const id=highlightLanguageId(lang);
  if(!id)return esc(text);
  if(id==='diff')return highlightDiff(text);
  const spec=highlightSpec(id);
  if(!spec)return esc(text);
  if(spec.html)return highlightHtml(text,spec);
  return highlightTokens(text,spec);
}
`;
