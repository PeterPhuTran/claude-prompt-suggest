import * as vscode from 'vscode';
import { pasteIntoClaudeWindow } from './autoPaste';
import { readConfig } from './config';
import type { Log } from './log';

/** Anything that can own suggestions and be asked to regenerate one. */
export interface SuggestionOwner {
  regenerate(sessionId?: string): void;
}

interface Suggestion {
  sessionId: string;
  text: string;
  /** conversation title = the panel tab's label */
  title?: string;
  at: number;
  owner: SuggestionOwner;
}

type Transient =
  | { kind: 'flash'; pasted: boolean }
  | { kind: 'error'; errorKind: 'binary' | 'auth' | 'transient'; message: string };

const TRANSIENT_ERROR_HIDE_MS = 8_000;
const FLASH_MS = 1_500;

/**
 * Suggestion store + the shared status bar item + the context keys behind the
 * per-tab lightbulb. Suggestions are kept per session, so every open
 * conversation's lightbulb persists independently: accepting or dismissing
 * one only clears that conversation's.
 */
export class StatusBar {
  private item: vscode.StatusBarItem;
  private suggestions = new Map<string, Suggestion>();
  private busy = 0;
  private transient: Transient | undefined;
  private timer: NodeJS.Timeout | undefined;
  private tabListeners: vscode.Disposable[];
  owner: SuggestionOwner | undefined;

