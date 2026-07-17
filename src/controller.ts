import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { SuggestConfig } from './config';
import type { Log } from './log';
import type { StatusBar } from './statusBarUi';
import type { ClaudeBinary, TurnCompleteEvent } from './types';
import { claudeHome, pickActiveSessions, projectDir } from './sessionLocator';
import { TranscriptTailer } from './transcriptTailer';
import { TurnDetector } from './turnDetector';
import { generateSuggestion } from './suggestionEngine';

const FALLBACK_POLL_MS = 10_000;
const AUTH_BACKOFF_MS = 10 * 60_000;

export interface ControllerDeps {
  config: () => SuggestConfig;
  getBinary: () => Promise<ClaudeBinary | undefined>;
  ui: StatusBar;
  log: Log;
  storageDir: string;
}

/** Per-session tail/detect/generate state — one per live conversation. */
interface SessionWatcher {
  sessionId: string;
  jsonlPath: string;
  tailer: TranscriptTailer;
  detector: TurnDetector;
  inflight?: AbortController;
  generation: number;
  lastTurn?: TurnCompleteEvent;
  lastTurnAt?: number;
}

/**
 * Watches one workspace folder's Claude project dir and drives suggestions.
 * Every live session gets its own watcher, so each open conversation keeps
 * its own pending suggestion independently.
 */
export class SuggestController {
  private dirWatcher: fs.FSWatcher | undefined;
  private watchedDir: string | undefined;
  private fallbackTimer: NodeJS.Timeout;
  private debounceTimer: NodeJS.Timeout | undefined;

  private watchers = new Map<string, SessionWatcher>();
  private authBackoffUntil = 0;

