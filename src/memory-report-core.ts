/**
 * Memory accounting for the extension host.
 *
 * The extension reports its footprint from `reportMemory` after a run, which meant an
 * idle window — the case where "opening it eats 6 GB" is reported — produced no
 * evidence at all. This module is the measurement, split out so it is testable and so
 * the report is one shape everywhere it appears.
 *
 * A single number is not an answer. `heapUsed` says "big"; it does not say whether the
 * bytes are conversation transcripts, an index, a child process's output, or the
 * extension host's own baseline. Every field here exists to separate one of those.
 */

export type MemorySnapshot = {
  /** V8 heap in use: JS objects this extension allocated, in bytes. */
  heapUsed: number;
  /** Heap the engine has reserved, which only falls after a GC. */
  heapTotal: number;
  /** Whole process, including native buffers and the V8 runtime itself. */
  rss: number;
  /** Bytes held outside the V8 heap: Buffers, ArrayBuffers, native allocations. */
  external: number;
  /** Part of `external` that is ArrayBuffers specifically. */
  arrayBuffers: number;
  /**
   * `old_space` from `v8.getHeapSpaceStatistics()`, in bytes.
   *
   * This is the one number that answers "is it retained or just not collected yet",
   * which `heapUsed` cannot: V8 grows its heap in response to allocation RATE, so a
   * process that has recently churned a lot of short-lived data holds a large heap full
   * of garbage that a GC would reclaim. `old_space` counts live long-lived objects, so
   * a large `old_space` with small retained state means something is genuinely held;
   * a small `old_space` with a large `heapUsed` means the engine is just sitting on
   * unreclaimed space.
   */
  oldSpace: number;
  /** `large_object_space`: big individual objects, arrays and strings. */
  largeObjectSpace: number;
  /** `code_space`: compiled JavaScript. Dominated by bundled dependencies. */
  codeSpace: number;
  /** `new_space`: recently allocated, awaiting a young GC. */
  newSpace: number;
  /**
   * Heap after an explicit GC, when the engine exposes one.
   *
   * Undefined in production: V8 only exposes `global.gc` under `--expose-gc`, which a
   * VS Code extension host is not started with. When it IS available the delta is the
   * most direct possible evidence of how much of the heap is garbage.
   */
  heapAfterGc?: number;
};

export type RetainerBreakdown = {
  projects: number;
  conversations: number;
  coldConversations: number;
  items: number;
  /** Serialized size of resident conversation state, in bytes. */
  stateBytes: number;
  /** True when `stateBytes` is a floor because a measurement saturated. */
  stateSaturated: boolean;
  /** Bytes of retained pre-edit file snapshots across the transcript. */
  snapshotBytes: number;
  indexFiles: number;
  indexBytes: number;
  /** Open terminal sessions and whether their child processes are still running. */
  terminals: number;
  runningTerminals: number;
  /** A CLI server this extension started, and whether it owns the child. */
  cliServerOwned: boolean;
  mcpCached: boolean;
  /** Live runs and queued prompts: work in flight explains a temporary spike. */
  activeRuns: number;
  queuedPrompts: number;
};

export type MemoryReport = {
  snapshot: MemorySnapshot;
  retainers: RetainerBreakdown;
  /**
   * Counts of the long-lived containers that have leaked before in this codebase.
   *
   * A map that grows by conversation id is invisible in `heapUsed` until it is
   * enormous, and then it is indistinguishable from "conversations are big". These
   * are the fields that tell them apart.
   */
  containers: Record<string, number>;
};

const MB = 1048576;

/** `12.3` for bytes, so every line of the report reads in the same unit. */
export function megabytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  return (bytes / MB).toFixed(1);
}

/**
 * The one-line form written to the log.
 *
 * Ordered by how the investigation proceeds: the process totals first (is this the
 * extension at all?), then the retainers that can be released, then the container
 * counts that reveal a leak. `state >N` marks a saturated measurement as a floor
 * rather than a figure.
 */
