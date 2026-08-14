export type IndexedProjectFile = {
  path: string;
  language: string;
  size: number;
  symbols: string[];
  imports: string[];
  testLike: boolean;
};

export type ProjectLanguageStat = { language: string; files: number };

export type ProjectIntelligence = {
  version: 1;
  root: string;
  generatedAt: number;
  fileCount: number;
  indexedFileCount: number;
  languages: ProjectLanguageStat[];
  frameworks: string[];
  importantFiles: string[];
  files: IndexedProjectFile[];
};

export type ProjectContextHit = {
  path: string;
  score: number;
  symbols: string[];
  reasons: string[];
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', php: 'PHP', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  go: 'Go', rs: 'Rust', swift: 'Swift', cs: 'C#', cpp: 'C++', cc: 'C++', cxx: 'C++', c: 'C', h: 'C/C++', hpp: 'C++',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
  json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', md: 'Markdown', mdx: 'MDX',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL',
};

const IMPORTANT_NAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'pyproject.toml', 'requirements.txt', 'poetry.lock', 'uv.lock',
  'go.mod', 'cargo.toml', 'gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'settings.gradle',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'readme.md', 'readme', 'vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs', 'next.config.ts',
  'nuxt.config.ts', 'astro.config.mjs', 'svelte.config.js', 'webpack.config.js', 'vitest.config.ts', 'jest.config.js',
]);

const STOP_WORDS = new Set([
  'the','a','an','and','or','to','of','for','in','on','with','from','into','this','that','it','is','are','be','as','at','by',
  'fix','build','add','update','change','implement','review','debug','please','code','project','app','feature','issue','bug','make',
]);

function extOf(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function languageForPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() ?? normalized;
  if (name === 'dockerfile') return 'Dockerfile';
  return LANGUAGE_BY_EXTENSION[extOf(normalized)] ?? '';
}

export function isIndexableProjectFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() ?? normalized;
  if (IMPORTANT_NAMES.has(name)) return true;
  return Boolean(languageForPath(normalized));
}

export function isImportantProjectFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() ?? normalized;
  return IMPORTANT_NAMES.has(name)
    || /(?:^|\/)(?:src\/)?(?:index|main|app|server|extension|routes?)\.(?:ts|tsx|js|jsx|py|go|rs)$/.test(normalized);
}

function pushUnique(target: string[], value: string, max: number): void {
  const clean = value.trim();
  if (!clean || target.includes(clean) || target.length >= max) return;
  target.push(clean);
}

export function extractSymbols(source: string, language: string): string[] {
  if (!source || !language) return [];
  const symbols: string[] = [];
  const patterns: RegExp[] = [];
  if (language === 'TypeScript' || language === 'JavaScript' || language === 'Vue' || language === 'Svelte' || language === 'Astro') {
    patterns.push(
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
      /\b(?:export\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
      /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    );
  } else if (language === 'Python') {
    patterns.push(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm);
  } else if (language === 'Go') {
    patterns.push(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^\s*type\s+([A-Za-z_]\w*)\s+/gm);
  } else if (language === 'Rust') {
    patterns.push(/\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g, /\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g);
  } else if (language === 'Java' || language === 'Kotlin' || language === 'C#' || language === 'C++' || language === 'C') {
    patterns.push(/\b(?:class|interface|struct|enum)\s+([A-Za-z_]\w*)/g);
  }
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) && symbols.length < 48) {
      if (match[1]) pushUnique(symbols, match[1], 48);
    }
  }
  return symbols;
}

export function extractImports(source: string, language: string): string[] {
  if (!source || !language) return [];
  const imports: string[] = [];
  const collect = (pattern: RegExp) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) && imports.length < 48) {
      if (match[1]) pushUnique(imports, match[1], 48);
    }
  };
  if (['TypeScript','JavaScript','Vue','Svelte','Astro'].includes(language)) {
    collect(/\b(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/g);
    collect(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    collect(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  } else if (language === 'Python') {
    collect(/^\s*from\s+([\w.]+)\s+import\s+/gm);
    collect(/^\s*import\s+([\w.]+)/gm);
  } else if (language === 'Go') {
    collect(/(?:^|\n)\s*import\s+(?:\w+\s+)?"([^"]+)"/g);
    const block = /(?:^|\n)\s*import\s*\(([^)]*)\)/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = block.exec(source)) && imports.length < 48) {
      const body = blockMatch[1] ?? '';
      let m: RegExpExecArray | null;
      const quoted = /"([^"]+)"/g;
      while ((m = quoted.exec(body)) && imports.length < 48) if (m[1]) pushUnique(imports, m[1], 48);
    }
  } else if (language === 'Rust') {
    collect(/^\s*use\s+([^;]+);/gm);
  }
  return imports;
}

