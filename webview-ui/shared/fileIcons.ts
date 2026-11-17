import type { FileIconInfo } from "../sidebar/types";
import { vscode } from "./vscode";

const iconCache = new Map<string, FileIconInfo | null>();
const pendingRequests = new Set<string>();
const subscribers = new Map<string, Set<(icon: FileIconInfo | null) => void>>();
const loadedFonts = new Set<string>();
let fontStyleEl: HTMLStyleElement | null = null;
let listenerAttached = false;

function ensureFontFace(icon: Extract<FileIconInfo, { kind: "font" }>): void {
  if (!icon.src || loadedFonts.has(icon.fontFamily)) return;
  loadedFonts.add(icon.fontFamily);
  if (!fontStyleEl || !fontStyleEl.isConnected) {
    fontStyleEl = document.createElement("style");
    fontStyleEl.dataset.sleepycodeFileIcons = "1";
    document.head.appendChild(fontStyleEl);
  }
  fontStyleEl.textContent += `@font-face { font-family: "${icon.fontFamily}"; src: url("${icon.src}") format("${icon.format}"); }\n`;
}

function ensureMessageListener(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data;
    if (msg?.type !== "fileIcon") return;
    const filename = String(msg.filename || "").toLowerCase();
    const icon: FileIconInfo | null = msg.icon || null;
    pendingRequests.delete(filename);
    iconCache.set(filename, icon);
    if (icon?.kind === "font") ensureFontFace(icon);
    const callbacks = subscribers.get(filename);
    if (!callbacks) return;
    subscribers.delete(filename);
    for (const callback of callbacks) callback(icon);
  });
}

/** Decode a literal glyph or CSS escape such as "\\E001" into a single character. */
export function decodeFontChar(ch: string): string {
  const match = ch.match(/^\\+([0-9a-fA-F]{4,6})$/);
  return match ? String.fromCodePoint(parseInt(match[1], 16)) : ch;
}

/** Synchronously read a resolved icon from the shared cache if present. */
export function getCachedFileIcon(filename: string): FileIconInfo | null | undefined {
  return iconCache.get(filename.toLowerCase());
}

/** Subscribe once to a normalized lowercase filename, requesting from the host when uncached. */
export function subscribeFileIcon(filename: string, onResolved: (icon: FileIconInfo | null) => void): () => void {
  const key = filename.toLowerCase();
  if (!key) {
    onResolved(null);
    return () => {};
  }
  ensureMessageListener();
  if (iconCache.has(key)) {
    onResolved(iconCache.get(key) ?? null);
    return () => {};
  }
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(onResolved);
  if (!pendingRequests.has(key)) {
    pendingRequests.add(key);
    vscode.postMessage({ type: "getFileIcon", filename: key });
  }
  return () => {
    const active = subscribers.get(key);
    if (!active) return;
    active.delete(onResolved);
    if (active.size === 0) subscribers.delete(key);
  };
}
