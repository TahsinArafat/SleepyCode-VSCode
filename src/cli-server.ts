/**
 * Locating and starting the Sleepy CLI server.
 *
 * The extension is a client. It never opens `sleepy.db`; it finds a running
 * `sleepy serve` on loopback or starts one, then talks HTTP. The only local
 * state touched here is the child process the extension itself spawned.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Ports tried when looking for an already-running server. 4096 is the CLI default. */
export const CLI_PROBE_PORTS = [4096, 4097, 4098];

const LISTENING = /listening on\s+(https?:\/\/[^\s"']+)/i;

/** Pull the listening URL out of `sleepy serve` stdout. Returns undefined if absent. */
export function parseListeningUrl(output: string): string | undefined {
  const match = LISTENING.exec(output ?? '');
  return match?.[1];
}

/** Candidate paths for the `sleepy` binary, in priority order. */
export function candidateBinaries(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const pathEnv = env.PATH ?? '';
  for (const dir of pathEnv.split(':')) {
    if (dir) candidates.push(join(dir, 'sleepy'));
  }
  candidates.push(join(homedir(), '.local', 'bin', 'sleepy'));
  return candidates;
}

/** First existing `sleepy` binary, or undefined when the CLI is not installed. */
export function findCliBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const candidate of candidateBinaries(env)) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Unreadable PATH entry: keep looking.
    }
  }
  return undefined;
}

export type CliServer = {
  /** Base URL of the loopback server. */
  url: string;
  /** The child this process started, or undefined when attaching to a running one. */
  child?: ChildProcess;
  /** True when this extension owns the process and should stop it on deactivate. */
  owned: boolean;
};

/** True when something healthy is already listening on this port. */
export async function probePort(port: number, timeoutMs = 700): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attach to an already-running server, or start one and return its base URL.
 *
 * `sleepy serve` takes no directory argument — passing one makes it print help
 * and exit 1. The workspace is scoped by spawning the child with that `cwd`,
 * because the CLI assigns each session the server's working directory. So
 * `session.create` can omit the directory and still land in the right workspace.
 */
export async function startOrAttach(opts: { directory?: string; env?: NodeJS.ProcessEnv; spawnFn?: typeof spawn } = {}): Promise<CliServer> {
  const env = opts.env ?? process.env;
  const spawnProcess = opts.spawnFn ?? spawn;

  for (const port of CLI_PROBE_PORTS) {
    if (await probePort(port)) return { url: `http://127.0.0.1:${port}`, owned: false };
  }

  const binary = findCliBinary(env);
  // No CLI on this machine: the caller keeps the local fallback engine.
  if (!binary) throw new Error('sleepy CLI not found');

  const child = spawnProcess(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    env,
    // The CLI files each session under the server's working directory.
    cwd: opts.directory,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the sleepy server to start.')), 30_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const found = parseListeningUrl(output);
      if (!found) return;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      resolve(found);
    };
    child.stdout?.on('data', onData);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`The sleepy server exited with code ${code ?? 'unknown'} before listening.`));
    });
  });

  // Keep draining stdout/stderr so a chatty server cannot fill the pipe buffer.
  child.stdout?.resume();
  child.stderr?.resume();
  return { url, child, owned: true };
}
