/**
 * The settings window, hosted by SleepyCode.
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
import * as settingsAdapter from './settings-adapter';
import { renderReactWebviewHtml } from './webview-react';
import {
  fromPanelSettings,
  isPanelMessage,
  toPanelFeatures,
  toPanelSettings,
  toMarketplaceSkillRows,
  toPanelUsage,
  type PanelMcpConfig,
  type PanelMcpStatus,
  type StoredSettings,
} from './settings-adapter';

/** What the settings window can ask the extension to do. */
import * as featurePrefs from './feature-prefs';

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
  /** Start the first-party sign-in flow. */
  signIn(): void;
  /** Who is signed in, and what their plan allows. Never includes the token. */
  sleepyAccount(): Promise<unknown>;
  /** Forget the stored first-party token: sign out. */
  signOut(): Promise<void>;
  /** The hook rules this build evaluates, in the order they are checked. */
  readHooks(): Promise<unknown[]>;
  /** Replace the hook rules. */
  writeHooks(rules: unknown): Promise<void>;
  /** The model catalog, with each model's configurable options. */
  readModels(): Promise<unknown>;
  /** Built-in agents and the user's own, as the Agents page lists them. */
  readAgents(): Promise<unknown>;
  /** The model chosen for each subagent role, and the models available. */
  readSubagents(): Promise<unknown>;
  /** Replace the per-role model map. */
  writeSubagentModels(models: unknown): Promise<void>;
  /** Create or update one agent. */
  saveAgent(agent: unknown): Promise<void>;
  /** Remove one agent. Built-ins are refused host-side. */
  deleteAgent(id: string): Promise<void>;
  /** Save one model's options, in the shape the chat's model menu posts. */
  saveModelOptions(modelId: string, options: unknown): Promise<void>;
  /** Return one model's options to the discovered values. */
  resetModelOptions(modelId: string): Promise<void>;
  /** SleepyCode's project index, as the Indexing page shows it. */
  indexReport(): Promise<unknown>;
  /** Rebuild the index now, and return the fresh report. */
  rebuildIndex(): Promise<unknown>;
  /** Open a panel-supplied path after resolving and authorising it. */
  openPanelFile(path: unknown): Promise<boolean>;
  /** Scaffold a skill and open it. */
  createSkill(): Promise<{ ok: boolean; text: string }>;
  /** Remove an installed skill, named by its SKILL.md path. */
  deleteSkill(path: unknown): Promise<{ ok: boolean; text: string }>;
  /** The installed build's version, for the About page. */
  version(): string;
  /** The user's providers, with key presence — never the keys themselves. */
  readProviders(): Promise<unknown[]>;
  /** Save one provider, returning the ids now stored. */
  writeProvider(draft: unknown): Promise<void>;
  /** Remove a compatibility endpoint. The first-party provider is refused. */
  removeProvider(id: string): Promise<void>;
  /** Store (or clear) an endpoint's API key. */
  setProviderKey(id: string, key: string): Promise<void>;
  /** Make one provider the default for new conversations. */
  setActiveProvider(id: string): Promise<void>;
  /** Recent extension log entries, newest last. */
  readLogs(): Promise<unknown[]>;
  /** Clear the recorded extension log. */
  clearLogs(): Promise<void>;
  /** Return every setting to its default. Irreversible. */
  resetAll(): Promise<void>;
  /** Remember that first-run setup has been dealt with. */
  completeSetup(): Promise<void>;
  /** Clear the recorded local usage. */
  resetUsage(): Promise<void>;
  /** Store chat preferences for this workspace. */
  writeChatPrefs(patch: Partial<featurePrefs.ChatPrefs>): Promise<void>;
  /** The stored feature values, so the window shows reality rather than defaults. */
  readFeatures(): Promise<Record<string, unknown>>;
  /** Set SleepyCode's single approval mode. */
  setApprovalMode(mode: string): Promise<void>;
  /** Report a panel-level event to the extension log. */
  log(level: 'info' | 'warn' | 'error', event: string, detail?: string): void;
  /** Installed skills, for the Rules & Skills section. */
  skills(): Promise<readonly { name: string; description?: string; skillMdPath?: string }[]>;
  /** Whether the project memory file exists, so it can be listed as a rule. */
  memory(): { memoryPath: string; memoryExists: boolean };
  /** Search the skill marketplace. */
  marketplaceSearch(query: string, sortBy?: 'stars' | 'recent'): Promise<{ skills: any[]; total: number }>;
  /** Installed skills, with the folder name needed to uninstall. */
  marketplaceInstalled(): Promise<{ name: string; description: string; folder: string; skillMdPath: string; key?: string }[]>;
  marketplaceInstall(source: string, skill?: string): Promise<{ ok: boolean; text: string }>;
  marketplaceUninstall(folder: string): Promise<{ ok: boolean; text: string }>;
}

