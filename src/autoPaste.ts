import { spawn } from 'node:child_process';

function run(command: string, args: string[], timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/**
 * Send a native paste keystroke to the OS foreground window. Callers must
 * only invoke this immediately after successfully focusing the Claude chat
 * input, so the keystroke lands there. Returns false when simulation isn't
 * possible (missing tool, denied automation permission) — callers fall back
 * to clipboard-only.
 */
export function simulatePaste(): Promise<boolean> {
  switch (process.platform) {
    case 'win32':
      return run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        "(New-Object -ComObject WScript.Shell).SendKeys('^v')",
      ]);
    case 'darwin':
      // needs Accessibility permission for VS Code; fails cleanly without it
      return run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
    default:
      return run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
  }
}
