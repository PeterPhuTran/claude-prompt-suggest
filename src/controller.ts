import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { SuggestConfig } from './config';
import type { Log } from './log';
import type { StatusBar } from './statusBarUi';
import type { ClaudeBinary, TurnCompleteEvent } from './types';
import { claudeHome, pickActiveSession, projectDir } from './sessionLocator';
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

/** Watches one workspace folder's Claude project dir and drives suggestions. */
export class SuggestController {
  private dirWatcher: fs.FSWatcher | undefined;
  private watchedDir: string | undefined;
  private fallbackTimer: NodeJS.Timeout;
  private debounceTimer: NodeJS.Timeout | undefined;

  private tailer: TranscriptTailer | undefined;
  private detector: TurnDetector | undefined;

  private generation = 0;
  private inflight: AbortController | undefined;
  private lastTurn: TurnCompleteEvent | undefined;
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

    const session = await pickActiveSession(this.cwd, cfg.entrypointFilter);
    if (!session) return;

    if (!this.tailer || this.tailer.filePath !== session.jsonlPath) {
      this.deps.log.info(`session: ${session.sessionId} (${session.entrypoint ?? 'entrypoint from transcript'})`);
      this.abortInflight();
      this.tailer = new TranscriptTailer(session.jsonlPath, {
        onParseError: (err) => this.deps.log.warn(`transcript parse error: ${err}`),
      });
      this.detector = new TurnDetector(session.sessionId, { maxContext: cfg.maxContextMessages });
      let lines;
      try {
        lines = await this.tailer.bootstrap();
      } catch (err) {
        this.deps.log.warn(`bootstrap failed, retrying next event: ${err}`);
        this.tailer = undefined;
        return;
      }
      this.detector.bootstrap(lines);
      return; // historical turns never fire; wait for new appends
    }

    let lines;
    try {
      lines = await this.tailer.poll();
    } catch (err) {
      this.deps.log.warn(`poll failed: ${err}`);
      return;
    }
    if (lines.length === 0) return;

    for (const event of this.detector!.ingest(lines)) {
      if (event.kind === 'user-message') {
        this.abortInflight();
        this.deps.ui.clear(this);
      } else {
        void this.startGeneration(event);
      }
    }
  }

  private async startGeneration(event: TurnCompleteEvent): Promise<void> {
    const cfg = this.deps.config();
    if (
      cfg.entrypointFilter !== 'all' &&
      this.detector?.entrypoint &&
      this.detector.entrypoint !== cfg.entrypointFilter
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

    this.abortInflight();
    const ac = new AbortController();
    this.inflight = ac;
    const gen = ++this.generation;
    this.lastTurn = event;
    this.deps.ui.showBusy(this);

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
    if (!result.ok && result.error === 'timeout' && !this.disposed && gen === this.generation) {
      // first spawn after a Claude update can be slow (AV scans the new binary)
      this.deps.log.warn(`timeout after ${cfg.timeoutSeconds}s, retrying once`);
      result = await attempt();
    }
    if (this.disposed || gen !== this.generation) return; // superseded
    this.inflight = undefined;

    if (result.ok) {
      this.deps.log.info(`generated in ${Date.now() - started}ms via ${binary.source}`);
      this.deps.ui.showSuggestion(this, result.suggestion);
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
  }

  regenerate(): void {
    this.authBackoffUntil = 0;
    if (this.lastTurn) void this.startGeneration(this.lastTurn);
  }

  onConfigChanged(): void {
    this.scheduleTick();
  }

  private abortInflight(): void {
    this.inflight?.abort();
    this.inflight = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.abortInflight();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    clearInterval(this.fallbackTimer);
    this.dirWatcher?.close();
  }
}
