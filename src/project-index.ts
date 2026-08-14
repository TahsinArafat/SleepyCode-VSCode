import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  detectFrameworks,
  extractImports,
  extractSymbols,
  isImportantProjectFile,
  isIndexableProjectFile,
  languageForPath,
  retrieveProjectContext,
  summarizeProjectIndex,
  type IndexedProjectFile,
  type ProjectContextHit,
  type ProjectIntelligence,
} from './project-index-core';

const INDEX_VERSION = 1 as const;
const MAX_DISCOVERED_FILES = 3_500;
const MAX_INDEXED_BYTES = 220_000;
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,coverage,.next,.nuxt,.turbo,.cache,target,vendor,.venv,venv}/**';

export type ProjectIndexProgress = {
  status: 'idle' | 'indexing' | 'ready' | 'error';
  indexed?: number;
  total?: number;
  text?: string;
  index?: ProjectIntelligence;
};

function testLike(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/.test(normalized) || /\.(?:test|spec)\.[^.]+$/.test(normalized);
}

function packageFrameworks(content: string): string[] {
  try { return detectFrameworks(JSON.parse(content)); } catch { return []; }
}

function languageStats(files: IndexedProjectFile[]) {
  const counts = new Map<string, number>();
  for (const file of files) if (file.language) counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  return [...counts.entries()].map(([language, count]) => ({ language, files: count })).sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

export class ProjectIndexService {
  private current?: ProjectIntelligence;
  private currentRoot = '';
  private building?: Promise<ProjectIntelligence>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly post: (message: unknown) => void) { }

  get snapshot(): ProjectIntelligence | undefined { return this.current; }

  invalidate(rootPath?: string): void {
    if (!rootPath || rootPath === this.currentRoot) this.current = undefined;
  }

  async load(root: vscode.Uri): Promise<ProjectIntelligence | undefined> {
    if (this.current?.root === root.fsPath) return this.current;
    const file = this.storageFile(root.fsPath);
    if (!file) return undefined;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as ProjectIntelligence;
      if (parsed?.version === INDEX_VERSION && parsed.root === root.fsPath && Array.isArray(parsed.files)) {
        this.current = parsed;
        this.currentRoot = root.fsPath;
        return parsed;
      }
    } catch { }
    return undefined;
  }

  async ensure(root: vscode.Uri, force = false): Promise<ProjectIntelligence> {
    if (!force) {
      if (this.current?.root === root.fsPath) return this.current;
      const cached = await this.load(root);
      if (cached && Date.now() - cached.generatedAt < 10 * 60 * 1000) {
        this.post({ type: 'projectIndex', status: 'ready', indexed: cached.indexedFileCount, total: cached.fileCount, text: summarizeProjectIndex(cached), index: { ...cached, files: [] } });
        return cached;
      }
    }
    if (this.building && this.currentRoot === root.fsPath) return this.building;
    this.currentRoot = root.fsPath;
    this.building = this.build(root).finally(() => { this.building = undefined; });
    return this.building;
  }

  async contextFor(root: vscode.Uri, query: string, limit = 10): Promise<{ index: ProjectIntelligence; hits: ProjectContextHit[] }> {
    const index = await this.ensure(root);
    return { index, hits: retrieveProjectContext(index, query, limit) };
  }

  private async build(root: vscode.Uri): Promise<ProjectIntelligence> {
    this.post({ type: 'projectIndex', status: 'indexing', indexed: 0, total: 0, text: 'Learning this project…' });
    try {
      const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_DISCOVERED_FILES);
      const files: IndexedProjectFile[] = [];
      const importantFiles: string[] = [];
      const frameworks = new Set<string>();
      let processed = 0;
      const candidates = uris
        .map(uri => ({ uri, relative: path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/') }))
        .filter(item => item.relative && !item.relative.startsWith('..') && isIndexableProjectFile(item.relative));

      const workers = Array.from({ length: Math.min(12, Math.max(1, candidates.length)) }, async (_, workerIndex) => {
        for (let index = workerIndex; index < candidates.length; index += 12) {
          const item = candidates[index];
          if (!item) continue;
          try {
            const stat = await vscode.workspace.fs.stat(item.uri);
            if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_INDEXED_BYTES) continue;
            const language = languageForPath(item.relative);
            const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(item.uri));
            const record: IndexedProjectFile = {
              path: item.relative,
              language,
              size: stat.size,
              symbols: extractSymbols(content, language),
              imports: extractImports(content, language),
              testLike: testLike(item.relative),
            };
            files.push(record);
            if (isImportantProjectFile(item.relative)) importantFiles.push(item.relative);
            if (item.relative.toLowerCase().endsWith('package.json')) for (const framework of packageFrameworks(content)) frameworks.add(framework);
          } catch {
            // Best-effort indexing: unreadable/generated files must not block project intelligence.
          } finally {
            processed++;
            if (processed % 80 === 0 || processed === candidates.length) {
              this.post({ type: 'projectIndex', status: 'indexing', indexed: processed, total: candidates.length, text: `Indexing ${processed}/${candidates.length} files…` });
            }
          }
        }
      });
      await Promise.all(workers);
      files.sort((a, b) => a.path.localeCompare(b.path));
      importantFiles.sort();
      const intelligence: ProjectIntelligence = {
        version: INDEX_VERSION,
        root: root.fsPath,
        generatedAt: Date.now(),
        fileCount: uris.length,
        indexedFileCount: files.length,
        languages: languageStats(files),
        frameworks: [...frameworks].sort(),
        importantFiles: importantFiles.slice(0, 60),
        files,
      };
      this.current = intelligence;
      await this.persist(intelligence);
      this.post({ type: 'projectIndex', status: 'ready', indexed: files.length, total: uris.length, text: summarizeProjectIndex(intelligence), index: { ...intelligence, files: [] } });
      return intelligence;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'projectIndex', status: 'error', text });
      throw error;
    }
  }

  private storageFile(rootPath: string): string | undefined {
    const base = this.context.storageUri?.fsPath;
    if (!base) return undefined;
    let hash = 2166136261;
    for (const char of rootPath) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return path.join(base, `project-index-${(hash >>> 0).toString(16)}.json`);
  }

  private async persist(index: ProjectIntelligence): Promise<void> {
    const file = this.storageFile(index.root);
    if (!file) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(index), 'utf8');
    } catch { }
  }
}
