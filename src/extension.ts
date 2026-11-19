import * as vscode from 'vscode';
import { AgentViewProvider } from './agent';
import { systemNotify } from './notifications';

async function revealChat(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
  } catch { }
  try {
    await vscode.commands.executeCommand('sleepycode.chat.focus');
  } catch { }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new AgentViewProvider(context);
  context.subscriptions.push(
    provider,
    // NOT retained while hidden, deliberately. With `true` VS Code keeps the whole
    // webview alive when the sidebar is collapsed: its DOM, React tree, markdown
    // cache and decoded images all stay resident for a chat nobody is looking at.
    // Everything needed to rebuild is already durable — the host republishes the
    // transcript on `ready`, drafts and open tabs are persisted per workspace, and
    // in-flight runs are host-side — so hiding the view frees the renderer instead
    // of charging RAM for it.
    vscode.window.registerWebviewViewProvider('sleepycode.chat', provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.registerUriHandler({ handleUri: uri => provider.handleUri(uri) }),
    vscode.commands.registerCommand('sleepycode.openChat', () => revealChat()),
    vscode.commands.registerCommand('sleepycode.focus', () => revealChat()),
    vscode.commands.registerCommand('sleepycode.settings', () => provider.openSettings()),
    vscode.commands.registerCommand('sleepycode.settingsWindow', () => provider.openSettingsWindow()),
    vscode.commands.registerCommand('sleepycode.openLogs', () => provider.showLogs()),
    // Copy the memory report in one action. "Open it, find the line, select it" is
    // three steps too many when the thing being reported is that the editor is slow.
    vscode.commands.registerCommand('sleepycode.copyMemoryReport', () => provider.copyMemoryReport()),
    // A heap snapshot names the exact retaining path. Separate from the report because it
    // is the size of the heap and pauses the host while it is written.
    vscode.commands.registerCommand('sleepycode.saveHeapSnapshot', () => provider.saveHeapSnapshot()),
    // The whole extension log, copied for a bug report.
    vscode.commands.registerCommand('sleepycode.copyLogs', () => provider.copyLogs()),
    vscode.commands.registerCommand('sleepycode.signIn', () => provider.signIn()),
    vscode.commands.registerCommand('sleepycode.usage', () => provider.openUsage()),
    vscode.commands.registerCommand('sleepycode.memory', () => provider.openMemory()),
    vscode.commands.registerCommand('sleepycode.marketplace', () => provider.openMarketplace()),
    vscode.commands.registerCommand('sleepycode.clear', () => provider.clear()),
    vscode.commands.registerCommand('sleepycode.worktrees', () => provider.openPanel('worktrees')),
    vscode.commands.registerCommand('sleepycode.index', () => provider.openPanel('index')),
    vscode.commands.registerCommand('sleepycode.agents', () => provider.openPanel('agents')),
    vscode.commands.registerCommand('sleepycode.tasks', () => provider.openPanel('tasks')),
    vscode.commands.registerCommand('sleepycode.checkpoints', () => provider.openPanel('checkpoints')),
    vscode.commands.registerCommand('sleepycode.testSystemNotification', () => {
      systemNotify(context, { subtitle: 'SleepyCode', message: 'This is a test system notification from SleepyCode. If you can read this, native notifications are working.', kind: 'info' });
      void vscode.window.showInformationMessage('Test system notification sent. (Notifications only appear when VS Code is not focused.)');
    }),
  );
  // Keyboard-first shell actions. Each is a thin forwarder into the webview, which owns the
  // composer and the transcript; the matching keybindings are contributed in package.json so the
  // editor hands these chords over instead of consuming them itself.
  for (const action of ['stop', 'clearComposer', 'newLine', 'copyLast', 'shortcuts'] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(`sleepycode.chat.${action}`, () => provider.shortcut(action)));
  }
}

export function deactivate() { }
