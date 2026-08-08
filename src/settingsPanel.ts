import * as vscode from 'vscode';

interface PropertySchema {
  type?: string | string[];
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  enum?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
}

interface ConfigContribution {
  title?: string;
  properties?: Record<string, PropertySchema>;
}

interface ManifestShape {
  name: string;
  displayName?: string;
  version?: string;
  publisher?: string;
  contributes?: { configuration?: ConfigContribution | ConfigContribution[] };
}

interface SettingItem {
  key: string;
  label: string;
  description: string;
  kind: 'boolean' | 'number' | 'enum' | 'string';
  enumValues: string[] | undefined;
  enumDescriptions: string[] | undefined;
  minimum: number | undefined;
  maximum: number | undefined;
  defaultValue: unknown;
  value: unknown;
  modified: boolean;
  workspaceShadow: boolean;
}

/**
 * Settings editor webview generated from this extension's own
 * `contributes.configuration` manifest — new settings appear here without code
 * changes. Reads effective values; writes go to the user (global) target.
 */
export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private seq = 0;
  private readonly manifest: ManifestShape;
  private readonly properties: Record<string, PropertySchema> = {};

  constructor(context: vscode.ExtensionContext) {
    this.manifest = context.extension.packageJSON as ManifestShape;
    const contrib = this.manifest.contributes?.configuration;
    for (const c of Array.isArray(contrib) ? contrib : contrib ? [contrib] : []) {
      Object.assign(this.properties, c.properties ?? {});
    }
  }

  /** Opens in the active editor group — the focused window (floating or main) gets the tab. */
  open(focus = true): void {
    if (this.panel) {
      this.panel.reveal(undefined, !focus);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      `${this.manifest.name}.settings`,
      `${this.manifest.displayName ?? this.manifest.name} Settings`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: !focus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (this.sections().some((s) => e.affectsConfiguration(s))) this.pushState();
    });
    this.panel.onDidDispose(() => {
      cfgListener.dispose();
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((msg: { type?: string; key?: string; value?: unknown }) => {
      void this.onMessage(msg);
    });
    this.panel.webview.html = this.html();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private sections(): string[] {
    return [...new Set(Object.keys(this.properties).map((k) => k.split('.')[0] ?? k))];
  }

  private buildItems(): SettingItem[] {
    const cfg = vscode.workspace.getConfiguration();
    return Object.entries(this.properties).map(([key, prop]) => {
      const insp = cfg.inspect(key);
      const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
      const kind: SettingItem['kind'] = prop.enum
        ? 'enum'
        : type === 'boolean'
          ? 'boolean'
          : type === 'number' || type === 'integer'
            ? 'number'
            : 'string';
      return {
        key,
        label: humanize(key),
        description: prop.description ?? prop.markdownDescription ?? '',
        kind,
        enumValues: prop.enum,
        enumDescriptions: prop.enumDescriptions,
        minimum: prop.minimum,
        maximum: prop.maximum,
        defaultValue: insp?.defaultValue ?? prop.default,
        value: cfg.get(key),
        modified: insp?.globalValue !== undefined,
        workspaceShadow: insp?.workspaceValue !== undefined || insp?.workspaceFolderValue !== undefined,
      };
    });
  }

  private async onMessage(msg: { type?: string; key?: string; value?: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.pushState();
        break;
      case 'update': {
        const key = msg.key ?? '';
        const prop = this.properties[key];
        if (!prop) return;
        let value = msg.value;
        const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
        if (type === 'number' || type === 'integer') {
          let n = Number(value);
          if (!Number.isFinite(n)) {
            this.pushState(); // revert the input to the stored value
            return;
          }
          if (type === 'integer') n = Math.round(n);
          if (prop.minimum !== undefined) n = Math.max(prop.minimum, n);
          if (prop.maximum !== undefined) n = Math.min(prop.maximum, n);
          value = n;
        }
        await vscode.workspace
          .getConfiguration()
          .update(key, value, vscode.ConfigurationTarget.Global)
          .then(undefined, () => undefined);
        this.pushState();
        break;
      }
      case 'reset':
        if (msg.key && this.properties[msg.key]) {
          await vscode.workspace
            .getConfiguration()
            .update(msg.key, undefined, vscode.ConfigurationTarget.Global)
            .then(undefined, () => undefined);
          this.pushState();
        }
        break;
      case 'openNative':
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          `@ext:${this.manifest.publisher}.${this.manifest.name}`,
        );
        break;
      case 'openJson':
        void vscode.commands.executeCommand('workbench.action.openSettingsJson');
        break;
    }
  }

  private pushState(): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ type: 'state', items: this.buildItems() });
  }

  private html(): string {
    const nonce = `n${(this.seq += 1)}${Date.now().toString(36)}`;
    const title = escHtml(this.manifest.displayName ?? this.manifest.name);
    const version = escHtml(this.manifest.version ?? '');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    margin: 0 auto;
    max-width: 760px;
    padding: 0 16px 40px;
  }
  header {
    position: sticky; top: 0; z-index: 2;
    background: var(--vscode-editor-background);
    display: flex; align-items: baseline; gap: 10px;
    padding: 12px 0 10px;
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.25));
  }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  header .ver { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
  header .links { margin-left: auto; font-size: 11.5px; display: flex; gap: 12px; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  .hint { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin: 10px 2px 4px; }
  .row { padding: 12px 14px 14px; margin: 4px 0; border-left: 3px solid transparent; border-radius: 4px; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.06)); }
  .row.modified { border-left-color: var(--vscode-settings-modifiedItemIndicator, #0c7d9d); }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .label { font-weight: 600; font-size: 13px; }
  .key { font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .reset { margin-left: auto; font-size: 11.5px; visibility: hidden; flex: none; }
  .desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 8px; line-height: 1.45; max-width: 640px; }
  input[type="text"], input[type="number"], select {
    background: var(--vscode-settings-textInputBackground, var(--vscode-input-background, rgba(128,128,128,.1)));
    color: var(--vscode-settings-textInputForeground, var(--vscode-input-foreground, inherit));
    border: 1px solid var(--vscode-settings-textInputBorder, var(--vscode-input-border, rgba(128,128,128,.35)));
    border-radius: 2px; padding: 3px 7px; font-family: inherit; font-size: 12.5px;
  }
  select {
    background: var(--vscode-settings-dropdownBackground, var(--vscode-dropdown-background, rgba(128,128,128,.1)));
    color: var(--vscode-settings-dropdownForeground, var(--vscode-dropdown-foreground, inherit));
    border-color: var(--vscode-settings-dropdownBorder, var(--vscode-dropdown-border, rgba(128,128,128,.35)));
  }
  .ctrl input[type="text"] { width: 360px; max-width: 100%; }
  .ctrl input[type="number"] { width: 110px; }
  :focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .check { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; cursor: pointer; user-select: none; }
  input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--vscode-button-background, #0e639c); }
  .state-text { color: var(--vscode-descriptionForeground); }
  .shadow { display: none; font-size: 11.5px; color: var(--vscode-editorWarning-foreground, #cca700); margin-top: 6px; }
  .empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 40px 0; }
</style>
</head>
<body>
<header>
  <h1>${title} Settings</h1>
  <span class="ver">v${version}</span>
  <span class="links"><a id="openNative" title="Open the native VS Code settings UI filtered to this extension">Settings UI</a><a id="openJson" title="Open user settings.json">settings.json</a></span>
</header>
<div class="hint">Changes save immediately to your user settings. Modified values show a colored bar and a Reset link.</div>
<div id="list"><div class="empty">Loading settings…</div></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const listEl = document.getElementById('list');
const rows = new Map();
document.getElementById('openNative').addEventListener('click', () => vs.postMessage({ type: 'openNative' }));
document.getElementById('openJson').addEventListener('click', () => vs.postMessage({ type: 'openJson' }));
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.type === 'state') sync(m.items);
});

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function sync(items) {
  if (rows.size === 0) listEl.textContent = '';
  for (const it of items) {
    let r = rows.get(it.key);
    if (!r) { r = buildRow(it); rows.set(it.key, r); listEl.appendChild(r.rowEl); }
    updateRow(r, it);
  }
}

