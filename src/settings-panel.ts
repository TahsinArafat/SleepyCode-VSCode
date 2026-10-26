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
}

export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, private readonly host: SettingsPanelHost) {
    this.panel = panel;
  }

  /** Open the settings window, revealing the existing one if it is already up. */
  static show(context: vscode.ExtensionContext, host: SettingsPanelHost): SettingsPanel {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      void SettingsPanel.current.pushAll();
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
    panel.webview.html = renderReactWebviewHtml(panel.webview, context.extensionUri, 'settings', 'SleepyCode Settings');
    panel.webview.onDidReceiveMessage((message) => void instance.onMessage(message));
    panel.onDidDispose(() => {
      instance.disposed = true;
      if (SettingsPanel.current === instance) SettingsPanel.current = undefined;
    });
    return instance;
  }

  private post(message: unknown): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
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
    const connections = await this.host.readConnections().catch(() => []);
    this.post({ type: 'features', ...toPanelFeatures(connections, statuses ?? []) });
  }

  private async onMessage(message: { type?: string; [key: string]: any }): Promise<void> {
    if (!isPanelMessage(message)) return;
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
          this.post({ type: 'features', ...toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()) });
        }
        return;
      case 'syncMcp':
        this.post({ type: 'features', ...toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()) });
        return;
      case 'mcpLogin':
        await this.host.mcpLogin(String(message.name ?? '')).catch((error) => this.reportMcpError(error));
        this.post({ type: 'features', ...toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()) });
        return;
      case 'mcpLogout':
        await this.host.mcpLogout(String(message.name ?? '')).catch((error) => this.reportMcpError(error));
        this.post({ type: 'features', ...toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()) });
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