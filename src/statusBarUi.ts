import * as vscode from 'vscode';
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
  }

  showError(owner: SuggestionOwner, errorKind: 'binary' | 'auth' | 'transient', message: string): void {
    this.owner = owner;
    this.setState({ kind: 'error', errorKind, message });
    if (errorKind === 'transient') {
      this.timer = setTimeout(() => this.setState({ kind: 'hidden' }), TRANSIENT_ERROR_HIDE_MS);
    }
  }

  /** Clear the bar, but only at the request of its current owner. */
  clear(owner: SuggestionOwner): void {
    if (this.owner === owner) this.setState({ kind: 'hidden' });
  }

  /** Click / command entry point: behavior depends on current state. */
  async accept(): Promise<void> {
    const s = this.state;
    if (s.kind === 'suggestion') {
      await vscode.env.clipboard.writeText(s.text);
      try {
        await vscode.commands.executeCommand('claude-vscode.focus');
      } catch {
        vscode.window.showInformationMessage('Suggestion copied — open the Claude chat and press Ctrl+V.');
      }
      this.flashAccepted();
    } else if (s.kind === 'error' && s.errorKind === 'binary') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSuggest.claudePath');
    } else if (s.kind === 'error' && s.errorKind === 'auth') {
      vscode.window.showWarningMessage(`Claude auth problem: ${s.message} — run \`claude login\` in a terminal.`);
    }
  }

  dismiss(): void {
    this.setState({ kind: 'hidden' });
  }

  private flashAccepted(): void {
    this.item.text = '$(check) Copied';
    this.item.tooltip = undefined;
    this.timer = setTimeout(() => this.setState({ kind: 'hidden' }), FLASH_MS);
  }

  private setState(state: State): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.state = state;
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