function commit(key, value) { vs.postMessage({ type: 'update', key: key, value: value }); }

function buildControl(it, r) {
  if (it.kind === 'boolean') {
    const label = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    const st = el('span', 'state-text');
    cb.addEventListener('change', () => commit(it.key, cb.checked));
    label.append(cb, st);
    r.input = cb;
    r.stateText = st;
    return label;
  }
  if (it.kind === 'enum') {
    const sel = el('select');
    (it.enumValues || []).forEach((v, i) => {
      const o = el('option', '', v);
      o.value = v;
      if (it.enumDescriptions && it.enumDescriptions[i]) o.title = it.enumDescriptions[i];
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => commit(it.key, sel.value));
    r.input = sel;
    return sel;
  }
  const inp = el('input');
  inp.type = it.kind === 'number' ? 'number' : 'text';
  if (it.kind === 'number') {
    if (it.minimum !== undefined && it.minimum !== null) inp.min = String(it.minimum);
    if (it.maximum !== undefined && it.maximum !== null) inp.max = String(it.maximum);
  } else if (it.defaultValue) {
    inp.placeholder = String(it.defaultValue);
  }
  inp.addEventListener('change', () => commit(it.key, it.kind === 'number' ? Number(inp.value) : inp.value));
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); });
  r.input = inp;
  return inp;
}

function buildRow(it) {
  const r = { kind: it.kind };
  const rowEl = el('div', 'row');
  const head = el('div', 'head');
  head.append(el('span', 'label', it.label), el('code', 'key', it.key));
  const reset = el('a', 'reset', 'Reset');
  reset.addEventListener('click', (ev) => { ev.preventDefault(); vs.postMessage({ type: 'reset', key: it.key }); });
  head.appendChild(reset);
  rowEl.appendChild(head);
  if (it.description) rowEl.appendChild(el('div', 'desc', it.description));
  const ctrl = el('div', 'ctrl');
  ctrl.appendChild(buildControl(it, r));
  rowEl.appendChild(ctrl);
  const shadow = el('div', 'shadow', 'Note: a workspace-level setting currently overrides this user value.');
  rowEl.appendChild(shadow);
  r.rowEl = rowEl;
  r.resetEl = reset;
  r.shadowEl = shadow;
  return r;
}

function updateRow(r, it) {
  if (document.activeElement !== r.input) {
    if (r.kind === 'boolean') r.input.checked = !!it.value;
    else r.input.value = it.value === undefined || it.value === null ? '' : String(it.value);
  }
  if (r.stateText) r.stateText.textContent = it.value ? 'On' : 'Off';
  r.rowEl.classList.toggle('modified', !!it.modified);
  r.resetEl.style.visibility = it.modified ? 'visible' : 'hidden';
  r.resetEl.title = 'Reset to default: ' + JSON.stringify(it.defaultValue);
  r.shadowEl.style.display = it.workspaceShadow ? '' : 'none';
}

vs.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function humanize(key: string): string {
  const last = key.split('.').pop() ?? key;
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