  private ticking = false;
  private tickQueued = false;
  private disposed = false;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly deps: ControllerDeps,
  ) {
    this.setupWatcher();
    this.fallbackTimer = setInterval(() => this.scheduleTick(), FALLBACK_POLL_MS);
    this.scheduleTick();
  }

  private get cwd(): string {
    return this.folder.uri.fsPath;
  }

  /** Watch the project's transcript dir; if absent, watch projects root for its creation. */
  private setupWatcher(): void {
    const dir = projectDir(this.cwd);
    const target = fs.existsSync(dir) ? dir : path.join(claudeHome(), 'projects');
    if (this.watchedDir === target) return;

    this.dirWatcher?.close();
    this.dirWatcher = undefined;
    this.watchedDir = undefined;
    try {
      this.dirWatcher = fs.watch(target, () => {
        this.setupWatcher(); // switch to the slug dir once it exists
        this.scheduleTick();
      });
      this.dirWatcher.on('error', (err) => {
        this.deps.log.warn(`watcher error on ${target}: ${err}`);
        this.dirWatcher?.close();
        this.dirWatcher = undefined;
        this.watchedDir = undefined;
        // fallback polling keeps things alive; retry watch on next tick
      });
      this.watchedDir = target;
      this.deps.log.info(`watching ${target}`);
    } catch (err) {
      this.deps.log.warn(`cannot watch ${target}: ${err}`);
    }
  }

  private scheduleTick(): void {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.tick();
    }, this.deps.config().debounceMs);
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    if (this.ticking) {
      this.tickQueued = true;
      return;
    }
    this.ticking = true;
    try {
      await this.processChanges();
    } catch (err) {
      this.deps.log.warn(`tick failed: ${err}`);
    } finally {
      this.ticking = false;
      if (this.tickQueued) {
        this.tickQueued = false;
        this.scheduleTick();
      }
    }
  }

  private async processChanges(): Promise<void> {
    const cfg = this.deps.config();
    if (!cfg.enabled) return;
    if (this.watchedDir !== projectDir(this.cwd)) this.setupWatcher();

    const sessions = await pickActiveSessions(this.cwd, cfg.entrypointFilter);
    if (sessions.length === 0) return;

    const wanted = new Set(sessions.map((s) => s.sessionId));
    for (const [id, w] of this.watchers) {
      if (!wanted.has(id)) {
        w.inflight?.abort();
        this.watchers.delete(id);
        this.deps.ui.clearSession(this, id);
        this.deps.log.info(`session gone: ${id.slice(0, 8)}`);
      }
    }

    for (const s of sessions) {
      let w = this.watchers.get(s.sessionId);
      if (!w) {
        w = {
          sessionId: s.sessionId,
          jsonlPath: s.jsonlPath,
          tailer: new TranscriptTailer(s.jsonlPath, {
            onParseError: (err) => this.deps.log.warn(`transcript parse error: ${err}`),
          }),
          detector: new TurnDetector(s.sessionId, { maxContext: cfg.maxContextMessages }),
          generation: 0,
        };
        this.watchers.set(s.sessionId, w);
        this.deps.log.info(`session: ${s.sessionId} (${s.entrypoint ?? 'entrypoint from transcript'})`);
        try {
          const lines = await w.tailer.bootstrap();
          w.detector.bootstrap(lines);
        } catch (err) {
          this.deps.log.warn(`bootstrap failed for ${s.sessionId.slice(0, 8)}, retrying next event: ${err}`);
          this.watchers.delete(s.sessionId);
        }
        continue; // historical turns never fire; wait for new appends
      }

      let lines;
      try {
        lines = await w.tailer.poll();
      } catch (err) {
        this.deps.log.warn(`poll failed for ${s.sessionId.slice(0, 8)}: ${err}`);
        continue;
      }
      if (lines.length === 0) continue;

      for (const event of w.detector.ingest(lines)) {
        if (event.kind === 'user-message') {
          w.inflight?.abort();
          w.inflight = undefined;
          this.deps.ui.clearSession(this, w.sessionId);
        } else {
          void this.startGeneration(w, event);
        }
      }
    }
  }

  private async startGeneration(w: SessionWatcher, event: TurnCompleteEvent): Promise<void> {
    const cfg = this.deps.config();
    if (
      cfg.entrypointFilter !== 'all' &&
      w.detector.entrypoint &&
      w.detector.entrypoint !== cfg.entrypointFilter
    ) {
      return;
    }
    if (Date.now() < this.authBackoffUntil) return;
    if (event.contextMessages.length === 0) return;

    const binary = await this.deps.getBinary();
    if (!binary) {
      this.deps.ui.showError(this, 'binary', 'claude binary not found — click to set claudeSuggest.claudePath');
      return;
    }

    w.inflight?.abort();
    const ac = new AbortController();
    w.inflight = ac;
    const gen = ++w.generation;
    w.lastTurn = event;
    w.lastTurnAt = Date.now();
    this.deps.ui.beginBusy(this);

    try {
      const started = Date.now();
      const attempt = () =>
        generateSuggestion(event.contextMessages, {
          binary,
          model: cfg.model,
          cwd: this.deps.storageDir,
          timeoutMs: cfg.timeoutSeconds * 1000,
          signal: ac.signal,
        });
      let result = await attempt();
      if (!result.ok && result.error === 'timeout' && !this.disposed && gen === w.generation) {
        // first spawn after a Claude update can be slow (AV scans the new binary)
        this.deps.log.warn(`timeout after ${cfg.timeoutSeconds}s, retrying once`);
        result = await attempt();
      }
      if (this.disposed || gen !== w.generation) return; // superseded
      w.inflight = undefined;

      if (result.ok) {
        this.deps.log.info(
          `generated in ${Date.now() - started}ms via ${binary.source} for ${w.sessionId.slice(0, 8)}`,
        );
        this.deps.ui.showSuggestion(this, w.sessionId, result.suggestion, w.detector.title);
        return;
      }
      switch (result.error) {
        case 'aborted':
          break;
        case 'auth':
          this.authBackoffUntil = Date.now() + AUTH_BACKOFF_MS;
          this.deps.ui.showError(this, 'auth', 'Claude auth failed — click for details');
          this.deps.log.warn(`auth error, backing off 10min: ${result.detail}`);
          break;
        default:
          this.deps.ui.showError(this, 'transient', `suggestion ${result.error}`);
          this.deps.log.warn(`generation ${result.error}: ${result.detail}`);
      }
    } finally {
      this.deps.ui.endBusy();
    }
  }

  regenerate(sessionId?: string): void {
    this.authBackoffUntil = 0;
    let w = sessionId ? this.watchers.get(sessionId) : undefined;
    if (!w) {
      for (const cand of this.watchers.values()) {
        if (cand.lastTurn && (!w || (cand.lastTurnAt ?? 0) > (w.lastTurnAt ?? 0))) w = cand;
      }
    }
    if (w?.lastTurn) void this.startGeneration(w, w.lastTurn);
  }

  onConfigChanged(): void {
    this.scheduleTick();
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.watchers.values()) w.inflight?.abort();
    this.watchers.clear();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    clearInterval(this.fallbackTimer);
    this.dirWatcher?.close();
  }
}
