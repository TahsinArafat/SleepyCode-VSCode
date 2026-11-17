import type * as vscode from 'vscode';
import { lstatSync, readFileSync } from 'node:fs';
// Explicit extension: the direct suite loads this module with
// `node --experimental-strip-types`, which does not resolve extensionless imports.
import { isBinaryPath, isIgnoredRelativePath, RepoIndex, scanWorkspace } from './repo-index.ts';
import { MAX_FILE_BYTES } from './types.ts';

/**
 * Owns the workspace index and its lifetime.
 *
 * The index used to be a field on `AgentViewProvider`, assigned in one place and never
 * released from anywhere else, so its lifetime defaulted to the process. It is the
 * single largest retainer in the extension (~150 MB on a 4,000-file workspace), which
 * made "nobody owns this" an expensive default.
 *
 * This class exists so the lifetime is expressible: the cache, the root it belongs to,
 * and every way it can be dropped live in one place with a `dispose()`. The provider
 * keeps a single instance and delegates.
 *
 * Nothing here reaches into the host: the scan root arrives as a `vscode.Uri` and the
 * caller decides when a workspace change or a hide invalidates it.
 */
export class RepoIndexService {
  private cache?: { root: string; index: RepoIndex };

  /** The index for `root`, building it on first use and reusing it afterwards. */
  async load(root: vscode.Uri): Promise<RepoIndex> {
    if (this.cache?.root === root.fsPath) return this.cache.index;
    // A different root means the cached tree is for a workspace we are no longer in.
    this.cache = undefined;
    const index = new RepoIndex(await scanWorkspace(root.fsPath));
    this.cache = { root: root.fsPath, index };
    return index;
  }

  /**
   * The cached index for `root`, or undefined when nothing is indexed yet.
   *
   * Callers that only want to *read* an existing index use this rather than `load`: a
   * cache miss must not trigger a full workspace scan behind a search box.
   */
  indexFor(root: vscode.Uri): RepoIndex | undefined {
    return this.cache?.root === root.fsPath ? this.cache.index : undefined;
  }

  /** How many files are indexed, for the memory report. Zero when nothing is loaded. */
  get fileCount(): number {
    return this.cache ? this.cache.index.files.length : 0;
  }

  /**
   * Re-index one file after it changed on disk.
   *
   * A delete or an over-size file removes the entry; anything else re-reads it. The
   * derived indices are dropped by `upsert`/`remove`, so the next symbol search
   * rebuilds them lazily rather than on this path.
   */
  refreshEntry(root: vscode.Uri, relative: string, uri: vscode.Uri): void {
    const cached = this.cache;
    if (!cached || cached.root !== root.fsPath) return;
    if (isBinaryPath(relative) || isIgnoredRelativePath(relative)) {
      cached.index.remove(relative);
      return;
    }
    try {
      const stat = lstatSync(uri.fsPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) cached.index.remove(relative);
      else cached.index.upsert({ path: relative, content: readFileSync(uri.fsPath, 'utf8') });
    } catch {
      // Gone, or unreadable: the index must not keep it either way.
      cached.index.remove(relative);
    }
  }

  /** Drop the workspace index. Called on workspace change, on hide, and on dispose. */
  dispose(): void {
    this.cache = undefined;
  }
}
