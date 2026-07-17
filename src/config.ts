import * as vscode from 'vscode';

export interface SuggestConfig {
  enabled: boolean;
  model: string;
  claudePath: string;
  autoPaste: boolean;
  showToast: boolean;
  osNotification: boolean;
  timeoutSeconds: number;
  maxContextMessages: number;
  debounceMs: number;
  entrypointFilter: 'claude-vscode' | 'all';
}

export function readConfig(): SuggestConfig {
  const c = vscode.workspace.getConfiguration('claudeSuggest');
  return {
    enabled: c.get<boolean>('enabled', true),
    model: c.get<string>('model', 'haiku'),
    claudePath: c.get<string>('claudePath', ''),
    autoPaste: c.get<boolean>('autoPaste', true),
    showToast: c.get<boolean>('showToast', false),
    osNotification: c.get<boolean>('osNotification', false),
    timeoutSeconds: Math.min(300, Math.max(10, c.get<number>('timeoutSeconds', 60))),
    maxContextMessages: c.get<number>('maxContextMessages', 8),
    debounceMs: Math.max(100, c.get<number>('debounceMs', 400)),
    entrypointFilter: c.get<'claude-vscode' | 'all'>('entrypointFilter', 'claude-vscode'),
  };
}
