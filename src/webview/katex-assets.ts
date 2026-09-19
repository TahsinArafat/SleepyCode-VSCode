import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * KaTeX is shipped as static assets under `media/katex` (populated at build time
 * by `scripts/copy-katex-assets.mjs`). We inline the stylesheet and runtime into
 * the webview so the strict Content-Security-Policy stays narrow, and rewrite the
 * font URLs to webview URIs so custom web fonts load inside the sandbox.
 */
export interface KatexAssets {
  /** Inline stylesheet with font URLs rewritten to webview resource URIs. */
  css: string;
  /** Raw minified KaTeX runtime, injected into the nonce'd script. */
  js: string;
}

function readAsset(extensionUri: vscode.Uri, ...segments: string[]): string | undefined {
  const file = vscode.Uri.joinPath(extensionUri, ...segments).fsPath;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function loadKatexAssets(webview: vscode.Webview, extensionUri: vscode.Uri): KatexAssets | undefined {
  const css = readAsset(extensionUri, 'media', 'katex', 'katex.min.css');
  const js = readAsset(extensionUri, 'media', 'katex', 'katex.min.js');
  if (!css || !js) return undefined;

  // Rewrite `url(fonts/...)` references to hashed webview URIs.
  const rewritten = css.replace(/url\(([^)]*?fonts\/[^)]+)\)/g, (match, ref: string) => {
    const cleaned = ref.trim().replace(/^["']|["']$/g, '');
    const fileName = path.posix.basename(cleaned);
    try {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'katex', 'fonts', fileName));
      return `url("${uri.toString()}")`;
    } catch {
      return match;
    }
  });

  return { css: rewritten, js };
}