  constructor(private log: Log) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeSuggest.accept';
    // The lightbulb is per-tab: re-evaluate whenever the user switches tabs
    // in any window (tab groups span floating windows too).
    this.tabListeners = [
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateTabContext()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateTabContext()),
    ];
  }

  beginBusy(owner: SuggestionOwner): void {
    this.owner = owner;
    this.busy += 1;
    this.render();
  }

  endBusy(): void {
    this.busy = Math.max(0, this.busy - 1);
    this.render();
  }

  /** `title` is the conversation title of the session the suggestion is for. */
  showSuggestion(owner: SuggestionOwner, sessionId: string, text: string, title?: string): void {
    this.owner = owner;
    if (this.transient?.kind === 'error') this.setTransient(undefined);
    this.suggestions.set(sessionId, { sessionId, text, title, at: Date.now(), owner });
    this.log.info(
      `suggestion shown: ${text}${title ? ` [${title}]` : ''} (session ${sessionId.slice(0, 8)}; ${this.suggestions.size} pending)`,
    );
    this.render();
  }

  /** Drop one session's suggestion (its turn moved on); others persist. */
  clearSession(_owner: SuggestionOwner, sessionId: string): void {
    if (this.suggestions.delete(sessionId)) this.render();
  }

  showError(owner: SuggestionOwner, errorKind: 'binary' | 'auth' | 'transient', message: string): void {
    this.owner = owner;
    this.setTransient(
      { kind: 'error', errorKind, message },
      errorKind === 'transient' ? TRANSIENT_ERROR_HIDE_MS : undefined,
    );
    // The status bar doesn't exist in popped-out windows; mirror errors as a
    // toast there too when the user opted into toasts.
    if (readConfig().showToast) {
      const action = errorKind === 'binary' ? 'Open Settings' : 'Retry';
      void vscode.window.showWarningMessage(`Claude Suggest: ${message}`, action).then((choice) => {
        if (choice === 'Retry') this.owner?.regenerate();
        else if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSuggest.claudePath');
        }
      });
    }
  }

  /**
   * Click / keybinding / command entry point. Acts on the suggestion of the
   * conversation tab you're on; falls back to the newest one.
   */
  async accept(): Promise<void> {
    const t = this.transient;
    if (t?.kind === 'error' && t.errorKind === 'binary') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSuggest.claudePath');
      return;
    }
    if (t?.kind === 'error' && t.errorKind === 'auth') {
      vscode.window.showWarningMessage(`Claude auth problem: ${t.message} — run \`claude login\` in a terminal.`);
      return;
    }
    const target = this.resolveTarget();
    if (!target) return;

    await vscode.env.clipboard.writeText(target.text);
    // Copied: clear THIS conversation's indicators now; other tabs' persist.
    this.suggestions.delete(target.sessionId);
    this.setTransient({ kind: 'flash', pasted: false }, FLASH_MS);

    // claude-vscode.focus reveals whichever panel the official extension
    // tracks, which can yank a *different* conversation's tab forward. If
    // the target's own tab is already the active tab somewhere (the
    // lightbulb click case), focus in place instead of revealing anything.
    const inPlace = this.isTabActiveSomewhere(target.title);
    let focused = false;
    try {
      await vscode.commands.executeCommand(
        inPlace ? 'workbench.action.focusActiveEditorGroup' : 'claude-vscode.focus',
      );
      focused = true;
    } catch {
      vscode.window.showInformationMessage('Suggestion copied — open the Claude chat and press Ctrl+V.');
    }
    this.log.info(`focus via ${inPlace ? 'active editor group (tab already visible)' : 'claude-vscode.focus'}`);

    // Paste only when the OS-foreground window verifiably shows the Claude
    // panel (window title check) — focus moving to a webview in a *different*
    // OS window once let the keystroke land in a source file.
    let outcome: 'pasted' | 'skipped' | 'failed' = 'skipped';
    if (focused && readConfig().autoPaste) {
      await new Promise((r) => setTimeout(r, 150)); // let the webview take focus
      const labels = claudePanelTabLabels(target.title);
      outcome = await pasteIntoClaudeWindow(labels);
      this.log.info(`paste outcome: ${outcome} (targets: ${labels.join(' | ') || 'none'})`);
      if (outcome !== 'pasted') {
        vscode.window.showInformationMessage(
          'Suggestion copied — click the Claude chat input and press Ctrl+V.',
        );
      }
    }
    if (this.transient?.kind === 'flash') {
      this.setTransient({ kind: 'flash', pasted: outcome === 'pasted' }, FLASH_MS);
    }
  }

  /** Dismiss the active tab's suggestion (or the newest one). */
  dismiss(): void {
    const target = this.resolveTarget();
    if (target) {
      this.suggestions.delete(target.sessionId);
      this.render();
    } else {
      this.setTransient(undefined);
    }
  }

  /** Regenerate for the active tab's session (or the most recent turn). */
  regenerate(): void {
    const target = this.resolveTarget();
    if (target) target.owner.regenerate(target.sessionId);
    else this.owner?.regenerate();
  }

  /** The active Claude tab's suggestion if it has one, else the newest. */
  private resolveTarget(): Suggestion | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (tab && tab.input instanceof vscode.TabInputWebview && /claude/i.test(tab.input.viewType)) {
      for (const s of this.suggestions.values()) {
        if (s.title && fuzzyTitleMatch(tab.label, s.title)) return s;
      }
    }
    let newest: Suggestion | undefined;
    for (const s of this.suggestions.values()) {
      if (!newest || s.at > newest.at) newest = s;
    }
    return newest;
  }

  /** Is this conversation the active tab in any tab group? */
  private isTabActiveSomewhere(title: string | undefined): boolean {
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.activeTab;
      if (
        tab &&
        tab.input instanceof vscode.TabInputWebview &&
        /claude/i.test(tab.input.viewType) &&
        (!title || fuzzyTitleMatch(tab.label, title))
      ) {
        return true;
      }
    }
    return false;
  }

  private setTransient(t: Transient | undefined, hideAfterMs?: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.transient = t;
    if (t && hideAfterMs) {
      this.timer = setTimeout(() => {
        this.transient = undefined;
        this.timer = undefined;
        this.render();
      }, hideAfterMs);
    }
    this.render();
  }

  private render(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'claudeSuggest.hasSuggestion',
      this.suggestions.size > 0,
    );
    this.updateTabContext();

    const t = this.transient;
    if (t?.kind === 'flash') {
      this.item.text = t.pasted ? '$(check) Pasted' : '$(check) Copied';
      this.item.tooltip = undefined;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    if (t?.kind === 'error') {
      this.item.text = `$(warning) ${truncate(t.message, 40)}`;
      this.item.tooltip = t.message;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.show();
      return;
    }

    let newest: Suggestion | undefined;
    for (const s of this.suggestions.values()) {
      if (!newest || s.at > newest.at) newest = s;
    }
    if (newest) {
      const more = this.suggestions.size - 1;
      this.item.text = `$(lightbulb) ${truncate(newest.text, 60)}${more > 0 ? ` (+${more})` : ''}`;
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown('**Suggested next prompt** *(click to copy & focus chat)*\n\n');
      for (const s of [...this.suggestions.values()].sort((a, b) => b.at - a.at)) {
        tip.appendMarkdown(`\n\n---\n\n${s.title ? `**${s.title}**: ` : ''}`);
        tip.appendText(s.text);
      }
      this.item.tooltip = tip;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    if (this.busy > 0) {
      this.item.text = '$(loading~spin) claude…';
      this.item.tooltip = 'Generating a suggested next prompt';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    this.item.hide();
  }

  /**
   * The tab-bar lightbulb shows on a Claude tab only while that conversation
   * has a pending suggestion. Context keys are global, but editor/title menus
   * only render on each group's *active* tab — so the key is true while any
   * group's active tab is a conversation with a pending suggestion.
   */
  private updateTabContext(): void {
    let active = false;
    const activeClaudeLabels: string[] = [];
    if (this.suggestions.size > 0) {
      for (const group of vscode.window.tabGroups.all) {
        const tab = group.activeTab;
        if (tab && tab.input instanceof vscode.TabInputWebview && /claude/i.test(tab.input.viewType)) {
          activeClaudeLabels.push(tab.label);
          for (const s of this.suggestions.values()) {
            if (!s.title || fuzzyTitleMatch(tab.label, s.title)) {
              active = true;
              break;
            }
          }
        }
      }
      this.log.info(
        `lightbulb ${active ? 'shown' : 'hidden'} (${this.suggestions.size} pending; active claude tabs: ${
          activeClaudeLabels.join(' | ') || 'none'
        })`,
      );
    }
    void vscode.commands.executeCommand('setContext', 'claudeSuggest.suggestionTabActive', active);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const l of this.tabListeners) l.dispose();
    this.item.dispose();
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Strip dirty-markers and truncation ellipses VS Code adds to tab labels. */
function normalizeLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^[●○◐]\s*/, '')
    .replace(/(\.{3}|…)$/, '')
    .trim();
}

/**
 * Tab label ↔ conversation title, tolerant of decorations and truncation
 * (a popped-out tab can render as "Enable suggested prompts…" while the
 * title is "Enable suggested prompts in VS Code extension").
 */
function fuzzyTitleMatch(label: string, title: string): boolean {
  const a = normalizeLabel(label);
  const b = normalizeLabel(title);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a) || b.startsWith(a) || a.startsWith(b);
}

/**
 * Tab labels of open Claude Code webview panels (the tab API sees floating
 * windows too). The label is the conversation title, which is also the
 * hosting window's title — what the paste keystroke needs to find its target.
 * The suggestion's own conversation title goes first so the right window wins.
 */
function claudePanelTabLabels(preferredTitle?: string): string[] {
  const labels: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview && /claude/i.test(tab.input.viewType)) {
        labels.push(tab.label);
      }
    }
  }
  labels.sort((x, y) => {
    if (!preferredTitle) return 0;
    return Number(fuzzyTitleMatch(y, preferredTitle)) - Number(fuzzyTitleMatch(x, preferredTitle));
  });
  if (preferredTitle) labels.unshift(preferredTitle);
  return [...new Set(labels)];
}
