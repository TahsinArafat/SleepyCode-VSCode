/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { readFileSync } from "node:fs";

function nonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * The KaTeX stylesheet, with its font URLs rewritten to webview URIs.
 *
 * `katex.min.css` references its fonts relatively (`url(fonts/...)`), which cannot resolve
 * from `dist/webview/`. The stylesheet is read and rewritten here rather than imported by the
 * bundler so the font URLs can become `asWebviewUri` results, which is the only form the
 * sandboxed webview will load.
 *
 * Returns undefined when the assets are missing, so a build that has not run
 * `copy-katex-assets` degrades to unstyled math instead of a broken panel.
 */
function katexStyleSheet(webview: vscode.Webview, extensionUri: vscode.Uri): string | undefined {
  const cssPath = vscode.Uri.joinPath(extensionUri, "media", "katex", "katex.min.css");
  let css: string;
  try {
    css = readFileSync(cssPath.fsPath, "utf8");
  } catch {
    return undefined;
  }
  return css.replace(/url\(([^)]*?fonts\/[^)]+)\)/g, (match, ref: string) => {
    const cleaned = ref.trim().replace(/^["']|["']$/g, "");
    const fileName = cleaned.split("/").pop() ?? "";
    try {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "katex", "fonts", fileName));
      return `url("${uri.toString()}")`;
    } catch {
      return match;
    }
  });
}

/** Thin HTML shell that loads a bundled React webview (dist/webview/<entry>.js/.css). */
export function renderReactWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  entry: "sidebar" | "settings",
  title: string
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", `${entry}.js`)
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", `${entry}.css`)
  );
  const iconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "icon.png")
  );
  // Only the chat renders math, so only the chat pays for the stylesheet.
  const katexCss = entry === "sidebar" ? katexStyleSheet(webview, extensionUri) : undefined;
  const n = nonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `font-src ${webview.cspSource} data:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  ${katexCss ? `<style>${katexCss}</style>` : ""}
  <title>${title}</title>
</head>
<body>
  <div id="root" data-icon="${iconUri}"></div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
