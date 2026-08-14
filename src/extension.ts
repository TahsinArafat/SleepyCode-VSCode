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
    vscode.window.registerWebviewViewProvider('sleepycode.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('sleepycode.openChat', () => revealChat()),
    vscode.commands.registerCommand('sleepycode.focus', () => revealChat()),
    vscode.commands.registerCommand('sleepycode.settings', () => provider.openSettings()),
    vscode.commands.registerCommand('sleepycode.usage', () => provider.openUsage()),
    vscode.commands.registerCommand('sleepycode.memory', () => provider.openMemory()),
    vscode.commands.registerCommand('sleepycode.marketplace', () => provider.openMarketplace()),
    vscode.commands.registerCommand('sleepycode.clear', () => provider.clear()),
    vscode.commands.registerCommand('sleepycode.testSystemNotification', () => {
      systemNotify(context, { subtitle: 'SleepyCode', message: 'This is a test system notification from SleepyCode. If you can read this, native notifications are working.', kind: 'info' });
      void vscode.window.showInformationMessage('Test system notification sent. (Notifications only appear when VS Code is not focused.)');
    }),
  );
}

export function deactivate() { }