export function formatMemoryLine(report: MemoryReport): string {
  const { snapshot, retainers, containers } = report;
  const parts: string[] = [
    `heap ${megabytes(snapshot.heapUsed)}MB`,
    `heapTotal ${megabytes(snapshot.heapTotal)}MB`,
    `rss ${megabytes(snapshot.rss)}MB`,
    `external ${megabytes(snapshot.external)}MB`,
    `arrayBuffers ${megabytes(snapshot.arrayBuffers)}MB`,
    // old_space is what separates "retained" from "not yet collected", so it sits with
    // the process totals rather than in a section of its own.
    `old ${megabytes(snapshot.oldSpace)}MB`,
    `code ${megabytes(snapshot.codeSpace)}MB`,
    `new ${megabytes(snapshot.newSpace)}MB`,
  ];
  const r = retainers;
  parts.push(
    `${r.projects} projects`,
    `${r.conversations} conversations (${r.coldConversations} cold)`,
    `${r.items} items`,
    `state ${r.stateSaturated ? '>' : ''}${megabytes(r.stateBytes)}MB`,
    `snapshots ${megabytes(r.snapshotBytes)}MB`,
    `index ${r.indexFiles} files/${megabytes(r.indexBytes)}MB`,
    `terminals ${r.runningTerminals}/${r.terminals} running`,
    `mcp ${r.mcpCached ? 'cached' : 'none'}`,
    `runs ${r.activeRuns}`,
    `queued ${r.queuedPrompts}`,
  );
  const containerText = Object.entries(containers)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(' ');
  if (containerText) parts.push(`containers ${containerText}`);
  return parts.join(' · ');
}

/**
 * The multi-line form, for a copyable report the user can paste into a bug report.
 *
 * Same numbers as the log line, grouped so a reader who does not know the codebase can
 * still tell which section grew.
 */
export function formatMemoryReport(report: MemoryReport, extra: { at?: number; note?: string } = {}): string {
  const { snapshot, retainers: r, containers } = report;
  const lines: string[] = [];
  lines.push(`SleepyCode memory report${extra.at ? ` — ${new Date(extra.at).toISOString()}` : ''}`);
  if (extra.note) lines.push(extra.note);
  lines.push('');
  lines.push('Process (extension host)');
  lines.push(`  heap used      ${megabytes(snapshot.heapUsed)} MB`);
  lines.push(`  heap reserved  ${megabytes(snapshot.heapTotal)} MB`);
  lines.push(`  rss            ${megabytes(snapshot.rss)} MB   <- whole process, compare with the editor's process list`);
  lines.push(`  external       ${megabytes(snapshot.external)} MB   (buffers held outside the JS heap)`);
  lines.push(`    arrayBuffers ${megabytes(snapshot.arrayBuffers)} MB`);
  // The retained-vs-garbage split. This is the line that answers the question the rest
  // of the report raises: a large heap is not necessarily a large live set.
  lines.push('');
  lines.push('Heap breakdown');
  lines.push(`  live objects   ${megabytes(snapshot.oldSpace)} MB   (old_space: retained JS objects — large means something is held)`);
  lines.push(`  large objects  ${megabytes(snapshot.largeObjectSpace)} MB   (big individual arrays/strings)`);
  lines.push(`  new space      ${megabytes(snapshot.newSpace)} MB   (recent allocations, reclaimed by a young GC)`);
  lines.push(`  compiled code  ${megabytes(snapshot.codeSpace)} MB   (bundled dependencies)`);
  if (snapshot.heapAfterGc === undefined) {
    lines.push('');
    lines.push('  (heap after GC is unavailable: the extension host is not started with --expose-gc,');
    lines.push('   so the reported totals include unreclaimed space. Compare repeated reports instead.)');
  } else {
    lines.push(`  after GC       ${megabytes(snapshot.heapAfterGc)} MB   (reclaimed ${megabytes(Math.max(0, snapshot.heapUsed - snapshot.heapAfterGc))} MB)`);
  }
  lines.push('');
  lines.push('Conversation state');
  lines.push(`  projects       ${r.projects}`);
  lines.push(`  conversations  ${r.conversations} (${r.coldConversations} cold, heavy state released)`);
  lines.push(`  transcript     ${r.items} items`);
  lines.push(`  state          ${r.stateSaturated ? '>' : ''}${megabytes(r.stateBytes)} MB${r.stateSaturated ? '   (measurement saturated: at least this much)' : ''}`);
  lines.push(`  file snapshots ${megabytes(r.snapshotBytes)} MB   (pre-edit contents kept for undo)`);
  lines.push('');
  lines.push('Other retainers');
  lines.push(`  repo index     ${r.indexFiles} files / ${megabytes(r.indexBytes)} MB`);
  lines.push(`  terminals      ${r.runningTerminals} running of ${r.terminals}`);
  lines.push(`  MCP cache      ${r.mcpCached ? 'holding a connection' : 'empty'}`);
  lines.push(`  CLI server     ${r.cliServerOwned ? 'owned by this extension' : 'none/attached'}`);
  lines.push(`  work in flight ${r.activeRuns} run(s), ${r.queuedPrompts} queued prompt(s)`);
  // Filtered by COUNT, not by key presence: an entry holding zero is noise in a
  // section whose whole purpose is to show what is accumulating.
  const held = Object.entries(containers).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b));
  if (held.length) {
    lines.push('');
    lines.push('Long-lived containers (per-conversation maps and caches)');
    for (const [name, count] of held) lines.push(`  ${name.padEnd(24)} ${count}`);
  }
  lines.push('');
  lines.push(`Reading: ${memoryVerdict(report)}`);
  return lines.join('\n');
}

