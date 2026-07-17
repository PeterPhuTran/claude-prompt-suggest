import * as vscode from 'vscode';
import { simulatePaste } from './autoPaste';
import { readConfig } from './config';
import type { Log } from './log';

/** Anything that can own the status bar and be asked to regenerate. */
export interface SuggestionOwner {
  regenerate(): void;
}

type State =
  | { kind: 'hidden' }
  | { kind: 'busy' }
  | { kind: 'suggestion'; text: string }
  | { kind: 'error'; errorKind: 'binary' | 'auth' | 'transient'; message: string };

const TRANSIENT_ERROR_HIDE_MS = 8_000;
const FLASH_MS = 1_500;

/**
 * Single shared status bar item. With multiple workspace-folder controllers,
 * the most recent update wins ownership; accept/dismiss/regenerate route to
 * the current owner.
 */
export class StatusBar {
  private item: vscode.StatusBarItem;
  private state: State = { kind: 'hidden' };
  private timer: NodeJS.Timeout | undefined;
  owner: SuggestionOwner | undefined;

  constructor(private log: Log) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeSuggest.accept';
  }

  showBusy(owner: SuggestionOwner): void {
    this.owner = owner;
    this.setState({ kind: 'busy' });
  }

  showSuggestion(owner: SuggestionOwner, text: string): void {
    this.owner = owner;
    this.setState({ kind: 'suggestion', text });
    if (readConfig().showToast) this.toast(text);
  }

  /**
   * Floating (popped-out) windows have no status bar, so optionally announce
   * the suggestion as a toast too — VS Code shows toasts in the focused
   * window. Toast buttons act on the *current* suggestion; a stale toast that
   * outlived its suggestion pastes the newest one, which is what you'd want.
   */
  private toast(text: string): void {
    void vscode.window
      .showInformationMessage(`💡 ${text}`, 'Paste', 'Dismiss')
      .then((choice) => {
        if (choice === 'Paste') return this.accept();
        if (choice === 'Dismiss') this.dismiss();
        return undefined;
      });
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
      let focused = false;
      try {
        await vscode.commands.executeCommand('claude-vscode.focus');
        focused = true;
      } catch {
        vscode.window.showInformationMessage('Suggestion copied — open the Claude chat and press Ctrl+V.');
      }
      // Simulate the paste keystroke only when focus verifiably landed on the
      // chat input; otherwise we'd paste into whatever is focused.
      let pasted = false;
      if (focused && readConfig().autoPaste) {
        await new Promise((r) => setTimeout(r, 150)); // let the webview take focus
        pasted = await simulatePaste();
        if (!pasted) this.log.info('paste simulation unavailable, clipboard-only fallback');
      }
      this.flashAccepted(pasted);
    } else if (s.kind === 'error' && s.errorKind === 'binary') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSuggest.claudePath');
    } else if (s.kind === 'error' && s.errorKind === 'auth') {
      vscode.window.showWarningMessage(`Claude auth problem: ${s.message} — run \`claude login\` in a terminal.`);
    }
  }

  dismiss(): void {
    this.setState({ kind: 'hidden' });
  }

  private flashAccepted(pasted: boolean): void {
    this.item.text = pasted ? '$(check) Pasted' : '$(check) Copied';
    this.item.tooltip = undefined;
    this.timer = setTimeout(() => this.setState({ kind: 'hidden' }), FLASH_MS);
  }

  private setState(state: State): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.state = state;
    void vscode.commands.executeCommand('setContext', 'claudeSuggest.hasSuggestion', state.kind === 'suggestion');
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
        this.log.info(`suggestion shown: ${state.text}`);
        break;
      }
      case 'error':
        this.item.text = `$(warning) ${truncate(state.message, 40)}`;
        this.item.tooltip = state.message;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
    }
    this.item.show();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.item.dispose();
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
