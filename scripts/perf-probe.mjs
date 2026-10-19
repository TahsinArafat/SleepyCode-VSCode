/**
 * Latency probe for the chat webview.
 *
 * "It feels laggy" is not actionable; this turns it into numbers. It renders the shipping
 * webview (see `scripts/webview-harness.mjs`) in real Chromium and measures the four things a
 * user actually feels: opening a long conversation, typing in the composer, scrolling history,
 * and watching a reply stream in.
 *
 * Usage:
 *   node scripts/perf-probe.mjs                # 3 runs x 120 turns, human-readable
 *   node scripts/perf-probe.mjs --json         # machine-readable, for before/after diffs
 *   node scripts/perf-probe.mjs --runs=1 --turns=300
 */
import { chromium } from 'playwright-core';
import { buildPage, transcript } from './webview-harness.mjs';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const RUNS = Number(arg('runs') || 3);
const TURNS = Number(arg('turns') || 120);
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

async function measureOnce(html) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('input') !== null, undefined, { timeout: 10_000 });

  // Boot: from the first line of the injected script to the webview being ready to render.
  const boot = await page.evaluate(() => ({
    bootMs: Math.round(performance.now() - (window.__bootAt || 0)),
    nodes: document.getElementsByTagName('*').length,
  }));

  const items = transcript(TURNS);

  // Opening a conversation: the whole transcript is rebuilt from scratch each time.
  const render = await scenario(page, cdp, () => page.evaluate(items => {
    const at = performance.now();
    window.__emit({ type: 'conversation', id: 'c1', items });
    const scriptMs = performance.now() - at;
    void document.body.offsetHeight; // flush style + layout so the number includes paint prep
    return { scriptMs, totalMs: performance.now() - at, nodes: document.getElementsByTagName('*').length };
  }, items));

  // Typing: the InputEvent handler runs `resize()` -> forced layout reads on every keystroke.
  const typing = await scenario(page, cdp, () => page.evaluate(() => {
    const input = document.getElementById('input');
    input.focus();
    const times = [];
    for (let i = 0; i < 40; i++) {
      input.value += 'a';
      const at = performance.now();
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      times.push(performance.now() - at);
    }
    return { samples: times, nodes: document.getElementsByTagName('*').length };
  }));

  // Scrolling back through history, one viewport-ish step per frame.
  const scroll = await scenario(page, cdp, () => page.evaluate(() => new Promise(resolve => {
    const messages = document.getElementById('messages');
    messages.scrollTop = messages.scrollHeight;
    const frames = [];
    let last = performance.now();
    let steps = 0;
    const done = () => resolve({ frames });
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      messages.scrollTop -= 400;
      if (++steps < 60) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
    setTimeout(done, 4000); // rAF can stall in headless; never hang the probe
  })));

  // Streaming: 200 deltas, coalesced by the webview but still a DOM write per frame.
  const stream = await scenario(page, cdp, () => page.evaluate(() => new Promise(resolve => {
    const frames = [];
    const longTasks = [];
    const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push(e.duration) });
    observer.observe({ entryTypes: ['longtask'] });
    let last = performance.now();
    let frames_running = true;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (frames_running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    let sent = 0;
    const timer = setInterval(() => {
      window.__emit({ type: 'delta', conversationId: 'c1', text: 'streamed token ' });
      if (++sent >= 200) {
        clearInterval(timer);
        frames_running = false;
        observer.disconnect();
        resolve({ frames, longTasks });
      }
    }, 8);
    setTimeout(() => {
      clearInterval(timer);
      frames_running = false;
      resolve({ frames, longTasks });
    }, 8000);
  })));

  await browser.close();
  return { boot, render, typing, scroll, stream };
}

const pageHtml = await buildPage();
const runs = [];
for (let i = 0; i < RUNS; i++) {
  const run = await measureOnce(pageHtml);
  runs.push(run);
  if (!JSON_OUT) process.stderr.write(`run ${i + 1}/${RUNS}\n`);
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const pick = fn => median(runs.map(fn));

const report = {
  turns: TURNS,
  boot: { ms: pick(r => r.boot.bootMs), nodes: pick(r => r.boot.nodes) },
  openConversation: {
    nodes: pick(r => r.render.nodes),
    scriptMs: pick(r => r.render.scriptMs),
    totalMs: pick(r => r.render.totalMs),
    layoutMs: pick(r => r.render.cost.LayoutDuration * 1000),
    styleMs: pick(r => r.render.cost.RecalcStyleDuration * 1000),
    layouts: pick(r => r.render.cost.LayoutCount),
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
  stream: {
    ...summarize(runs.flatMap(r => r.stream.frames)),
    longTasks: pick(r => r.stream.longTasks.length),
    longTaskMs: Math.round(pick(r => r.stream.longTasks.reduce((a, b) => a + b, 0)) * 10) / 10,
    layoutMs: pick(r => r.stream.cost.LayoutDuration * 1000),
    styleMs: pick(r => r.stream.cost.RecalcStyleDuration * 1000),
    scriptMs: pick(r => r.stream.cost.ScriptDuration * 1000),
  },
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
  line('script (build dom)', `${report.openConversation.scriptMs} ms`);
  line('script + layout', `${report.openConversation.totalMs} ms`);
  line('layout', `${report.openConversation.layoutMs} ms`);
  line('style recalc', `${report.openConversation.styleMs} ms`);
  line('dom nodes', report.openConversation.nodes);
  console.log('\ntyping (per keystroke)');
  line('p50 / p95 / max', `${report.typing.p50} / ${report.typing.p95} / ${report.typing.max} ms`);
  line('layout', `${report.typing.layoutMsPerKey} ms`);
  line('layouts', `${report.typing.layoutsPerKey} per key`);
  console.log('\nscroll (per frame)');
  line('p50 / p95 / max', `${report.scroll.p50} / ${report.scroll.p95} / ${report.scroll.max} ms`);
  line('layout', `${report.scroll.layoutMsPerFrame} ms`);
  line('style recalc', `${report.scroll.styleMsPerFrame} ms`);
  console.log('\nstreaming (200 deltas)');
  line('frame p50 / p95 / max', `${report.stream.p50} / ${report.stream.p95} / ${report.stream.max} ms`);
  line('long tasks', `${report.stream.longTasks} (${report.stream.longTaskMs} ms total)`);
  line('script / layout / style', `${report.stream.scriptMs} / ${report.stream.layoutMs} / ${report.stream.styleMs} ms`);
  console.log('');
}
