import { execFile, spawn } from 'node:child_process';

export type PasteOutcome = 'pasted' | 'skipped' | 'failed';

/**
 * Windows: verify at the OS level that the Claude panel's window is the
 * foreground window before sending the paste keystroke. Window titles
 * reflect the active tab, and the Claude panel's tab is titled with the
 * conversation name — so the caller passes the actual tab labels (from
 * vscode.window.tabGroups) and we match/activate against those, falling back
 * to 'Claude'. If no target window can be verified, do NOT paste — a blind
 * Ctrl+V lands in whatever editor is focused (it once pasted into a source
 * file).
 */
function buildWinPasteScript(targetTitles: string[]): string {
  const targets = [...targetTitles, 'Claude']
    .filter((t) => t.trim().length >= 3)
    .map((t) => `'${t.slice(0, 120).replace(/'/g, "''")}'`)
    .join(',');
  return `
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
$targets = @(${targets})
foreach ($t in $targets) {
  if ($title.IndexOf($t, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    $sh.SendKeys('^v')
    Write-Output 'pasted'
    exit 0
  }
}
foreach ($t in $targets) {
  if ($sh.AppActivate($t)) {
    Start-Sleep -Milliseconds 250
    $sh.SendKeys('^v')
    Write-Output 'pasted'
    exit 0
  }
}
Write-Output 'skipped'
`;
}

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
 * `targetTitles`: the Claude panel's actual tab labels, used to recognize or
 * activate the window that hosts it.
 */
export async function pasteIntoClaudeWindow(targetTitles: string[] = []): Promise<PasteOutcome> {
  switch (process.platform) {
    case 'win32': {
      const out = await runPowerShellScript(buildWinPasteScript(targetTitles));
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

