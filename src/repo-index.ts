import { readFileSync, existsSync, mkdirSync, writeFileSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';

export interface FileEntry {
  path: string;
  content: string;
}

export interface SymbolEntry {
  name: string;
  kind: string;
  line: number;
  path: string;
}

export interface ArchNode {
  id: string;
  label: string;
  kind: 'file' | 'package';
}

export interface ArchEdge {
  from: string;
  to: string;
  kind: string;
}

export interface ArchitectureMap {
  nodes: ArchNode[];
  edges: ArchEdge[];
}

export const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.sleepycode',
  '.worktrees',
  'coverage',
  '.next',
  '.turbo',
  'vendor',
  '.venv',
  'venv',
  'target',
  '.cache',
  '.nuxt',
  '.svelte-kit',
  '.gradle',
  '.pytest_cache',
  '.mypy_cache',
  'Pods',
  '.codegraph',
  '.witdiff',
  '.ui-shots',
  '__pycache__',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svgz', '.bmp', '.tiff', '.avif',
  '.pdf', '.zip', '.gz', '.bz2', '.xz', '.tar', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.mp3', '.wav', '.ogg', '.flac', '.mov', '.avi', '.webm',
  '.sqlite', '.sqlite3', '.db', '.wal', '.shm',
  '.wasm', '.node', '.so', '.dylib', '.dll', '.exe', '.bin', '.vsix', '.lockb', '.parquet',
  '.pyc', '.pyo', '.class', '.jar', '.o', '.a', '.map',
]);

export function isBinaryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const ext = path.posix.extname(normalized);
  return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

export function isIgnoredRelativePath(relativePath: string, ignore: Set<string> = DEFAULT_IGNORE): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] && ignore.has(parts[i]!)) return true;
  }
  return false;
}

export function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface ManifestEntry {
  path: string;
  size: number;
  mtime: number;
  hash: string;
}

export function buildManifest(entries: FileEntry[]): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    map.set(entry.path, { path: entry.path, size: entry.content.length, mtime: 0, hash: hashContent(entry.content) });
  }
  return map;
}

export interface ManifestDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

export function diffManifest(prev: Map<string, ManifestEntry>, next: Map<string, ManifestEntry>): ManifestDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const [p, e] of next) {
    const before = prev.get(p);
    if (!before) added.push(p);
    else if (before.hash !== e.hash) changed.push(p);
    else unchanged.push(p);
  }
  for (const p of prev.keys()) if (!next.has(p)) removed.push(p);
  return { added, changed, removed, unchanged };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'this', 'that', 'it', 'as', 'be', 'by', 'from', 'at', 'we', 'you', 'i', 'if', 'else', 'then', 'do', 'not', 'no', 'yes', 'function', 'const', 'let', 'var', 'return', 'import', 'export', 'class', 'interface', 'type',
]);

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.replace(/[^A-Za-z0-9_$]+/g, ' ').split(/\s+/).filter(Boolean)) {
    // Split camelCase / PascalCase and snake_case so `authenticateCredentials`
    // also yields `authenticate` and `credentials`, improving recall.
    for (const part of word.split(/_+/).filter(Boolean)) {
      const camel = part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/\s+/);
      for (const piece of camel) {
        if (piece.length > 1 && !STOPWORDS.has(piece)) tokens.push(piece);
      }
    }
  }
  return tokens;
}

const SYMBOL_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'function', re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'const', re: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g },
  { kind: 'let', re: /(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=/g },
  { kind: 'class', re: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'interface', re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'type', re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g },
  { kind: 'function', re: /(?:public\s+|private\s+|pub\s+)?fn\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'function', re: /\bdef\s+([A-Za-z_$][\w$]*)\s*\(/g },
];

export function extractSymbols(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  let lineStarts: number[] | undefined;
  const lineOf = (offset: number): number => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = 0; i < content.length; i += 1) {
        if (content.charCodeAt(i) === 10) lineStarts.push(i + 1);
      }
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    return lo;
  };
  for (const pattern of SYMBOL_PATTERNS) {
    const re = new RegExp(pattern.re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const name = m[1];
      if (!name) continue;
      symbols.push({ name, kind: pattern.kind, line: lineOf(m.index), path: filePath });
    }
  }
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.path}:${s.line}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const IMPORT_PATTERNS: RegExp[] = [
  /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
];

export function extractImports(content: string): string[] {
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) out.push(m[1] ?? '');
  }
  return out;
}

