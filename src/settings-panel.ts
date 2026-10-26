/**
 * The OpenCursor settings window, hosted by SleepyCode.
 *
 * The React settings bundle was already being built into `dist/webview/settings.*`
 * but had no host, so the only reachable settings surface was VS Code's own
 * settings page — which the MCP page needs to replace, since MCP servers are
 * structured data (name, transport, command/url, env, enabled) rather than a
 * single string setting.
 *
 * Everything the window needs from the extension goes through `SettingsPanelHost`
 * so this module holds no `vscode` logic of its own and the translations stay in
 * `src/settings-adapter.ts`.
 */

import * as vscode from 'vscode';
import { renderReactWebviewHtml } from './webview-react';
import {
  fromPanelSettings,
  isPanelMessage,
  toPanelFeatures,
  toPanelSettings,
  toPanelUsage,
  type PanelMcpConfig,
  type PanelMcpStatus,
  type StoredSettings,
} from './settings-adapter';

/** What the settings window can ask the extension to do. */
export interface SettingsPanelHost {
  readSettings(): StoredSettings;
  writeSettings(patch: StoredSettings): Promise<void>;
  /** Stored MCP servers, in the panel's config shape. */
  readConnections(): Promise<PanelMcpConfig[]>;
  /** Replace the stored MCP servers with what the panel now shows. */
  writeConnections(connections: PanelMcpConfig[]): Promise<void>;
  /** Connect every server and report exactly one status row per stored server. */
  syncConnections(): Promise<PanelMcpStatus[]>;
  /** Sign in / out of a remote MCP server. */
  mcpLogin(name: string): Promise<void>;
  mcpLogout(name: string): Promise<void>;
  usage(): unknown;
  /** Refresh the provider catalog and return the model ids for the picker. */
  refreshModels(): Promise<string[]>;
  /** Report a panel-level event to the extension log. */
  log(level: 'info' | 'warn' | 'error', event: string, detail?: string): void;
  /** Installed skills, for the Rules & Skills section. */
  skills(): Promise<readonly { name: string; description?: string; skillMdPath?: string }[]>;
  /** Whether the project memory file exists, so it can be listed as a rule. */
  memory(): { memoryPath: string; memoryExists: boolean };
}

