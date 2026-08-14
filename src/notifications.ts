import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export interface NotifyOptions {
  message: string;
  subtitle?: string;
  kind?: 'info' | 'attention';
}

let toastSeq = 0;

export function notifyToast(post: (message: unknown) => void, options: NotifyOptions): void {
  post({
    type: 'toast',
    id: ++toastSeq,
    title: options.subtitle ?? 'SleepyCode',
    message: options.message,
    kind: options.kind ?? 'info',
  });
}

const APP_NAME = 'SleepyCode';
const SETTING_ENABLED = 'systemNotifications';

function notificationsEnabled(): boolean {
  return vscode.workspace.getConfiguration('sleepycode').get<boolean>(SETTING_ENABLED, true);
}

function spawnNotifier(command: string, args: string[], timeoutMs: number, onMissing?: () => void): void {
  execFile(command, args, { timeout: timeoutMs, windowsHide: true }, error => {
    if (!error) return;
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') {
      onMissing?.();
      return;
    }
    console.warn(`SleepyCode notifier "${command}" failed: ${error.message}`);
  });
}

function notifyMacOS(_context: vscode.ExtensionContext, title: string, message: string): void {
  // Keep macOS notifications dependency-free and brand-safe: the repository no longer ships
  // a prebuilt notifier binary from the pre-SleepyCode fork. Arguments are passed separately
  // so notification text is never interpolated into AppleScript source.
  spawnNotifier('osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e', 'end run',
    title,
    message,
  ], 20_000);
}

function vscodeUriScheme(): string {
  return vscode.env.appName.includes('Insiders') ? 'vscode-insiders://' : 'vscode://';
}

function notifyWindows(context: vscode.ExtensionContext, title: string, message: string): void {
  const script = context.asAbsolutePath(path.join('native', 'windows', 'notify.ps1'));
  const icon = context.asAbsolutePath(path.join('media', 'sleepycode-notification.png'));
  const payload = Buffer.from(JSON.stringify({ title, body: message, icon, uri: vscodeUriScheme() })).toString('base64');
  spawnNotifier('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, payload], 30_000);
}

function notifyLinux(context: vscode.ExtensionContext, title: string, message: string): void {
  const script = context.asAbsolutePath(path.join('native', 'linux', 'notify.sh'));
  const icon = context.asAbsolutePath(path.join('media', 'sleepycode-notification.png'));
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  spawnNotifier('bash', [script, title, message, icon, vscodeUriScheme(), folder], 20_000);
}

export function systemNotify(context: vscode.ExtensionContext, options: NotifyOptions): void {
  try {
    if (vscode.window.state.focused) return;
    if (!notificationsEnabled()) return;
    const title = options.subtitle ?? APP_NAME;
    const message = options.message.trim();
    if (!message) return;
    switch (process.platform) {
      case 'darwin': notifyMacOS(context, title, message); break;
      case 'win32': notifyWindows(context, title, message); break;
      case 'linux': notifyLinux(context, title, message); break;
    }
  } catch (error) {
    console.warn('SleepyCode system notification failed:', error);
  }
}
