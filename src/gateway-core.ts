/**
 * The SleepyAI gateway credential file.
 *
 * Split out of `sleepyai.ts` so it is testable directly: that module imports
 * `vscode` for two `openExternal` calls, which makes it unloadable under the
 * strip-types test runner. Everything here is filesystem and environment only.
 *
 * The file is shared with the CLI. `sleepy login` writes it, the extension reads it,
 * and the extension also writes it when it rotates a token — so this module is the
 * single place that decides which copy wins and when a read can be skipped.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export function gatewayCandidates(): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (process.env.SLEEPY_HOME) {
    list.push(path.join(process.env.SLEEPY_HOME, 'config', 'gateway.json'));
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  list.push(path.join(xdgConfig, 'sleepy', 'gateway.json'));
  list.push(path.join(home, '.sleepy', 'gateway.json'));
  return [...new Set(list)];
}

export const GATEWAY_FILE = gatewayCandidates()[0];

export interface GatewayConfig {
  access_token?: string;
  token?: string;
  refresh_token?: string;
  expires_at?: number;
  endpoint?: string;
  tier?: string;
  email?: string;
  dashboard_url?: string;
}

/**
 * Memoized gateway config, revalidated by mtime and size rather than trusted blindly.
 *
 * A read costs a `readFileSync` plus a `JSON.parse` per candidate (measured 15.4 us
 * warm, far worse on a network home), and `getSleepyTokenSync` reaches it from every
 * `config()` call — 32 sites, several of which run twice per invocation. Nothing
 * cached it, so a burst of UI updates meant a burst of disk reads on the extension
 * host's single thread.
 *
 * A plain memo would be wrong: this file is also written by `sleepy login` outside
 * the extension, and that is how a user signs in from a terminal. Keying on the
 * winning path plus its `mtimeMs` and `size` makes a stat (1.25 us) stand in for the
 * read, while any external rewrite changes the key and forces a fresh read. Size
 * alone would not be enough — a rotated token keeps the file length — which is why
 * the mtime is part of the key and why `invalidateGatewayConfig` exists for the
 * same-size, same-mtime rewrite this extension performs itself.
 */
const gatewayCache = new Map<string, { mtimeMs: number; size: number; config: GatewayConfig }>();

export function readGatewayConfig(): GatewayConfig | null {
  for (const candidate of gatewayCandidates()) {
    let stamp: { mtimeMs: number; size: number };
    try {
      const stat = fs.statSync(candidate);
      stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      // Absent or unreadable: a later candidate may still hold the credentials.
      continue;
    }
    const cached = gatewayCache.get(candidate);
    if (cached && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached.config;
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw) as GatewayConfig;
      if (parsed && typeof parsed === 'object' && (parsed.access_token || parsed.token)) {
        gatewayCache.set(candidate, { ...stamp, config: parsed });
        return parsed;
      }
    } catch { }
    // Readable but unusable (bad JSON, no token): drop any stale entry so a later
    // fix to the file is not masked by a cache hit.
    gatewayCache.delete(candidate);
  }
  return null;
}

/** Drop the memoized config. Called after this extension writes or clears the file. */
export function invalidateGatewayConfig(): void {
  gatewayCache.clear();
}

export async function writeGatewayConfig(config: GatewayConfig): Promise<void> {
  // Cleared before writing, not after: a refresh that fails midway must not leave a
  // cache entry describing a credential that was never persisted.
  gatewayCache.clear();
  for (const file of gatewayCandidates()) {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmpPath = `${file}.tmp`;
      await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
      await fsp.rename(tmpPath, file);
    } catch { }
  }
}

export async function clearGatewayConfig(): Promise<void> {
  gatewayCache.clear();
  for (const file of gatewayCandidates()) {
    await fsp.unlink(file).catch(() => { });
  }
}
