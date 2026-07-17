import * as vscode from 'vscode';

export class Log {
  private channel = vscode.window.createOutputChannel('Claude Prompt Suggest');

  info(msg: string): void {
    this.channel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  warn(msg: string): void {
    this.channel.appendLine(`[${new Date().toISOString()}] WARN ${msg}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
