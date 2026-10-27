/*
 * Clipboard access for the webview.
 *
 * Extracted from MessageActions so the transcript's per-code-block copy button
 * uses the same path: a webview may deny `navigator.clipboard`, and the
 * document-command fallback (which must restore focus and the selection) is the
 * part worth having in one place rather than twice.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* A webview may deny clipboard access; try its document command. */ }

  const previousFocus = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.tabIndex = -1;
  field.setAttribute("aria-hidden", "true");
  Object.assign(field.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
  try {
    document.body.appendChild(field);
    field.focus({ preventScroll: true });
    field.select();
    return document.execCommand?.("copy") === true;
  } catch {
    return false;
  } finally {
    field.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