export function detectFrameworks(packageJson: unknown): string[] {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) return [];
  const pkg = packageJson as Record<string, unknown>;
  const dependencies = {
    ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies as Record<string, unknown> : {}),
    ...(pkg.devDependencies && typeof pkg.devDependencies === 'object' ? pkg.devDependencies as Record<string, unknown> : {}),
  };
  const names = new Set(Object.keys(dependencies));
  const frameworks: string[] = [];
  const add = (dependency: string, label: string) => { if (names.has(dependency) && !frameworks.includes(label)) frameworks.push(label); };
  add('next', 'Next.js'); add('react', 'React'); add('vue', 'Vue'); add('nuxt', 'Nuxt'); add('svelte', 'Svelte'); add('@sveltejs/kit', 'SvelteKit');
  add('astro', 'Astro'); add('express', 'Express'); add('fastify', 'Fastify'); add('@nestjs/core', 'NestJS'); add('hono', 'Hono');
  add('electron', 'Electron'); add('vite', 'Vite'); add('vitest', 'Vitest'); add('jest', 'Jest'); add('playwright', 'Playwright');
  add('@playwright/test', 'Playwright'); add('cypress', 'Cypress'); add('typescript', 'TypeScript'); add('prisma', 'Prisma'); add('@prisma/client', 'Prisma');
  return frameworks;
}

export function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[a-z0-9_.$/-]{2,}/g) ?? [];
  return [...new Set(terms.flatMap(term => term.split(/[/.\-]+/)).filter(term => term.length >= 2 && !STOP_WORDS.has(term)))].slice(0, 24);
}

function tokenMatch(haystack: string, term: string): boolean {
  return haystack.includes(term);
}

export function retrieveProjectContext(index: ProjectIntelligence, query: string, limit = 10): ProjectContextHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return index.files.filter(file => isImportantProjectFile(file.path)).slice(0, limit).map(file => ({ path: file.path, score: 1, symbols: file.symbols.slice(0, 8), reasons: ['important project file'] }));
  const scored: ProjectContextHit[] = [];
  for (const file of index.files) {
    const lowerPath = file.path.toLowerCase();
    const base = lowerPath.split('/').pop() ?? lowerPath;
    const symbols = file.symbols.map(symbol => symbol.toLowerCase());
    const imports = file.imports.map(specifier => specifier.toLowerCase());
    let score = 0;
    const reasons: string[] = [];
    for (const term of terms) {
      if (tokenMatch(base, term)) { score += 8; reasons.push(`filename:${term}`); }
      else if (tokenMatch(lowerPath, term)) { score += 4; reasons.push(`path:${term}`); }
      if (symbols.some(symbol => tokenMatch(symbol, term))) { score += 7; reasons.push(`symbol:${term}`); }
      if (imports.some(specifier => tokenMatch(specifier, term))) { score += 2; reasons.push(`import:${term}`); }
    }
    if (file.testLike && terms.some(term => ['test','spec','verify','regression'].includes(term))) score += 6;
    if (isImportantProjectFile(file.path)) score += 0.5;
    if (score > 0) scored.push({ path: file.path, score, symbols: file.symbols.slice(0, 10), reasons: [...new Set(reasons)].slice(0, 4) });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.max(1, limit));
}

export function summarizeProjectIndex(index: ProjectIntelligence): string {
  const language = index.languages.slice(0, 3).map(item => `${item.language} (${item.files})`).join(', ');
  const frameworks = index.frameworks.slice(0, 6).join(', ');
  return `${index.indexedFileCount} indexed files${language ? ` · ${language}` : ''}${frameworks ? ` · ${frameworks}` : ''}`;
}
