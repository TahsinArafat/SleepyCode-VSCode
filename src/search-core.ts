/**
 * Locating ripgrep, and turning a user's search request into its arguments.
 *
 * `search_files` used to be a substring scan that read every candidate file in full,
 * sequentially, on the extension host's single thread: 51 ms for 107 files in this
 * repository, and the cost is linear, so a 4,000-file workspace blocks for roughly two
 * seconds on EVERY search. It also had no regex, no case control and no context lines,
 * which meant the agent often had to search several times to find one thing.
 *
 * VS Code ships ripgrep with its own search, so the binary is normally already on disk.
 * Its location moves between builds (`ripgrep` vs `ripgrep-universal`, platform
 * subfolders), so candidates are probed in order and the first executable wins. When
 * none is found the caller keeps the old in-process scan: slower, but never broken.
 */

import * as path from 'node:path';

export type SearchOptions = {
  pattern: string;
  /** Glob limiting which files are searched. */
  glob?: string;
  /** Treat the pattern as a regular expression rather than literal text. */
  regex?: boolean;
  /** Match case-sensitively. Default false, matching the old behaviour. */
  caseSensitive?: boolean;
  /** Lines of context before and after each match. */
  contextLines?: number;
  /** Stop after this many matching lines. */
  limit?: number;
};

export const DEFAULT_SEARCH_LIMIT = 80;
export const MAX_SEARCH_LIMIT = 400;
export const MAX_CONTEXT_LINES = 5;

/**
 * Every place a bundled ripgrep has been seen, most specific first.
 *
 * `appRoot` is `vscode.env.appRoot`, which points at the editor's `resources/app`
 * directory. The platform subfolder has to be built from `process.platform`/`arch`
 * because the universal build keeps one binary per target.
 */
export function ripgrepCandidates(appRoot: string | undefined, platform = process.platform, arch = process.arch): string[] {
  if (!appRoot) return [];
  const exe = platform === 'win32' ? 'rg.exe' : 'rg';
  const target = `${platform === 'win32' ? 'win32' : platform}-${arch}`;
  const roots = [
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode'),
    // A non-asar build (some source builds) keeps the same layout unpacked.
    path.join(appRoot, 'node_modules', '@vscode'),
    path.join(appRoot, 'node_modules.asar.unpacked'),
    path.join(appRoot, 'node_modules'),
  ];
  const packages = ['ripgrep-universal', 'ripgrep'];
  const out: string[] = [];
  for (const root of roots) {
    for (const pkg of packages) {
      // The universal package nests one more directory per target; the plain one
      // keeps the binary directly in `bin/`.
      out.push(path.join(root, pkg, 'bin', target, exe));
      out.push(path.join(root, pkg, 'bin', exe));
    }
  }
  return out;
}

/**
 * The arguments for one search.
 *
 * `--json` is deliberately NOT used: it is verbose, and a model reading the output
 * needs `path:line: text`, which is also what a human expects from grep. `--no-ignore`
 * is not passed either, so the user's own `.gitignore` is respected; the explicit glob
 * exclusion list is applied on top for the directories that are never interesting.
 */
export function searchArgs(options: SearchOptions, rootPath: string): string[] {
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT));
  const args: string[] = [
    '--line-number',
    '--no-heading',
    '--with-filename',
    '--color', 'never',
    // Binary files produce noise a model cannot use. ripgrep skips them by default, and
    // `--binary-files` was REMOVED in ripgrep 15 (the flag is `--binary` now), so naming
    // it here made every search exit 2 with "unrecognized flag" on a modern build.
    // One enormous line (a minified bundle) is not worth 500 KB of context.
    '--max-columns', '500',
    '--max-columns-preview',
    // Do not follow symlinks: a loop here would be an infinite scan.
    '--no-follow',
    `--max-count`, String(limit),
  ];
  if (!options.regex) args.push('--fixed-strings');
  if (!options.caseSensitive) args.push('--ignore-case');
  const context = Math.min(MAX_CONTEXT_LINES, Math.max(0, options.contextLines ?? 0));
  if (context > 0) args.push('--context', String(context));
  if (options.glob) args.push('--glob', options.glob);
  // Never search what the agent should not see, and never search build output.
  for (const excluded of ['!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!out/**', '!coverage/**']) {
    args.push('--glob', excluded);
  }
  args.push('--', options.pattern, rootPath);
  return args;
}

/**
 * Whether a search hit's file must be withheld, mirroring `isSecret`.
 *
 * Applied to rg's output rather than its arguments because a `.env` inside a directory
 * the user explicitly asked about would otherwise slip through: ripgrep's glob list is
 * about build output, not about secrets.
 */
export function isSecretPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part) || /^(credentials|secrets?)\.(json|ya?ml|toml)$/i.test(part));
}

/**
 * Trim rg's output to the requested number of matching lines.
 *
 * ripgrep's `--max-count` is per FILE, not overall, so a broad pattern can still return
 * far more than the caller asked for. This caps the total and says when it did, so a
 * truncated result is not mistaken for the whole answer.
 */
export function capSearchOutput(text: string, limit: number): { text: string; truncated: boolean } {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= limit) return { text: lines.join('\n'), truncated: false };
  return {
    text: `${lines.slice(0, limit).join('\n')}\n\n[showing the first ${limit} of ${lines.length} matching lines. Narrow the pattern or glob to see the rest.]`,
    truncated: true,
  };
}
