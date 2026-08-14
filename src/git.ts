import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { truncate } from './util';

export function isGitTrackedWorkspace(rootPath?: string): boolean {
  if (!rootPath) return false;
  const result = spawnSync('git', ['-C', rootPath, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.trim() === 'true';
}

function runGit(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      const output = Buffer.concat(stdout).toString();
      if (code === 0) resolve(output);
      else reject(new Error(Buffer.concat(stderr).toString().trim() || `git ${args[0]} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

export async function captureGitTree(rootPath: string, pruneContext?: { context?: any; lastPrune?: number }): Promise<string> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sleepycode-git-'));
  const env = { GIT_INDEX_FILE: path.join(temporaryDirectory, 'index') };
  try {
    try { await runGit(['read-tree', 'HEAD'], rootPath, env); }
    catch { await runGit(['read-tree', '--empty'], rootPath, env); }
    await runGit(['add', '-A', '--', '.'], rootPath, env);
    const tree = (await runGit(['write-tree'], rootPath, env)).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error('Git did not produce a valid restore tree.');
    await runGit(['update-ref', `refs/sleepycode/checkpoints/${tree}`, tree], rootPath);
    await maybePruneCheckpoints(rootPath, pruneContext);
    return tree;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function maybePruneCheckpoints(rootPath: string, pruneContext?: { context?: any; lastPrune?: number }): Promise<void> {
  if (!pruneContext?.context) return;
  const now = Date.now();
  const lastPrune = pruneContext.lastPrune ?? 0;
  if (now - lastPrune < 24 * 60 * 60 * 1000) return;
  try {
    const refsOutput = await runGit(['for-each-ref', 'refs/sleepycode/checkpoints', '--format=%(creatordate:unix) %(refname)'], rootPath);
    const cutoff = Math.floor(now / 1000) - 30 * 24 * 60 * 60;
    const lines = refsOutput.trim().split('\n').filter(Boolean);
    const toDelete: string[] = [];
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(refs\/sleepycode\/checkpoints\/\w+)$/);
      if (match && match[1] && match[2] && Number(match[1]) < cutoff) toDelete.push(match[2]);
    }
    if (toDelete.length) {
      await Promise.all(toDelete.map(ref => runGit(['update-ref', '-d', ref], rootPath)));
    }
    await pruneContext.context.globalState.update('sleepycode.lastCheckpointPrune', now);
  } catch { }
}

export async function restoreGitTree(rootPath: string, targetTree: string): Promise<void> {
  const currentTree = await captureGitTree(rootPath);
  if (currentTree === targetTree) return;
  const patch = await runGit(['diff', '--binary', '--full-index', currentTree, targetTree, '--', '.'], rootPath);
  if (!patch) return;
  await runGit(['apply', '--binary', '--whitespace=nowarn', '-'], rootPath, {}, patch);
}

export function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, windowsHide: true, detached: process.platform !== 'win32' });
    let output = '';
    const append = (chunk: Buffer) => { output = truncate(output + chunk.toString()); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        child.kill('SIGTERM');
        try { require('child_process').execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      } else {
        child.kill('SIGTERM');
      }
      reject(new Error(`Command timed out after ${timeoutMs / 1000}s.\n${output}`));
    }, timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (process.platform === 'win32') {
        child.kill('SIGTERM');
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      } else {
        child.kill('SIGTERM');
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); code === 0 ? resolve(output || '(command completed with no output)') : reject(new Error(`Command exited with code ${code}.\n${output}`)); });
  });
}

export async function stageGitPaths(rootPath: string, relativePaths: string[]): Promise<void> {
  const paths = [...new Set(relativePaths.map(value => value.replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))];
  if (!paths.length) return;
  await runGit(['add', '-A', '--', ...paths], rootPath);
}

export async function restoreGitPath(rootPath: string, targetTree: string, relativePath: string): Promise<void> {
  const safe = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!safe) throw new Error('A workspace-relative path is required.');
  const currentTree = await captureGitTree(rootPath);
  if (currentTree === targetTree) return;
  const patch = await runGit(['diff', '--binary', '--full-index', currentTree, targetTree, '--', safe], rootPath);
  if (!patch) return;
  await runGit(['apply', '--binary', '--whitespace=nowarn', '-'], rootPath, {}, patch);
}

export async function gitFileAtTree(rootPath: string, tree: string, relativePath: string): Promise<string | undefined> {
  const safe = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!safe) return undefined;
  try {
    return await runGit(['show', `${tree}:${safe}`], rootPath);
  } catch {
    return undefined;
  }
}


export async function gitHeadTreeOrEmpty(rootPath: string): Promise<string> {
  try { return (await runGit(['rev-parse', 'HEAD^{tree}'], rootPath)).trim(); }
  catch { return (await runGit(['mktree'], rootPath, {}, '')).trim(); }
}

export async function gitChangedPathsBetween(rootPath: string, fromTree: string, toTree: string, relativePaths: string[]): Promise<string[]> {
  const paths = [...new Set(relativePaths.map(value => value.replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))];
  if (!paths.length) return [];
  const output = await runGit(['diff', '--name-only', fromTree, toTree, '--', ...paths], rootPath);
  return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

export async function commitGit(rootPath: string, message: string): Promise<string> {
  const clean = message.replace(/\r/g, '').trim();
  if (!clean) throw new Error('Commit message cannot be empty.');
  return (await runGit(['commit', '-m', clean], rootPath)).trim();
}

export async function gitPorcelain(rootPath: string): Promise<string> {
  return runGit(['status', '--porcelain=v1'], rootPath);
}

export async function gitHeadShort(rootPath: string): Promise<string> {
  return (await runGit(['rev-parse', '--short', 'HEAD'], rootPath)).trim();
}
