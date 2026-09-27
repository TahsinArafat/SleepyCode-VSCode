/**
 * Locating and starting the Sleepy CLI server.
 *
 * The extension is a client. It never opens `sleepy.db`; it finds a running
 * `sleepy serve` on loopback or starts one, then talks HTTP. The only local
 * state touched here is the child process the extension itself spawned.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Ports tried when looking for an already-running server. 4096 is the CLI default. */
export const CLI_PROBE_PORTS = [4096, 4097, 4098];

/**
 * Header the CLI reads to decide which project a request is about. Its
 * `InstanceMiddleware` resolves the directory per request from this header, a
 * `?directory=` query, or else the server's own cwd — so this is the only way to
 * name a workspace the server was not started in. `sleepy serve` takes no
 * directory argument (passing one makes it print help and exit 1).
 */
export const DIRECTORY_HEADER = 'x-sleepycode-directory';

/**
 * The CLI's stable code for "that directory is outside my cwd". It answers 403
 * with this code, and the CLI's own guidance is to branch on `code` rather than
 * the message prose, which can change.
 */
export const DIRECTORY_DENIED_CODE = 'directory_not_allowed';

const LISTENING = /listening on\s+(https?:\/\/[^\s"']+)/i;

/** Pull the listening URL out of `sleepy serve` stdout. Returns undefined if absent. */
export function parseListeningUrl(output: string): string | undefined {
  const match = LISTENING.exec(output ?? '');
  return match?.[1];
}

/** Candidate paths for the `sleepy` binary, in priority order. */
export function candidateBinaries(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];

  // 1. PATH entries (covers system install, Homebrew on Linux, manually added dirs).
  const pathEnv = env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const dir of pathEnv.split(sep)) {
    if (dir) candidates.push(join(dir, `sleepy${ext}`));
  }

  const home = homedir();

  // 2. Common per-user install locations (Linux/macOS).
  if (process.platform !== 'win32') {
    candidates.push(join(home, '.local', 'bin', 'sleepy'));
    candidates.push(join(home, 'bin', 'sleepy'));
    // Homebrew (Apple Silicon and Intel).
    candidates.push('/opt/homebrew/bin/sleepy');
    candidates.push('/usr/local/bin/sleepy');
    // Cargo installs.
    candidates.push(join(home, '.cargo', 'bin', 'sleepy'));
  }

  // 3. Windows-specific: Scoop and per-user installs.
  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    candidates.push(join(appData, 'sleepy', 'sleepy.exe'));
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    candidates.push(join(localAppData, 'sleepy', 'sleepy.exe'));
    // Scoop installs to %USERPROFILE%\scoop\shims.
    const userProfile = env.USERPROFILE ?? home;
    candidates.push(join(userProfile, 'scoop', 'shims', 'sleepy.exe'));
  }

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

/** True when the CLI refused the workspace rather than failing in transport. */
export function isDirectoryDenied(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === DIRECTORY_DENIED_CODE;
}

/** Same check for a raw response body. Unparseable text is not a denial. */
export function parseDirectoryDenied(text: string): boolean {
  try {
    return isDirectoryDenied(JSON.parse(text));
  } catch {
    return false;
  }
}

/** Absolute path with symlinks resolved, matching how the CLI reports it. */
function canonical(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Ask a running server which directory it would actually use for this workspace.
 *
 * Returns undefined when the server cannot serve it: it refused the directory
 * because it sits outside the server's cwd, or it is unreachable. That is the
 * signal to start our own server instead of silently writing into a stranger's
 * project.
 */
export async function resolveServerDirectory(url: string, directory: string, timeoutMs = 2_000): Promise<string | undefined> {
  try {
    const response = await fetch(`${url}/path`, {
      headers: { [DIRECTORY_HEADER]: directory },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { directory?: unknown };
    if (typeof body.directory !== 'string' || !body.directory) return undefined;
    return body.directory;
  } catch {
    return undefined;
  }
}

export type CliServer = {
  /** Base URL of the loopback server. */
  url: string;
  /** The child this process started, or undefined when attaching to a running one. */
  child?: ChildProcess;
  /** True when this extension owns the process and should stop it on deactivate. */
  owned: boolean;
  /**
   * Stderr lines captured from the server process for diagnostics. Only
   * populated for servers this extension itself started. Empty when attaching
   * to an already-running server (we do not own its stream).
   */
  stderrLines: string[];
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
 * Attach to a server already serving this workspace, or start one.
 *
 * A healthy server on a probe port is not automatically ours. The CLI refuses any
 * directory outside its own cwd, and adopts a session for whichever project it
 * was started in, so adopting a stranger's server would file this workspace's
 * conversations into someone else's project. Every candidate is therefore asked
 * which directory it would use for us, and only a real match is reused.
 *
 * `sleepy serve` takes no directory argument, so the child is spawned with the
 * workspace as its cwd, and the client names the workspace per request through
 * the directory header.
 */
export async function startOrAttach(opts: {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  probeFn?: (port: number) => Promise<boolean>;
  directoryFn?: (url: string, directory: string) => Promise<string | undefined>;
} = {}): Promise<CliServer> {
  const env = opts.env ?? process.env;
  const spawnProcess = opts.spawnFn ?? spawn;
  const probe = opts.probeFn ?? probePort;
  const askDirectory = opts.directoryFn ?? resolveServerDirectory;
  const wanted = opts.directory ? canonical(opts.directory) : undefined;

  if (wanted) {
    for (const port of CLI_PROBE_PORTS) {
      if (!(await probe(port))) continue;
      const url = `http://127.0.0.1:${port}`;
      // Undefined means it cannot serve this workspace at all: skip it rather
      // than letting our sessions land in whatever project it was started for.
      const served = await askDirectory(url, wanted);
      if (served && canonical(served) === wanted) return { url, owned: false, stderrLines: [] };
    }
  }

  const binary = findCliBinary(env);
  // No CLI on this machine: the caller keeps the local fallback engine.
  if (!binary) throw new Error('sleepy CLI not found');

  const child = spawnProcess(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    env,
    // The server's cwd is the outer bound on what it will serve, so a server we
    // start can always reach this workspace.
    cwd: opts.directory,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Capture stderr lines for diagnostics (binary crashes, auth errors, etc.).
  // Kept in memory so the extension can surface them when the server fails.
  const stderrLines: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) stderrLines.push(trimmed);
    }
    // Cap at 100 lines so the buffer does not grow unbounded during a long run.
    if (stderrLines.length > 100) stderrLines.splice(0, stderrLines.length - 100);
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
      const detail = stderrLines.length ? ` Last stderr: ${stderrLines.slice(-3).join(' | ')}` : '';
      reject(new Error(`The sleepy server exited with code ${code ?? 'unknown'} before listening.${detail}`));
    });
  });

  // Keep draining stdout so a chatty server cannot fill the pipe buffer.
  child.stdout?.resume();
  return { url, child, owned: true, stderrLines };
}