/**
 * What the numbers point at, as a short verdict.
 *
 * The reported case is 400+ MB of heap with ~1 MB of retained conversation state. That
 * has three very different explanations, and the report exists to name which one:
 *
 *   - `retained`    live long-lived JS objects. A real leak; something holds them.
 *   - `garbage`     a large heap of unreclaimed short-lived data. V8 grows the heap with
 *                   allocation rate, so this is often benign and shrinks on its own.
 *   - `code/native` the heap is small; the bytes are compiled JS or native buffers.
 *
 * This is advisory text for a human reading a bug report, never a decision that
 * changes behaviour.
 */
export function memoryVerdict(report: MemoryReport): string {
  const s = report.snapshot;
  const r = report.retainers;
  if (s.heapAfterGc !== undefined && s.rss < 1_000 * MB) {
    return 'heap normal after GC';
  }
  // Live objects dominate: this is the leak case.
  if (s.oldSpace > 250 * MB) {
    const explained = megabytes(r.stateBytes + r.snapshotBytes + r.indexBytes);
    return `old_space ${megabytes(s.oldSpace)}MB is live JS objects, while known retainers account for ${explained}MB — the rest is held somewhere this report does not name yet`;
  }
  // Compiled JavaScript is checked before the garbage reading, because a code-heavy heap
  // ALSO has a small old_space and would otherwise be reported as unreclaimed garbage --
  // a wrong answer that points the investigation at a GC that will not help.
  if (s.codeSpace > 150 * MB && s.codeSpace > s.oldSpace) {
    return `code_space ${megabytes(s.codeSpace)}MB: the heap is dominated by compiled JavaScript, i.e. bundled dependencies rather than session data`;
  }
  // The heap is big but not made of live objects: likely unreclaimed garbage.
  if (s.heapUsed > 250 * MB && s.oldSpace < 150 * MB) {
    return `heap ${megabytes(s.heapUsed)}MB but old_space only ${megabytes(s.oldSpace)}MB: mostly unreclaimed garbage, which shrinks after a GC. V8 sizes its heap by allocation rate, so a busy window holds more than it needs`;
  }
  if (s.external > 250 * MB) {
    return `external ${megabytes(s.external)}MB sits outside the JS heap: buffers or native allocations, not objects this report can count`;
  }
  return `retained state ${megabytes(r.stateBytes + r.snapshotBytes + r.indexBytes)}MB across ${r.conversations} conversations; heap ${megabytes(s.heapUsed)}MB`;
}

/**
 * Whether a snapshot looks like it is worth reporting as a problem.
 *
 * Used only to decide whether to log at `warn` instead of `info`, so an idle window
 * that is quietly holding a gigabyte shows up in a log scan without being read line by
 * line. Not a threshold for evicting anything — that decision belongs to the code that
 * owns each retainer.
 */
export function isConcerning(snapshot: MemorySnapshot): boolean {
  return snapshot.rss > 1_500 * MB || snapshot.heapUsed > 800 * MB;
}
