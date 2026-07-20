import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Claude Code's project-folder slug: every non-alphanumeric char becomes '-'. */
export function projectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeHome(): string {
  return path.join(homedir(), '.claude');
}

export function projectDir(cwd: string): string {
  return path.join(claudeHome(), 'projects', projectSlug(cwd));
}

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  entrypoint?: string;
}

/** Live claude processes, from ~/.claude/sessions/<pid>.json (stale PIDs filtered). */
export async function readLiveSessions(): Promise<LiveSession[]> {
  const dir = path.join(claudeHome(), 'sessions');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (typeof data?.sessionId === 'string' && typeof data?.cwd === 'string' && isPidAlive(data.pid)) {
        out.push({ pid: data.pid, sessionId: data.sessionId, cwd: data.cwd, entrypoint: data.entrypoint });
      }
    } catch {
      // unreadable/stale session file — ignore
    }
  }
  return out;
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sameCwd(a: string, b: string): boolean {
  const norm = (p: string) => {
    const n = path.resolve(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

export interface ActiveSession {
  sessionId: string;
  jsonlPath: string;
  /** entrypoint if known from live-session metadata */
  entrypoint?: string;
}

/**
 * Sessions to watch for a workspace folder: every live session matching the
 * cwd (+ entrypoint filter), newest transcripts first, capped; if none are
 * live, the most recently modified .jsonl in the project dir as a fallback.
 * Watching all live sessions keeps one pending suggestion per conversation.
 */
export async function pickActiveSessions(
  cwd: string,
  entrypointFilter: 'claude-vscode' | 'all',
  maxSessions = 8,
): Promise<ActiveSession[]> {
  const dir = projectDir(cwd);

  const candidates: ActiveSession[] = [];
  for (const live of await readLiveSessions()) {
    if (!sameCwd(live.cwd, cwd)) continue;
    if (entrypointFilter !== 'all' && live.entrypoint && live.entrypoint !== entrypointFilter) continue;
    candidates.push({
      sessionId: live.sessionId,
      jsonlPath: path.join(dir, `${live.sessionId}.jsonl`),
      entrypoint: live.entrypoint,
    });
  }

  const withMtime = async (s: ActiveSession) => {
    try {
      return { s, mtime: (await stat(s.jsonlPath)).mtimeMs };
    } catch {
      return undefined;
    }
  };
  const alive = (await Promise.all(candidates.map(withMtime))).filter(Boolean) as Array<{
    s: ActiveSession;
    mtime: number;
  }>;
  if (alive.length > 0) {
    alive.sort((a, b) => b.mtime - a.mtime);
    return alive.slice(0, maxSessions).map((x) => x.s);
  }

  // Fallback: newest transcript on disk (entrypoint checked later from lines).
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  let best: { file: string; mtime: number } | undefined;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const m = (await stat(path.join(dir, name))).mtimeMs;
      if (!best || m > best.mtime) best = { file: name, mtime: m };
    } catch {
      // file vanished between readdir and stat
    }
  }
  if (!best) return [];
  return [
    {
      sessionId: best.file.replace(/\.jsonl$/, ''),
      jsonlPath: path.join(dir, best.file),
    },
  ];
}