export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, private readonly host: SettingsPanelHost) {
    this.panel = panel;
  }

  /** Open the settings window, revealing the existing one if it is already up. */
  static show(context: vscode.ExtensionContext, host: SettingsPanelHost, section?: string): SettingsPanel {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      void SettingsPanel.current.pushAll();
      if (section) SettingsPanel.current.post({ type: 'navigate', section });
      return SettingsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'sleepycode.settingsWindow',
      'SleepyCode Settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
    );
    const instance = new SettingsPanel(panel, host);
    SettingsPanel.current = instance;
    // The message handler MUST be registered before the HTML is set. The app
    // posts `getSettings`/`getFeatures`/`getUsage` the moment it mounts, and a
    // handler registered afterwards misses those first messages — which left the
    // window rendering defaults with an empty MCP list, while later messages
    // (adding a server) still worked and so looked fine.
    panel.webview.onDidReceiveMessage((message) => { void instance.onMessage(message); });
    panel.onDidDispose(() => {
      instance.disposed = true;
      if (SettingsPanel.current === instance) SettingsPanel.current = undefined;
    });
    panel.webview.html = renderReactWebviewHtml(panel.webview, context.extensionUri, 'settings', 'SleepyCode Settings');
    // Posted after the HTML is set: the app only starts listening on mount, so
    // an earlier navigate would be lost.
    if (section) setTimeout(() => instance.post({ type: 'navigate', section }), 150);
    return instance;
  }

  private post(message: unknown): void {
    if (this.disposed) return;
    // `postMessage` rejects when the webview is gone; ignoring it loses the
    // message silently, which looks identical to the panel choosing not to
    // render it.
    Promise.resolve(this.panel.webview.postMessage(message)).catch((error) => {
      this.host.log('warn', 'settings.post.failed', `${(message as { type?: string })?.type}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Everything the window asks for on load, and after any change. */
  private async pushAll(): Promise<void> {
    this.post({ type: 'loadSettings', settings: toPanelSettings(this.host.readSettings()) });
    this.post({ type: 'usageData', usage: toPanelUsage(this.host.usage()) });
    // Paint the stored servers immediately (so the list is never blank), then
    // sync. Without the sync every row rendered as bare "idle" until the user
    // happened to press Sync, which reads as "nothing was checked".
    await this.pushFeatures();
    await this.pushFeatures(await this.safeSync());
    const models = await this.host.refreshModels().catch(() => []);
    this.post({ type: 'modelsFetched', models });
  }

  private async pushFeatures(statuses?: PanelMcpStatus[]): Promise<void> {
    // A swallowed read failure here empties the list in the window, which is
    // indistinguishable from "you have no servers" — so it is reported, not
    // hidden.
    let connections: PanelMcpConfig[] = [];
    try {
      connections = await this.host.readConnections();
    } catch (error) {
      this.host.log('error', 'settings.readConnections.failed', error instanceof Error ? error.message : String(error));
    }
    const extras = { skills: await this.host.skills().catch(() => []), memory: this.host.memory() };
    this.host.log('info', 'settings.features.push', `servers=${connections.length} statuses=${statuses?.length ?? 0} skills=${extras.skills.length}`);
    this.post(toPanelFeatures(connections, statuses ?? [], extras));
  }

  /**
   * Panel messages are handled one at a time.
   *
   * The window posts `saveFeatures` and then `syncMcp` a tick later (the edit
   * flow does `setTimeout(onSync, 0)`). Handled concurrently, the sync read the
   * store before the save had written it — the log showed `mcp.sync.start: 0
   * saved: none` immediately before `mcp.connections.write: 1` — so the window
   * was handed an empty list and the server appeared to vanish.
   */
  private chain: Promise<unknown> = Promise.resolve();

  private onMessage(message: { type?: string; [key: string]: any }): Promise<void> {
    const next = this.chain.then(() => this.handleMessage(message), () => this.handleMessage(message));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async handleMessage(message: { type?: string; [key: string]: any }): Promise<void> {
    if (!isPanelMessage(message)) {
      if (message?.type) this.host.log('info', 'settings.msg.ignored', String(message.type));
      return;
    }
    this.host.log('info', 'settings.msg', String(message.type));
    switch (message.type) {
      case 'getSettings':
        this.post({ type: 'loadSettings', settings: toPanelSettings(this.host.readSettings()) });
        return;
      case 'saveSettings':
        await this.host.writeSettings(fromPanelSettings(message.settings ?? {}));
        this.post({ type: 'loadSettings', settings: toPanelSettings(this.host.readSettings()) });
        return;
      case 'getFeatures':
        await this.pushFeatures();
        return;
      case 'saveFeatures':
        if (Array.isArray(message.features?.mcpServers)) {
          await this.host.writeConnections(message.features.mcpServers as PanelMcpConfig[]);
          // Reflect the change immediately; a failed connection shows on the row
          // instead of only after the user asks to sync.
          this.post(toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()));
        }
        return;
      case 'syncMcp':
        this.post(toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()));
        return;
      case 'mcpLogin':
        await this.host.mcpLogin(String(message.name ?? '')).catch((error) => this.reportMcpError(error));
        this.post(toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()));
        return;
      case 'mcpLogout':
        await this.host.mcpLogout(String(message.name ?? '')).catch((error) => this.reportMcpError(error));
        this.post(toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()));
        return;
      case 'getUsage':
        this.post({ type: 'usageData', usage: toPanelUsage(this.host.usage()) });
        return;
      case 'fetchAllModels':
        this.post({ type: 'modelsFetched', models: await this.host.refreshModels().catch(() => []) });
        return;
      case 'openVsCodeSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:TahsinArafat.sleepycode-agent');
        return;
      case 'openEditorSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'editor.');
        return;
      case 'openKeyboardShortcuts':
        void vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'sleepycode');
        return;
      case 'openExternal': {
        const target = String(message.url ?? '');
        // Only ever hand http(s) to the OS: a settings payload is not a trusted
        // source for arbitrary URI schemes.
        if (/^https?:\/\//i.test(target)) void vscode.env.openExternal(vscode.Uri.parse(target));
        return;
      }
      default:
        return;
    }
  }

  /**
   * Ask the host to sync. The host is responsible for returning one row per
   * stored server; if it throws anyway, the failure is reported under a name no
   * server has, which `completeMcpStatuses` folds into every real row.
   */
  private async safeSync(): Promise<PanelMcpStatus[]> {
    try {
      return await this.host.syncConnections();
    } catch (error) {
      return [{ name: '', connected: false, toolCount: 0, error: error instanceof Error ? error.message : String(error) }];
    }
  }

  private reportMcpError(error: unknown): void {
    void vscode.window.showErrorMessage(`MCP: ${error instanceof Error ? error.message : String(error)}`);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

/** Statuses for servers that are stored but switched off. */
export function disabledStatuses(connections: { name: string; enabled: boolean }[]): PanelMcpStatus[] {
  return connections
    .filter((connection) => !connection.enabled)
    .map((connection) => ({ name: connection.name, connected: false, toolCount: 0, error: 'Disabled' }));
}