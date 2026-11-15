/**
 * Latency probe for the chat webview.
 *
 * "It feels laggy" is not actionable; this turns it into numbers. It renders the shipping
 * webview (see `scripts/webview-harness.mjs`) in real Chromium and measures the four things a
 * user actually feels: opening a long conversation, typing in the composer, scrolling history,
 * and watching a reply stream in.
 *
 * The harness loads `dist/webview/sidebar.{js,css}` -- the React bundle the extension ships --
 * so this measures the live UI, not a mock of it. Run `npm run build` first.
 *
 * Usage:
 *   node scripts/perf-probe.mjs                # 3 runs x 120 turns, human-readable
 *   node scripts/perf-probe.mjs --json         # machine-readable, for before/after diffs
 *   node scripts/perf-probe.mjs --runs=1 --turns=300
 *
 * Requires `playwright`: npm i -D playwright && npx playwright install chromium
 */
import { openSidebar } from './webview-harness.mjs';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const RUNS = Number(arg('runs') || 3);
const TURNS = Number(arg('turns') || 120);
const DELTAS = Number(arg('deltas') || 200);
const JSON_OUT = process.argv.includes('--json');

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const round = n => Math.round(n * 10) / 10;
  return { p50: round(pct(sorted, 0.5)), p95: round(pct(sorted, 0.95)), max: round(sorted[sorted.length - 1]) };
};

const METRIC_KEYS = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize'];
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
  .filter(m => METRIC_KEYS.includes(m.name)).map(m => [m.name, m.value]));
const metricsDelta = (before, after) => Object.fromEntries(METRIC_KEYS.map(key => {
  const delta = (after[key] ?? 0) - (before[key] ?? 0);
  return [key, key === 'JSHeapUsedSize' ? Math.round(delta / 1024) : Math.round(delta * 1000) / 1000];
}));

/** Run one scenario under CDP perf counters and return wall-clock + browser-side cost. */
async function scenario(page, cdp, run) {
  const before = await metrics(cdp);
  const result = await run();
  const after = await metrics(cdp);
  return { ...result, cost: metricsDelta(before, after) };
}

/**
 * A transcript of `n` user+assistant turns, in the shape the host posts.
 *
 * Built here rather than in the harness because the harness only needs a two-turn
 * conversation for smoke tests, while this needs a long one and needs the text
 * length to be controllable.
 */
function transcript(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', text: `Question ${i}: why does the auth refresh loop fire twice on startup?` });
    out.push({
      role: 'assistant',
      blocks: [{ kind: 'text', text: `Answer ${i}: the refresh is scheduled once per workspace event, and **two** handlers are registered.\n\n- the watcher\n- the interval\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n` }],
    });
  }
  return out;
}

