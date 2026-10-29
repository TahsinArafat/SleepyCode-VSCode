/*
 * The background reconnect's retry decision, kept pure.
 *
 * The reported symptom it exists to fix: after a VS Code restart every saved MCP
 * server read "idle" until the user pressed Reconnect. The cause was arithmetic
 * here, not transport —
 *
 *   `if (connected === 0 && stillDown > 0) retry()`
 *
 * which stops retrying as soon as ONE server answers, and which counted a
 * switched-off server as down. A single healthy remote server plus one disabled
 * one therefore ended the retries with the rest never coming back.
 *
 * Dependency-free so the decision is assertable directly
 * (`test/mcp-warm-core.direct.mjs`) instead of only through a live extension.
 */

export interface WarmStatus {
  name: string;
  connected: boolean;
  /** Switched off by the user: not connected is correct, not a failure. */
  disabled?: boolean;
}

export interface WarmVerdict {
  /** At least one enabled server is not connected. */
  retry: boolean;
  /** Enabled servers that are not connected. */
  down: string[];
  /** Enabled servers, connected or not. Disabled ones are excluded. */
  enabled: string[];
  connected: number;
  total: number;
}

/**
 * Decide whether another reconnect pass is worth running.
 *
 * `retry` is true while ANY enabled server is down — not only when every one is.
 * With nothing saved there is nothing to retry.
 */
export function warmVerdict(statuses: readonly (WarmStatus | null | undefined)[] | undefined): WarmVerdict {
  // Rows are dropped when they are not objects at all: the statuses cross a
  // webview boundary and a malformed entry must not take the whole retry loop
  // down with a TypeError.
  const rows = (Array.isArray(statuses) ? statuses : [])
    .filter((row): row is WarmStatus => Boolean(row) && typeof row === 'object');
  const enabled = rows.filter(row => row.disabled !== true);
  const down = enabled.filter(row => !row.connected);
  return {
    retry: down.length > 0,
    down: down.map(row => row.name),
    enabled: enabled.map(row => row.name),
    connected: rows.filter(row => row.connected).length,
    total: rows.length,
  };
}

/**
 * How long to wait before the next pass.
 *
 * Fast retries first, then a steady heartbeat rather than a hard stop: a server
 * started an hour after the window opened is still one the user expects to work
 * without pressing Reconnect.
 */
export function warmDelayMs(attempt: number, options: {
  backoffMs?: readonly number[];
  heartbeatMs?: number;
  /** A user-triggered pass starts the fast ladder again. */
  immediate?: boolean;
} = {}): number {
  const ladder = options.backoffMs?.length ? options.backoffMs : [5_000, 15_000, 45_000, 120_000];
  const heartbeat = options.heartbeatMs ?? 120_000;
  const index = Math.max(0, Math.min(attempt, ladder.length - 1));
  if (options.immediate) return ladder[0]!;
  return attempt < ladder.length ? ladder[index]! : heartbeat;
}
