import { execFile, spawn } from 'node:child_process';

export type PasteOutcome = 'pasted' | 'skipped' | 'failed';

/**
 * Windows: verify at the OS level that the Claude panel's window is the
 * foreground window before sending the paste keystroke. The window title
 * reflects the active tab, so 'Claude' in the foreground title means the chat
 * panel is focused (main window with the Claude tab active, or the popped-out
 * panel window). If another window is foreground, try to activate a
 * Claude-titled window first; if none exists, do NOT paste — a blind Ctrl+V
 * lands in whatever editor is focused (it once pasted into a source file).
 */
const WIN_PASTE_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$sb = New-Object System.Text.StringBuilder 512
[void][FG]::GetWindowText([FG]::GetForegroundWindow(), $sb, 512)
$title = $sb.ToString()
$sh = New-Object -ComObject WScript.Shell
if ($title -match 'Claude') {
  $sh.SendKeys('^v')
  Write-Output 'pasted'
  exit 0
}
if ($sh.AppActivate('Claude')) {
  Start-Sleep -Milliseconds 250
  $sh.SendKeys('^v')
  Write-Output 'pasted'
  exit 0
}
Write-Output 'skipped'
`;

function runPowerShellScript(script: string, timeoutMs = 5_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout) => resolve(err ? undefined : stdout.trim()),
    );
    child.on('error', () => resolve(undefined));
  });
}

function runSimple(command: string, args: string[], timeoutMs = 3_000): Promise<boolean> {
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
 * Send a paste keystroke to the Claude chat input, verifying the target
 * window first where the platform allows it. Never pastes blind on Windows.
 */
export async function pasteIntoClaudeWindow(): Promise<PasteOutcome> {
  switch (process.platform) {
    case 'win32': {
      const out = await runPowerShellScript(WIN_PASTE_SCRIPT);
      if (out === 'pasted') return 'pasted';
      if (out === 'skipped') return 'skipped';
      return 'failed';
    }
    case 'darwin': {
      // needs Accessibility permission for VS Code; fails cleanly without it
      const ok = await runSimple('osascript', [
        '-e',
        'tell application "System Events" to keystroke "v" using command down',
      ]);
      return ok ? 'pasted' : 'failed';
    }
    default: {
      const ok = await runSimple('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
      return ok ? 'pasted' : 'failed';
    }
  }
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * OS-native notification (Windows toast). Unlike VS Code toasts — which only
 * render in the main window — these appear regardless of which window has
 * focus, so they reach users working in a popped-out Claude panel.
 * Informational only: OS toast buttons can't call back into the extension.
 */
export async function showOsNotification(title: string, body: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const script = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast duration="short"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>')
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show((New-Object Windows.UI.Notifications.ToastNotification $xml))
Write-Output 'ok'
`;
  const out = await runPowerShellScript(script, 8_000);
  return out === 'ok';
}