async function measureOnce() {
  const app = await openSidebar({ width: 460, height: 900 });
  const { page } = app;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  await app.boot({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Perf probe' }] });

  // Boot: how much DOM the empty shell costs before any conversation loads.
  const boot = await page.evaluate(() => ({
    bootMs: Math.round(performance.now()),
    nodes: document.getElementsByTagName('*').length,
  }));

  const items = transcript(TURNS);

  // Opening a conversation: the whole transcript is mounted in one commit.
  //
  // React commits asynchronously, so posting and reading `performance.now()` in the
  // same tick measures nothing (it returned ~0 ms and the boot node count). Resolve
  // on the first frame *after* the expected turns are in the DOM, which is the cost
  // the user actually waits for: dispatch -> reconcile -> layout.
  const render = await scenario(page, cdp, () => page.evaluate(expected => new Promise(resolve => {
    const at = performance.now();
    window.postMessage({ type: 'loadConversation', activeId: 'c1', turns: expected.items, usedTokens: 0, running: false, workspaceRoot: '/tmp/workspace' }, '*');
    const check = () => {
      if (document.querySelectorAll('.chat-turn-group').length >= expected.turns) {
        void document.body.offsetHeight; // flush style + layout so the number includes paint prep
        resolve({ totalMs: performance.now() - at, nodes: document.getElementsByTagName('*').length });
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
    setTimeout(() => resolve({ totalMs: performance.now() - at, nodes: document.getElementsByTagName('*').length }), 30_000);
  }), { items, turns: TURNS }));
  // Let any trailing commits land before measuring typing/scroll.
  await page.waitForTimeout(300);

  // Typing: one keystroke per iteration into the real ProseMirror editor. The composer
  // posts a draft to the host on input, so this covers editor + debounce + postMessage.
  const typing = await scenario(page, cdp, () => page.evaluate(() => {
    const editor = document.querySelector('.editor');
    if (!editor) return { samples: [], nodes: 0 };
    editor.focus();
    const times = [];
    for (let i = 0; i < 40; i++) {
      const at = performance.now();
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'a' }));
      times.push(performance.now() - at);
    }
    return { samples: times, nodes: document.getElementsByTagName('*').length };
  }));

  // Scrolling back through history, one viewport-ish step per frame.
  const scroll = await scenario(page, cdp, () => page.evaluate(() => new Promise(resolve => {
    const pane = document.querySelector('.chat-messages');
    if (!pane) return resolve({ frames: [] });
    pane.scrollTop = pane.scrollHeight;
    const frames = [];
    let last = performance.now();
    let steps = 0;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve({ frames }); } };
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      pane.scrollTop -= 400;
      if (++steps < 60) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
    setTimeout(done, 4000); // rAF can stall in headless; never hang the probe
  })));

  // Streaming, prose: 200 text deltas through the real `agentEvent` path.
  //
  // The cost that matters is not the frame rate but the *growth*: markdown is re-parsed
  // over the whole accumulated message, so delta N costs O(message length so far). That
  // makes a long reply quadratic in total. Recording each delta's own apply cost and
  // splitting it into halves is what exposes that -- a flat early/late ratio means linear.
  const streamOnce = (deltaText) => () => page.evaluate(({ deltaText, deltas }) => new Promise(resolve => {
    const frames = [];
    const longTasks = [];
    const perDelta = [];
    const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push(e.duration) });
    observer.observe({ entryTypes: ['longtask'] });
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    let sent = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      running = false;
      observer.disconnect();
      // The measured window is the frame after each post: that is when React commits the
      // delta and the markdown for the grown message is re-rendered.
      resolve({ frames, longTasks, perDelta });
    };
    const timer = setInterval(() => {
      const at = performance.now();
      window.postMessage({ type: 'agentEvent', convId: 'c1', event: { type: 'text-delta', text: deltaText } }, '*');
      // Wait for the commit that this delta triggers, then the paint after it. Reading
      // on the *next* rAF (as this first did) lands inside the interval's own 8 ms
      // budget and reports the timer's cadence instead of the delta's cost.
      requestAnimationFrame(() => requestAnimationFrame(() => perDelta.push(performance.now() - at)));
      if (++sent >= deltas) finish();
    }, 8);
    setTimeout(finish, 30_000);
  }), { deltaText, deltas: DELTAS });

  const stream = await scenario(page, cdp, streamOnce('the refresh loop fires twice because two handlers are registered and neither marks the token fresh. '));

  // Streaming, code: the shape that dominated before the open-fence fix. A highlighted
  // fence is ~9,853 DOM elements at 64k versus 7 escaped, and sanitize pays per element,
  // so this scenario is where a regression would show first. Kept separate from the prose
  // run because the two have different failure modes and one would mask the other.
  const streamCode = await scenario(page, cdp, streamOnce('const value = computeRefreshToken(); // one more line of code\n'));


  await app.close();
  return { boot, render, typing, scroll, stream, streamCode };
}

