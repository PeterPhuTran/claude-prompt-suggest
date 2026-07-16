import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaudeBinary } from './types';

const execFileP = promisify(execFile);

function isShellShim(p: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(p);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fromPath(): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('where.exe', ['claude'], { windowsHide: true });
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // prefer a real executable over npm .cmd shims
      return lines.find((l) => /\.exe$/i.test(l)) ?? lines[0];
    }
    const { stdout } = await execFileP('which', ['claude']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Bundled binary inside the official Claude Code extension, newest version first. */
async function fromInstalledExtensions(extraExtensionDirs: string[]): Promise<string | undefined> {
  const binaryRel = path.join('resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');

  for (const extDir of extraExtensionDirs) {
    const candidate = path.join(extDir, binaryRel);
    if (await exists(candidate)) return candidate;
  }

  const roots = [
    path.join(homedir(), '.vscode', 'extensions'),
    path.join(homedir(), '.vscode-insiders', 'extensions'),
  ];
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    const matches = names.filter((n) => n.startsWith('anthropic.claude-code-')).sort().reverse();
    for (const name of matches) {
      const candidate = path.join(root, name, binaryRel);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Find the claude binary: explicit setting -> PATH -> the official
 * extension's bundled binary. `extraExtensionDirs` lets the VS Code layer
 * pass the resolved extensionPath of anthropic.claude-code (checked first
 * among bundled candidates); the dev harness passes none.
 */
export async function discoverClaudeBinary(
  settingPath?: string,
  extraExtensionDirs: string[] = [],
): Promise<ClaudeBinary | undefined> {
  if (settingPath?.trim()) {
    const p = settingPath.trim().replace(/^~(?=[\\/])/, homedir());
    if (await exists(p)) return { path: p, source: 'setting', isShellShim: isShellShim(p) };
    return undefined; // explicit setting that doesn't exist is an error, no silent fallback
  }

  const onPath = await fromPath();
  if (onPath) return { path: onPath, source: 'path', isShellShim: isShellShim(onPath) };

  const bundled = await fromInstalledExtensions(extraExtensionDirs);
  if (bundled) return { path: bundled, source: 'bundled', isShellShim: false };

  return undefined;
}
