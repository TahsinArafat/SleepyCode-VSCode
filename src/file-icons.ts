/*
 * Resolve a file name to the icon the user's active file-icon theme would show.
 *
 * Ported from OpenCursor (`src/ui/fileIcons.ts`, MIT, © Pawan Osman) because it
 * already implements the matching precedence VS Code itself uses and there is no
 * public API for this: the icon theme is a JSON file inside some extension, so
 * the only way to answer is to read it.
 *
 * Adapted for SleepyCode: assets are size-capped before being inlined, because a
 * data URI is sent over the webview message channel and an icon font can be
 * hundreds of kilobytes.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Icon resolved from the user's active file-icon theme, ready for a webview. */
export type FileIconInfo =
  | { kind: 'img'; src: string }
  | { kind: 'font'; fontFamily: string; src: string; format: string; char: string; color?: string; size?: string };

/**
 * Largest asset that will be inlined. A font bigger than this is skipped: the
 * icon is cosmetic, and the cost is paid on every message the webview receives.
 */
const MAX_ASSET_BYTES = 512 * 1024;

let cached: { themeId: string; themeDir: string; theme: any } | null | undefined;

function loadTheme(): { themeDir: string; theme: any } | null {
  const themeId = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme') || '';
  if (cached !== undefined && cached?.themeId === themeId) return cached;
  cached = null;
  if (!themeId) return null;
  for (const ext of vscode.extensions.all) {
    const contributes = ext.packageJSON?.contributes?.iconThemes;
    if (!Array.isArray(contributes)) continue;
    const entry = contributes.find((candidate: any) => candidate?.id === themeId);
    if (!entry) continue;
    try {
      const file = path.join(ext.extensionPath, entry.path);
      // Theme JSON may carry line comments and trailing commas.
      const raw = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      cached = { themeId, themeDir: path.dirname(file), theme: JSON.parse(raw) };
    } catch {
      cached = null;
    }
    break;
  }
  return cached;
}

/** Drop the caches when the icon theme setting changes. */
export function invalidateFileIconCache(): void {
  cached = undefined;
  resolved.clear();
  langMaps = undefined;
  dataUris.clear();
}

// filename/extension -> languageId, built from every extension's
// contributes.languages. This is how the IDE itself matches a file to a language.
let langMaps: { byFilename: Map<string, string>; byExt: Map<string, string> } | undefined;

function getLangMaps() {
  if (langMaps) return langMaps;
  const byFilename = new Map<string, string>();
  const byExt = new Map<string, string>();
  for (const ext of vscode.extensions.all) {
    const langs = ext.packageJSON?.contributes?.languages;
    if (!Array.isArray(langs)) continue;
    for (const language of langs) {
      if (!language?.id) continue;
      for (const filename of language.filenames || []) {
        if (!byFilename.has(String(filename).toLowerCase())) byFilename.set(String(filename).toLowerCase(), language.id);
      }
      for (const extension of language.extensions || []) {
        const key = String(extension).toLowerCase().replace(/^\./, '');
        if (!byExt.has(key)) byExt.set(key, language.id);
      }
    }
  }
  langMaps = { byFilename, byExt };
  return langMaps;
}

function languageIdFor(name: string): string | undefined {
  const { byFilename, byExt } = getLangMaps();
  const direct = byFilename.get(name);
  if (direct) return direct;
  // Longest-suffix match: "a.d.ts" -> "d.ts" -> "ts".
  const parts = name.split('.');
  for (let i = 1; i < parts.length; i++) {
    const language = byExt.get(parts.slice(i).join('.'));
    if (language) return language;
  }
  return undefined;
}

const dataUris = new Map<string, string | undefined>();

function toDataUri(absolute: string): string | undefined {
  if (dataUris.has(absolute)) return dataUris.get(absolute);
  let uri: string | undefined;
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_ASSET_BYTES) {
      uri = undefined;
    } else {
      const mime: Record<string, string> = {
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
      };
      const type = mime[path.extname(absolute).toLowerCase()] || 'application/octet-stream';
      uri = `data:${type};base64,${fs.readFileSync(absolute).toString('base64')}`;
    }
  } catch {
    uri = undefined;
  }
  dataUris.set(absolute, uri);
  return uri;
}

const resolved = new Map<string, FileIconInfo | undefined>();

/** Resolve a file name to its icon in the active theme, or `undefined`. */
export function resolveFileIcon(filename: string): FileIconInfo | undefined {
  const key = (filename || '').toLowerCase();
  if (!key) return undefined;
  if (resolved.has(key)) return resolved.get(key);
  const info = doResolve(key);
  resolved.set(key, info);
  return info;
}

function doResolve(name: string): FileIconInfo | undefined {
  const current = loadTheme();
  if (!current) return undefined;
  const { theme, themeDir } = current;

  // Match VS Code's own precedence: fileNames, then fileExtensions (longest
  // suffix first), then languageIds, then the generic file icon.
  let defId: string | undefined = theme.fileNames?.[name];
  if (!defId) {
    const parts = name.split('.');
    for (let i = 1; i < parts.length && !defId; i++) defId = theme.fileExtensions?.[parts.slice(i).join('.')];
  }
  if (!defId) {
    const language = languageIdFor(name);
    if (language) defId = theme.languageIds?.[language];
  }
  if (!defId) defId = theme.file;
  const def = defId ? theme.iconDefinitions?.[defId] : undefined;
  if (!def) return undefined;

  if (def.iconPath) {
    const src = toDataUri(path.resolve(themeDir, def.iconPath));
    return src ? { kind: 'img', src } : undefined;
  }
  if (def.fontCharacter) {
    const fonts: any[] = theme.fonts || [];
    const font = fonts.find((candidate) => candidate?.id === def.fontId) || fonts[0];
    const source = font?.src?.[0];
    const src = source ? toDataUri(path.resolve(themeDir, source.path)) : undefined;
    if (!src) return undefined;
    return {
      kind: 'font',
      fontFamily: font.id,
      src,
      format: source.format || 'woff',
      char: def.fontCharacter,
      color: def.fontColor,
      size: def.fontSize || font.size,
    };
  }
  return undefined;
}