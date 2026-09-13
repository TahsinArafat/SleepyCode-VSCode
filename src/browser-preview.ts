import * as vscode from 'vscode';

/**
 * Live browser preview as a regular editor-area webview tab (ViewColumn.Beside),
 * instead of a floating card inside the chat webview. One panel is reused for
 * the whole extension session; it is created lazily on the first capture.
 */
export class BrowserPreviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private lastDataUrl: string | null = null;
  private lastCursor: { x: number; y: number } | undefined;

  update(dataUrl: string | null, cursor?: { x: number; y: number }): void {
    this.lastDataUrl = dataUrl;
    this.lastCursor = cursor;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'sleepycode.browserPreview',
        'Browser Preview',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.webview.html = this.html();
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      // The webview script signals readiness once loaded; a message posted before
      // that (the very first capture) would otherwise be silently dropped.
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'panelReady' && this.panel) {
          void this.panel.webview.postMessage({ type: 'preview', dataUrl: this.lastDataUrl, cursor: this.lastCursor });
        }
      });
      // Focus the new tab so the user notices it, but never steal focus on later captures.
      this.panel.reveal();
    } else {
      this.panel.reveal(undefined, true);
    }
    void this.panel.webview.postMessage({ type: 'preview', dataUrl, cursor });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background,#1e1e1e)}
  body{display:flex;flex-direction:column;color:var(--vscode-foreground,#cccccc);font:12px var(--vscode-font-family)}
  #bar{flex:none;display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--vscode-panel-border,#333);background:var(--vscode-editorWidget-background,#252526)}
  #dot{width:8px;height:8px;border-radius:50%;background:var(--vscode-testing-iconPassed,#22c55e);flex:none}
  #dot.idle{background:var(--vscode-descriptionForeground,#9d9d9d)}
  #stage-wrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:16px}
  #stage{position:relative;display:inline-block}
  #shot{display:block;max-width:calc(100vw - 40px);max-height:calc(100vh - 90px)}
  #cursor{position:absolute;width:14px;height:14px;transform:translate(-50%,-50%);border:2px solid var(--vscode-focusBorder,#007fd4);border-radius:50%;background:rgba(0,0,0,.18);box-shadow:0 0 0 2px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .12s ease}
  #cursor.on{opacity:1}
  #empty{color:var(--vscode-descriptionForeground,#9d9d9d)}
</style></head><body>
  <div id="bar"><span id="dot" class="idle"></span><span id="title">No browser session</span></div>
  <div id="stage-wrap"><span id="empty">No browser session. The preview appears here when the agent drives a browser.</span><div id="stage" hidden><img id="shot" alt="browser preview"><span id="cursor"></span></div></div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const dot = document.getElementById('dot'), title = document.getElementById('title'),
          emptyEl = document.getElementById('empty'), stage = document.getElementById('stage'),
          shot = document.getElementById('shot'), cursor = document.getElementById('cursor');
    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || m.type !== 'preview') return;
      const has = Boolean(m.dataUrl);
      emptyEl.hidden = has;
      stage.hidden = !has;
      dot.classList.toggle('idle', !has);
      title.textContent = has ? 'Live browser preview' : 'Browser session closed';
      if (has) shot.src = m.dataUrl;
      if (m.cursor) {
        cursor.style.left = (m.cursor.x * 100) + '%';
        cursor.style.top = (m.cursor.y * 100) + '%';
        cursor.classList.add('on');
      } else {
        cursor.classList.remove('on');
      }
    });
    vscodeApi.postMessage({ type: 'panelReady' });
  </script>
</body></html>`;
  }
}
