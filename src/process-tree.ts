import { execFile, type ChildProcess } from 'node:child_process';

/**
 * Terminate an owned process tree without killing attached/external servers.
 * POSIX children must be spawned detached so the negative PID addresses their group.
 */
export function terminateProcessTree(child: ChildProcess, graceMs = 2_000): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { } }
  if (graceMs <= 0) {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
    return;
  }
  const timer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
  }, graceMs);
  timer.unref?.();
}
