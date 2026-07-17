import * as vscode from 'vscode';
import { pasteIntoClaudeWindow } from './autoPaste';
import { readConfig } from './config';
import type { Log } from './log';

/** Anything that can own the status bar and be asked to regenerate. */
export interface SuggestionOwner {
  regenerate(): void;
}

type State =
  | { kind: 'hidden' }
  | { kind: 'busy' }
  | { kind: 'suggestion'; text: string; title?: string }
  | { kind: 'flash'; pasted: boolean }
  | { kind: 'error'; errorKind: 'binary' | 'auth' | 'transient'; message: string };

const TRANSIENT_ERROR_HIDE_MS = 8_000;
const FLASH_MS = 1_500;

/**
 * Single shared status bar item plus the context keys behind the tab-bar
 * lightbulb. With multiple workspace-folder controllers, the most recent
 * update wins ownership; accept/dismiss/regenerate route to the current owner.
 */
export class StatusBar {
  private item: vscode.StatusBarItem;
  private state: State = { kind: 'hidden' };
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

  showBusy(owner: SuggestionOwner): void {
    this.owner = owner;
    this.setState({ kind: 'busy' });
  }

  /** `title` is the conversation title of the session the suggestion is for. */
  showSuggestion(owner: SuggestionOwner, text: string, title?: string): void {
    this.owner = owner;
    this.setState({ kind: 'suggestion', text, title });
  }

  showError(owner: SuggestionOwner, errorKind: 'binary' | 'auth' | 'transient', message: string): void {
    this.owner = owner;
    this.setState({ kind: 'error', errorKind, message });
    if (errorKind === 'transient') {
      this.timer = setTimeout(() => this.setState({ kind: 'hidden' }), TRANSIENT_ERROR_HIDE_MS);
    }
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

  /** Clear the bar, but only at the request of its current owner. */
  clear(owner: SuggestionOwner): void {
    if (this.owner === owner) this.setState({ kind: 'hidden' });
  }

  /** Click / keybinding / command entry point: behavior depends on current state. */
  async accept(): Promise<void> {
    const s = this.state;
    if (s.kind === 'suggestion') {
      await vscode.env.clipboard.writeText(s.text);
      // Copied: clear every surface now (status bar → flash, lightbulb via
      // context keys) in all windows, before the paste even runs.
      this.setState({ kind: 'flash', pasted: false });
      let focused = false;
      try {
        await vscode.commands.executeCommand('claude-vscode.focus');
        focused = true;
      } catch {
        vscode.window.showInformationMessage('Suggestion copied — open the Claude chat and press Ctrl+V.');
      }
      // Paste only when the OS-foreground window verifiably shows the Claude
      // panel (window title check) — focus moving to a webview in a *different*
      // OS window once let the keystroke land in a source file.
      let outcome: 'pasted' | 'skipped' | 'failed' = 'skipped';
      if (focused && readConfig().autoPaste) {
        await new Promise((r) => setTimeout(r, 150)); // let the webview take focus
        const labels = claudePanelTabLabels(s.title);
        outcome = await pasteIntoClaudeWindow(labels);
        this.log.info(`paste outcome: ${outcome} (targets: ${labels.join(' | ') || 'none'})`);
        if (outcome !== 'pasted') {
          vscode.window.showInformationMessage(
            'Suggestion copied — click the Claude chat input and press Ctrl+V.',
          );
        }
      }
      if (this.state.kind === 'flash') this.setState({ kind: 'flash', pasted: outcome === 'pasted' });
    } else if (s.kind === 'error' && s.errorKind === 'binary') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSuggest.claudePath');
    } else if (s.kind === 'error' && s.errorKind === 'auth') {
      vscode.window.showWarningMessage(`Claude auth problem: ${s.message} — run \`claude login\` in a terminal.`);
    }
  }

  dismiss(): void {
    this.setState({ kind: 'hidden' });
  }

  private setState(state: State): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.state = state;
    void vscode.commands.executeCommand('setContext', 'claudeSuggest.hasSuggestion', state.kind === 'suggestion');
    this.updateTabContext();
    switch (state.kind) {
      case 'hidden':
        this.item.hide();
        return;
      case 'busy':
        this.item.text = '$(loading~spin) claude…';
        this.item.tooltip = 'Generating a suggested next prompt';
        this.item.backgroundColor = undefined;
        break;
      case 'suggestion': {
        this.item.text = `$(lightbulb) ${truncate(state.text, 60)}`;
        const tip = new vscode.MarkdownString();
        tip.appendMarkdown('**Suggested next prompt** *(click to copy & focus chat)*\n\n');
        tip.appendText(state.text);
        this.item.tooltip = tip;
        this.item.backgroundColor = undefined;
        this.log.info(`suggestion shown: ${state.text}${state.title ? ` [${state.title}]` : ''}`);
        break;
      }
      case 'flash':
        this.item.text = state.pasted ? '$(check) Pasted' : '$(check) Copied';
        this.item.tooltip = undefined;
        this.item.backgroundColor = undefined;
        this.timer = setTimeout(() => this.setState({ kind: 'hidden' }), FLASH_MS);
        break;
      case 'error':
        this.item.text = `$(warning) ${truncate(state.message, 40)}`;
        this.item.tooltip = state.message;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
    }
    this.item.show();
  }

  /**
   * The tab-bar lightbulb should only show on the Claude tab the suggestion
   * belongs to. Context keys are global, but editor/title menus only render
   * on each group's *active* tab — so the key is true only while some tab
   * group's active tab is the suggestion's own conversation. Known
   * imperfection: with two Claude tabs active in different groups, a
   * same-titled wrong tab could match; title matching keeps that rare.
   */
  private updateTabContext(): void {
    let active = false;
    if (this.state.kind === 'suggestion') {
      const title = this.state.title;
      for (const group of vscode.window.tabGroups.all) {
        const tab = group.activeTab;
        if (
          tab &&
          tab.input instanceof vscode.TabInputWebview &&
          /claude/i.test(tab.input.viewType) &&
          (!title || fuzzyTitleMatch(tab.label, title))
        ) {
          active = true;
          break;
        }
      }
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

/** Tab label ↔ conversation title, tolerant of decorations and truncation. */
function fuzzyTitleMatch(label: string, title: string): boolean {
  const a = label.trim().toLowerCase();
  const b = title.trim().toLowerCase();
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
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