const runs = [];
for (let i = 0; i < RUNS; i++) {
  runs.push(await measureOnce());
  if (!JSON_OUT) process.stderr.write(`run ${i + 1}/${RUNS}\n`);
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const pick = fn => median(runs.map(fn));
const mean = fn => {
  const values = runs.flatMap(fn).filter(Number.isFinite);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
};

/**
 * Summarise one streaming scenario. `growthRatio` compares the cost of the first 25
 * deltas against the last 25: ~1.0 means the per-delta cost is flat, and a value well
 * above 1 means it grows with the message (the quadratic shape this guards against).
 */
const streamSummary = key => {
  const src = r => r[key];
  const early = mean(r => src(r).perDelta.slice(0, 25));
  const late = mean(r => src(r).perDelta.slice(-25));
  return {
    ...summarize(runs.flatMap(r => src(r).frames)),
    longTasks: pick(r => src(r).longTasks.length),
    longTaskMs: Math.round(pick(r => src(r).longTasks.reduce((a, b) => a + b, 0)) * 10) / 10,
    layoutMs: pick(r => src(r).cost.LayoutDuration * 1000),
    styleMs: pick(r => src(r).cost.RecalcStyleDuration * 1000),
    scriptMs: pick(r => src(r).cost.ScriptDuration * 1000),
    heapKb: pick(r => src(r).cost.JSHeapUsedSize),
    earlyMs: Math.round(early * 1000) / 1000,
    lateMs: Math.round(late * 1000) / 1000,
    growthRatio: Math.round((late / Math.max(0.001, early)) * 100) / 100,
  };
};

const report = {
  turns: TURNS,
  boot: { ms: pick(r => r.boot.bootMs), nodes: pick(r => r.boot.nodes) },
  openConversation: {
    nodes: pick(r => r.render.nodes),
    totalMs: pick(r => r.render.totalMs),
    layoutMs: pick(r => r.render.cost.LayoutDuration * 1000),
    styleMs: pick(r => r.render.cost.RecalcStyleDuration * 1000),
    layouts: pick(r => r.render.cost.LayoutCount),
    heapKb: pick(r => r.render.cost.JSHeapUsedSize),
  },
  typing: {
    ...summarize(runs.flatMap(r => r.typing.samples)),
    layoutMsPerKey: Math.round(pick(r => r.typing.cost.LayoutDuration * 1000) / 40 * 1000) / 1000,
    layoutsPerKey: Math.round(pick(r => r.typing.cost.LayoutCount) / 40 * 100) / 100,
  },
  scroll: {
    ...summarize(runs.flatMap(r => r.scroll.frames)),
    layoutMsPerFrame: Math.round(pick(r => r.scroll.cost.LayoutDuration * 1000) / 60 * 1000) / 1000,
    styleMsPerFrame: Math.round(pick(r => r.scroll.cost.RecalcStyleDuration * 1000) / 60 * 1000) / 1000,
  },
  stream: streamSummary('stream'),
  streamCode: streamSummary('streamCode'),
};


if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);
  console.log(`\nwebview perf (${TURNS} turns, median of ${RUNS} runs, 460x900)\n`);
  console.log('boot');
  line('ready at', `${report.boot.ms} ms`);
  line('dom nodes', report.boot.nodes);
  console.log('\nopen conversation');
  line('build dom (wall)', `${report.openConversation.totalMs} ms`);
  line('layout', `${report.openConversation.layoutMs} ms`);
  line('style recalc', `${report.openConversation.styleMs} ms`);
  line('dom nodes', `${report.openConversation.nodes}`);
  line('heap delta', `${report.openConversation.heapKb} KB`);
  console.log('\ntyping (per keystroke)');
  line('p50 / p95 / max', `${report.typing.p50} / ${report.typing.p95} / ${report.typing.max} ms`);
  line('layout', `${report.typing.layoutMsPerKey} ms`);
  line('layouts', `${report.typing.layoutsPerKey} per key`);
  console.log('\nscroll (per frame)');
  line('p50 / p95 / max', `${report.scroll.p50} / ${report.scroll.p95} / ${report.scroll.max} ms`);
  line('layout', `${report.scroll.layoutMsPerFrame} ms`);
  line('style recalc', `${report.scroll.styleMsPerFrame} ms`);
  const streamLines = (label, s) => {
    console.log(`\nstreaming ${label} (${DELTAS} deltas)`);
    line('frame p50 / p95 / max', `${s.p50} / ${s.p95} / ${s.max} ms`);
    line('cost first 25 / last 25', `${s.earlyMs} / ${s.lateMs} ms`);
    line('growth ratio', `${s.growthRatio}x (1.0 = flat)`);
    line('long tasks', `${s.longTasks} (${s.longTaskMs} ms total)`);
    line('script / layout / style', `${s.scriptMs} / ${s.layoutMs} / ${s.styleMs} ms`);
    line('heap delta', `${s.heapKb} KB`);
  };
  streamLines('prose', report.stream);
  streamLines('code fence', report.streamCode);
  console.log('');
}
