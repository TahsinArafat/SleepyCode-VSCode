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
  return lines.join('\n');
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