export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, private readonly host: SettingsPanelHost) {
    this.panel = panel;
  }

  /** Open the settings window, revealing the existing one if it is already up. */
  static show(context: vscode.ExtensionContext, host: SettingsPanelHost, section?: string, firstRun = false): SettingsPanel {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      void SettingsPanel.current.pushAll();
      if (section) SettingsPanel.current.post({ type: 'navigate', section });
      if (firstRun) SettingsPanel.current.post({ type: 'firstRun' });
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
    if (firstRun) setTimeout(() => instance.post({ type: 'firstRun' }), 160);
    return instance;
  }

  /**
   * Reply to a Usage action. `usageActionResultMessage` returns null for a
   * status or action the panel cannot match, so nothing is posted that would be
   * ignored and then time out anyway.
   */
  private postUsageResult(requestId: unknown, action: 'refresh' | 'reset', status: 'success' | 'cancelled' | 'error', error?: string): void {
    const result = settingsAdapter.usageActionResultMessage({ requestId, action, status, error });
    if (result) this.post(result);
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
    // Which build this is. An About page that cannot say is not an About page.
    this.post({ type: 'appInfo', version: this.host.version() });
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
    const payload = toPanelFeatures(connections, statuses ?? [], extras);
    // The window REPLACES its whole feature state from this message, so it is the
    // only safe carrier for the stored chat preferences and configuration. A
    // separate partial `features` message would blank the MCP list, and omitting
    // them leaves every toggle showing its default instead of what was saved.
    const stored = await this.host.readFeatures().catch(() => ({}));
    this.post({ ...payload, features: { ...payload.features, ...stored } });
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
      case 'saveFeatures': {
        // One payload, several stores. `routeFeatureSave` decides which parts are
        // present; each is applied only if it is, so saving a chat preference can
        // never rewrite the MCP list and vice versa. Everything here used to be
        // dropped except `mcpServers`, so every other control appeared to save and
        // reset on the next open.
        const routed = featurePrefs.routeFeatureSave(message.features);
        if (routed.connections) {
          await this.host.writeConnections(routed.connections as PanelMcpConfig[]);
          // Reflect the change immediately; a failed connection shows on the row
          // instead of only after the user asks to sync.
          this.post(toPanelFeatures(await this.host.readConnections().catch(() => []), await this.safeSync()));
        }
        if (Object.keys(routed.prefs).length) await this.host.writeChatPrefs(routed.prefs);
        if (Object.keys(routed.config).length) await this.host.writeSettings(routed.config);
        if (routed.approvalMode) await this.host.setApprovalMode(routed.approvalMode);
        // No echo. A `features` message carries MCP statuses too and the window
        // replaces its whole state from one, so echoing a preference save would
        // clear the MCP status rows — and re-syncing every server on each toggle
        // is far too much work for saving a text size. The window already updated
        // its own state optimistically; stored truth is read back on next open
        // (pushFeatures merges it), which is where a clamped value would show.
        return;
      }
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
      case 'requestMarketplaceInstalled':
        this.post({ type: 'marketplaceInstalled', skills: await this.host.marketplaceInstalled().catch(() => []) });
        return;
      case 'marketplaceTop':
      case 'marketplaceSearch': {
        // `marketplaceTop` browses the catalogue with a neutral query, the same
        // way the sidebar's marketplace view does.
        const query = message.type === 'marketplaceTop' ? 'skill' : String(message.query ?? '');
        try {
          const { skills, total } = await this.host.marketplaceSearch(query, message.sortBy);
          const installed = await this.host.marketplaceInstalled().catch(() => []);
          this.post({
            type: 'marketplaceResults',
            query: message.type === 'marketplaceTop' ? '' : query,
            total,
            skills: toMarketplaceSkillRows(skills, installed.map((skill) => skill.folder)),
          });
        } catch (error) {
          this.post({ type: 'marketplaceError', text: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case 'marketplaceInstall': {
        const result = await this.host.marketplaceInstall(String(message.source ?? ''), message.skill ? String(message.skill) : undefined);
        this.post({ type: 'marketplaceResult', ok: result.ok, text: result.text });
        if (result.ok) this.post({ type: 'marketplaceInstalled', skills: await this.host.marketplaceInstalled().catch(() => []) });
        return;
      }
      case 'marketplaceUninstall': {
        const result = await this.host.marketplaceUninstall(String(message.folder ?? ''));
        this.post({ type: 'marketplaceResult', ok: result.ok, text: result.text });
        if (result.ok) this.post({ type: 'marketplaceInstalled', skills: await this.host.marketplaceInstalled().catch(() => []) });
        return;
      }
      case 'getUsage':
        this.post({ type: 'usageData', usage: toPanelUsage(this.host.usage()) });
        // A bare `getUsage` is the page load; the panel's Refresh button sends a
        // request id and then waits for a matching result. Answering only the
        // bare form left Refresh timing out for 30 s on a read that works.
        if (message.requestId) this.postUsageResult(message.requestId, 'refresh', 'success');
        return;
      case 'resetUsage': {
        if (!message.requestId) return;
        try {
          await this.host.resetUsage();
          this.post({ type: 'usageData', usage: toPanelUsage(this.host.usage()) });
          this.postUsageResult(message.requestId, 'reset', 'success');
        } catch (error) {
          this.postUsageResult(message.requestId, 'reset', 'error', error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case 'oauthGet':
        // This build has no OAuth provider accounts. Answering with the truth
        // stops the window waiting on a reply it never got, and the Account Quota
        // section is hidden while the list is empty.
        this.post(settingsAdapter.panelOAuthStatusMessage());
        return;
      case 'getSubagents':
        await this.postSubagents();
        return;
      case 'saveSubagentModels':
        await this.host.writeSubagentModels(message.models).catch(() => undefined);
        await this.postSubagents();
        return;
      case 'getAgents':
        this.post({ type: 'agents', agents: await this.host.readAgents().catch(() => []) });
        return;
      case 'saveAgent':
        await this.host.saveAgent(message.agent).catch(() => undefined);
        this.post({ type: 'agents', agents: await this.host.readAgents().catch(() => []) });
        return;
      case 'deleteAgent':
        await this.host.deleteAgent(String(message.id ?? '')).catch(() => undefined);
        this.post({ type: 'agents', agents: await this.host.readAgents().catch(() => []) });
        return;
      case 'fetchAllModels':
        await this.postModels();
        return;
      case 'saveModelOptions':
        await this.host.saveModelOptions(String(message.modelId ?? ''), message.options).catch(() => undefined);
        await this.postModels();
        return;
      case 'resetModelOptions':
        await this.host.resetModelOptions(String(message.modelId ?? '')).catch(() => undefined);
        await this.postModels();
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
      case 'openWorkspaceFile': {
        // Every rule row and every skill row is a click target. The path arrives
        // from the page, so it is resolved against a root this extension owns and
        // authorised before anything is opened.
        const opened = await this.host.openPanelFile(message.path);
        if (!opened) this.host.log('warn', 'settings.openFile.refused', String(message.path ?? ''));
        return;
      }
      case 'createSkill': {
        // SleepyCode can create a skill (a scaffolded SKILL.md in its skills
        // directory), so this button is real. The rule section's own New/Delete
        // are the upstream rule model, which SleepyCode does not have — those
        // buttons are removed from the page rather than wired to something else.
        const result = await this.host.createSkill();
        this.post({ type: 'panelNotice', text: result.text, error: !result.ok });
        if (result.ok) await this.pushFeatures();
        return;
      }
      case 'deleteSkill': {
        const result = await this.host.deleteSkill(message.path);
        this.post({ type: 'panelNotice', text: result.text, error: !result.ok });
        if (result.ok) await this.pushFeatures();
        return;
      }
      case 'getProviders':
        this.post({ type: 'providers', providers: await this.host.readProviders() });
        return;
      case 'saveProvider':
      case 'deleteProvider':
      case 'setProviderKey':
        // One guard for all three: a refusal has to be visible, or the button
        // reads as broken.
        try {
          if (message.type === 'saveProvider') await this.host.writeProvider(message.draft);
          else if (message.type === 'deleteProvider') await this.host.removeProvider(String(message.id ?? ''));
          else await this.host.setProviderKey(String(message.id ?? ''), String(message.apiKey ?? ''));
          this.post({ type: 'providers', providers: await this.host.readProviders() });
        } catch (error) {
          this.post({ type: 'panelNotice', text: error instanceof Error ? error.message : String(error), error: true });
        }
        return;
      case 'getLogs':
        // The host has always kept these; nothing could read them from the window.
        this.post({ type: 'logs', entries: await this.host.readLogs().catch(() => []) });
        return;
      case 'clearLogs':
        await this.host.clearLogs();
        this.post({ type: 'logs', entries: [] });
        return;
      case 'resetAllSettings':
        try {
          await this.host.resetAll();
        } catch (error) {
          this.post({ type: 'panelNotice', text: `Could not reset: ${error instanceof Error ? error.message : String(error)}`, error: true });
          return;
        }
        // Re-read everything: the window is now showing values that were just
        // replaced, and leaving them on screen would be a lie.
        await this.pushAll();
        this.post({ type: 'resetDone' });
        return;
      case 'completeSetup':
        await this.host.completeSetup();
        return;
      case 'getIndexStatus':
        this.post({ type: 'indexStatus', status: await this.host.indexReport().catch(() => null) });
        return;
      case 'reindexIndex':
        this.post({ type: 'indexStatus', status: await this.host.rebuildIndex().catch(() => null) });
        return;
      case 'setActiveProvider':
        await this.host.setActiveProvider(String(message.id ?? '')).catch(() => undefined);
        this.post({ type: 'providers', providers: await this.host.readProviders().catch(() => []) });
        return;
      case 'getHooks':
        this.post({ type: 'hooks', hooks: await this.host.readHooks().catch(() => []) });
        return;
      case 'saveHooks': {
        await this.host.writeHooks(message.hooks).catch(() => undefined);
        this.post({ type: 'hooks', hooks: await this.host.readHooks().catch(() => []) });
        return;
      }
      case 'getAccount':
        this.post({ type: 'account', account: await this.host.sleepyAccount().catch(() => ({ loggedIn: false })) });
        return;
      case 'signOut':
        await this.host.signOut().catch(() => undefined);
        this.post({ type: 'account', account: await this.host.sleepyAccount().catch(() => ({ loggedIn: false })) });
        return;
      case 'signIn':
        // The window's only provider action. Compatibility-endpoint API keys have
        // no editor here (that section is hidden), so this is what a signed-out
        // user can actually do, instead of a row that opened a blank page.
        this.host.signIn();
        return;
      default:
        return;
    }
  }

  /** Publish the per-role subagent models and the catalog they are chosen from. */
  private async postSubagents(): Promise<void> {
    const payload = (await this.host.readSubagents().catch(() => null)) as { models?: unknown; catalog?: string[] } | null;
    this.post({ type: 'subagents', models: payload?.models ?? {}, catalog: payload?.catalog ?? [] });
  }

  /**
   * Publish the model catalog.
   *
   * The full list, not just the ids: the Models page edits per-model options, and
   * a bare id carries none. This is the same payload the chat's picker receives,
   * so the two cannot disagree about a model's context window.
   */
  private async postModels(): Promise<void> {
    const payload = (await this.host.readModels().catch(() => null)) as { models?: string[]; modelList?: unknown[] } | null;
    this.post({ type: 'modelsFetched', models: payload?.models ?? [], modelList: payload?.modelList ?? [] });
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