function resolveImport(importer: string, spec: string, files: Map<string, boolean>): string | undefined {
  if (!spec.startsWith('.')) {
    const first = spec.split('/')[0] ?? spec;
    return `package:${first}`;
  }
  const dir = path.posix.dirname(importer);
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.json`, path.posix.join(base, 'index.ts'), path.posix.join(base, 'index.js')];
  for (const candidate of candidates) if (files.has(candidate)) return candidate;
  return undefined;
}

export class RepoIndex {
  private entries: FileEntry[] = [];
  private indexByPath = new Map<string, number>();
  private termIndex = new Map<string, Map<string, number>>();
  private symbols: SymbolEntry[] = [];
  private docFrequency = new Map<string, number>();
  private totalDocs = 0;
  /**
   * Set when `entries` changes, so `indexSymbols` knows its result is stale.
   *
   * Extracting symbols over a whole workspace is expensive enough to matter: measured on
   * 4,000 files it costs ~3.8 SECONDS and retains ~120 MB. It used to run on every
   * `repo_symbol` tool call and every index-panel open (`tools.ts`, `agent.ts`), rebuilding
   * the whole array each time. Memoizing makes a repeat call free; the flag makes a stale
   * call correct rather than fast-and-wrong.
   */
  private symbolsStale = true;

  constructor(entries: FileEntry[] = []) {
    this.ingest(entries);
  }

  ingest(entries: FileEntry[]): void {
    for (const entry of entries) {
      if (entry.content.includes('\u0000')) continue;
      const existingIdx = this.indexByPath.get(entry.path);
      if (existingIdx !== undefined) {
        this.entries[existingIdx] = entry;
      } else {
        this.indexByPath.set(entry.path, this.entries.length);
        this.entries.push(entry);
      }
    }
    this.symbolsStale = true;
  }

  upsert(entry: FileEntry): void {
    if (entry.content.includes('\u0000')) {
      this.remove(entry.path);
      return;
    }
    const existingIdx = this.indexByPath.get(entry.path);
    if (existingIdx !== undefined) {
      this.entries[existingIdx] = entry;
    } else {
      this.indexByPath.set(entry.path, this.entries.length);
      this.entries.push(entry);
    }
    this.invalidateDerived();
  }

  remove(filePath: string): void {
    const at = this.indexByPath.get(filePath);
    if (at !== undefined) {
      this.entries.splice(at, 1);
      this.indexByPath.delete(filePath);
      for (let i = at; i < this.entries.length; i += 1) {
        this.indexByPath.set(this.entries[i]!.path, i);
      }
    }
    this.invalidateDerived();
  }

  /**
   * Drop the indices derived from `entries`.
   *
   * These are rebuilt lazily rather than eagerly: an edit invalidates the symbol and term
   * indices, but nothing rebuilds them until a search actually needs them. Clearing only,
   * with no rebuild, is what keeps a single file save cheap.
   */
  private invalidateDerived(): void {
    this.symbols = [];
    this.symbolsStale = true;
    this.termIndex.clear();
    this.docFrequency.clear();
    this.totalDocs = 0;
  }

  get files(): FileEntry[] {
    return this.entries;
  }

  indexSymbols(): SymbolEntry[] {
    if (!this.symbolsStale) return this.symbols;
    this.symbols = [];
    for (const entry of this.entries) this.symbols.push(...extractSymbols(entry.content, entry.path));
    this.symbolsStale = false;
    return this.symbols;
  }

  /** Number of symbols, without materializing the index just to count them. */
  symbolCount(): number {
    return this.indexSymbols().length;
  }

  symbolSearch(query: string, topK = 25): SymbolEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    if (this.symbolsStale) this.indexSymbols();
    return this.symbols
      .map((s) => ({ s, score: this.symbolScore(s, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.s);
  }

  private symbolScore(s: SymbolEntry, q: string): number {
    const name = s.name.toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    else if (name.startsWith(q)) score += 60;
    else if (name.includes(q)) score += 30;
    if (score > 0 && (s.kind === 'function' || s.kind === 'class')) score += 5;
    return score;
  }

  indexSemantic(): void {
    this.termIndex.clear();
    this.docFrequency.clear();
    this.totalDocs = this.entries.length;
    for (const entry of this.entries) {
      const tf = new Map<string, number>();
      for (const token of tokenize(entry.content)) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const [term, count] of tf) {
        let postings = this.termIndex.get(term);
        if (!postings) {
          postings = new Map<string, number>();
          this.termIndex.set(term, postings);
        }
        postings.set(entry.path, count);
      }
      for (const term of tf.keys()) this.docFrequency.set(term, (this.docFrequency.get(term) ?? 0) + 1);
    }
  }

  semanticSearch(query: string, topK = 10): { path: string; score: number; snippet: string }[] {
    if (!this.termIndex.size) this.indexSemantic();
    const queryTerms = tokenize(query);
    if (!queryTerms.length) return [];
    const scores = new Map<string, number>();
    for (const term of queryTerms) {
      const postings = this.termIndex.get(term);
      if (!postings) continue;
      const idf = Math.log((this.totalDocs + 1) / ((this.docFrequency.get(term) ?? 0) + 1));
      for (const [filePath, tf] of postings) scores.set(filePath, (scores.get(filePath) ?? 0) + tf * idf);
    }
    return [...scores.entries()]
      .map(([filePath, score]) => ({ path: filePath, score: Number(score.toFixed(3)), snippet: this.snippetFor(filePath, queryTerms) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private snippetFor(filePath: string, terms: string[]): string {
    const idx = this.indexByPath.get(filePath);
    const content = idx === undefined ? '' : (this.entries[idx]?.content ?? '');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lower = (lines[i] ?? '').toLowerCase();
      if (terms.some((t) => lower.includes(t))) return lines.slice(Math.max(0, i - 1), i + 2).join(' / ').slice(0, 200);
    }
    return content.slice(0, 120);
  }

  architectureMap(): ArchitectureMap {
    const files = new Map<string, boolean>();
    for (const entry of this.entries) files.set(entry.path, true);
    const nodes = new Map<string, ArchNode>();
    const edges: ArchEdge[] = [];
    for (const entry of this.entries) {
      nodes.set(entry.path, { id: entry.path, label: path.basename(entry.path), kind: 'file' });
      for (const spec of extractImports(entry.content)) {
        const resolved = resolveImport(entry.path, spec, files);
        if (!resolved) continue;
        if (resolved.startsWith('package:')) {
          if (!nodes.has(resolved)) nodes.set(resolved, { id: resolved, label: resolved.slice('package:'.length), kind: 'package' });
          edges.push({ from: entry.path, to: resolved, kind: 'imports' });
        } else {
          edges.push({ from: entry.path, to: resolved, kind: 'imports' });
        }
      }
    }
    return { nodes: [...nodes.values()], edges };
  }
}

/** Upper bound on indexed files and total raw bytes read into memory. */
export const SCAN_MAX_FILES = 4_000;
export const SCAN_MAX_TOTAL_BYTES = 32_000_000;

/**
 * Reads the workspace into memory for indexing. Async on purpose: the previous synchronous
 * walk read the contents of every file on the extension host's only thread, so a large
 * workspace froze the whole editor — every window, not just this panel. Awaiting the fs
 * calls yields between files, and `maxFiles` bounds the worst case.
 */
export async function scanWorkspace(
  root: string,
  ignore: Set<string> = DEFAULT_IGNORE,
  maxBytes = 250_000,
  maxFiles = SCAN_MAX_FILES,
): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  let totalBytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (ignore.has(name)) continue;
      if (out.length >= maxFiles || totalBytes >= SCAN_MAX_TOTAL_BYTES) return;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fsp.lstat(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile() && stat.size <= maxBytes && !isBinaryPath(name) && totalBytes + stat.size <= SCAN_MAX_TOTAL_BYTES) {
        try {
          const buf = await fsp.readFile(full);
          if (buf.includes(0)) continue;
          totalBytes += stat.size;
          out.push({ path: path.relative(root, full), content: buf.toString('utf8') });
        } catch {}
      }
    }
  };
  if (existsSync(root)) await walk(root);
  return out;
}

export interface MemoryFact {
  id: string;
  text: string;
  source: string;
  line?: number;
  sourceHash?: string;
  valid: boolean;
  recordedAt: number;
}

export class SourceCitedMemory {
  private facts: MemoryFact[] = [];

  get all(): MemoryFact[] {
    return this.facts;
  }

  record(input: { text: string; source: string; line?: number; sourceHash?: string }): MemoryFact {
    const fact: MemoryFact = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: input.text,
      source: input.source,
      line: input.line,
      sourceHash: input.sourceHash,
      valid: true,
      recordedAt: Date.now(),
    };
    this.facts.push(fact);
    return fact;
  }

  invalidate(sources: { path: string; hash: string }[]): number {
    const byPath = new Map(sources.map((s) => [s.path, s.hash]));
    let invalidated = 0;
    for (const fact of this.facts) {
      const current = byPath.get(fact.source);
      if (fact.sourceHash && current !== fact.sourceHash) {
        if (fact.valid) invalidated++;
        fact.valid = false;
      }
    }
    return invalidated;
  }

  pruneInvalid(): number {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.valid);
    return before - this.facts.length;
  }

  toJSON(): string {
    return JSON.stringify(this.facts, null, 2);
  }

  load(json: string): void {
    try {
      const parsed = JSON.parse(json) as MemoryFact[];
      if (Array.isArray(parsed)) this.facts = parsed.filter((f) => f && typeof f.text === 'string' && typeof f.source === 'string');
    } catch {
      this.facts = [];
    }
  }
}

export function saveMemoryJson(root: string, json: string): void {
  const dir = path.join(root, '.sleepycode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'memory-index.json'), json, 'utf8');
}

export function loadMemoryJson(root: string): string | undefined {
  try {
    return readFileSync(path.join(root, '.sleepycode', 'memory-index.json'), 'utf8');
  } catch {
    return undefined;
  }
}
