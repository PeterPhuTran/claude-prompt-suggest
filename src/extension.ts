import { mkdir } from 'node:fs/promises';
import * as vscode from 'vscode';
import { discoverClaudeBinary } from './claudeBinary';
import { readConfig } from './config';
import { SuggestController } from './controller';
import { Log } from './log';
import { StatusBar } from './statusBarUi';
import type { ClaudeBinary } from './types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = new Log();
  const ui = new StatusBar(log);
  context.subscriptions.push(log, ui);

  const storageDir = context.globalStorageUri.fsPath;
  await mkdir(storageDir, { recursive: true });

  let binaryPromise: Promise<ClaudeBinary | undefined> | undefined;
  const getBinary = () => {
    binaryPromise ??= (async () => {
      const officialExt = vscode.extensions.getExtension('anthropic.claude-code');
      const binary = await discoverClaudeBinary(
        readConfig().claudePath,
        officialExt ? [officialExt.extensionPath] : [],
      );
      if (binary) log.info(`claude binary: ${binary.path} (${binary.source})`);
      else log.warn('claude binary not found');
      return binary;
    })();
    return binaryPromise;
  };

  const controllers = new Map<string, SuggestController>();
  const deps = { config: readConfig, getBinary, ui, log, storageDir };

  const syncControllers = () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const wanted = new Set(folders.map((f) => f.uri.toString()));
    for (const [key, ctrl] of controllers) {
      if (!wanted.has(key)) {
        ctrl.dispose();
        controllers.delete(key);
      }
    }
    for (const folder of folders) {
      const key = folder.uri.toString();
      if (!controllers.has(key) && folder.uri.scheme === 'file') {
        controllers.set(key, new SuggestController(folder, deps));
      }
    }
  };
  syncControllers();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(syncControllers),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeSuggest')) return;
      binaryPromise = undefined; // re-discover (claudePath may have changed)
      if (!readConfig().enabled) ui.dismiss();
      for (const ctrl of controllers.values()) ctrl.onConfigChanged();
    }),
    vscode.commands.registerCommand('claudeSuggest.showLog', () => log.show()),
    vscode.commands.registerCommand('claudeSuggest.accept', () => ui.accept()),
    vscode.commands.registerCommand('claudeSuggest.dismiss', () => ui.dismiss()),
    vscode.commands.registerCommand('claudeSuggest.regenerate', () => ui.regenerate()),
    vscode.commands.registerCommand('claudeSuggest.toggle', async () => {
      const enabled = readConfig().enabled;
      await vscode.workspace
        .getConfiguration('claudeSuggest')
        .update('enabled', !enabled, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Claude Prompt Suggest: ${enabled ? 'disabled' : 'enabled'}`, 3000);
    }),
    { dispose: () => controllers.forEach((c) => c.dispose()) },
  );

  log.info(`activated (${controllers.size} workspace folder(s))`);
}

export function deactivate(): void {}
