import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { remoteHostLabel, viewFilters, type PortStore, type Snapshot } from './store';
import { findSharedPorts } from '@killport/core';
import { killEntry, killMany } from './kill';
import { editPortLabel, getPortLabels } from './labels';
import { workspaceRoots } from './workspaceServers';
import { toggleWatchedPort, type PortWatcher } from './watch';

type FromWebview =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'kill'; pid: number; port: number; force?: boolean }
  | { type: 'killMany'; items: Array<{ pid: number; port: number }>; force?: boolean }
  | { type: 'editLabel'; port: number }
  | { type: 'open'; port: number; scheme: 'http' | 'https'; host?: string }
  | { type: 'showTerminal'; pid: number; port: number }
  | { type: 'toggleWatch'; port: number }
  | { type: 'switchPort'; port: number; pid?: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'setFilter'; key: 'hideAppsAndSystem' | 'workspaceOnly'; value: boolean }
  | { type: 'openFolder'; cwd: string }
  | { type: 'copy'; text: string };

export class PortsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'killport.portsView';
  private view?: vscode.WebviewView;
  /** Set by activate(); provides the watched-ports status for the panel. */
  watcher?: PortWatcher;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: PortStore,
  ) {
    store.onDidChange((s) => this.post(s));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);

    view.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.store.refresh();
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Opens the panel filtered to one port (used by the terminal "port in use" prompt). */
  async showPort(port: number): Promise<void> {
    await vscode.commands.executeCommand(`${PortsViewProvider.viewId}.focus`);
    await this.store.refresh();
    void this.view?.webview.postMessage({ type: 'filter', text: `:${port}` });
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post(this.store.snapshot);
        void this.store.refresh();
        break;
      case 'refresh':
        void this.store.refresh();
        break;
      case 'kill': {
        const entry = this.store.snapshot.entries.find((e) => e.pid === msg.pid && e.port === msg.port);
        if (entry) await killEntry(this.store, entry, { force: msg.force });
        break;
      }
      case 'killMany': {
        const keys = new Set(msg.items.map((i) => `${i.port}:${i.pid}`));
        const entries = this.store.snapshot.entries.filter((e) => keys.has(`${e.port}:${e.pid}`));
        await killMany(this.store, entries, msg.force);
        break;
      }
      case 'showTerminal': {
        const entry = this.store.snapshot.entries.find((e) => e.pid === msg.pid && e.port === msg.port);
        const terminal = entry && this.store.terminalFor(entry);
        if (terminal) terminal.show();
        else void vscode.window.showInformationMessage('That terminal is no longer open.');
        break;
      }
      case 'switchPort':
        await vscode.commands.executeCommand('killport.switchPort', msg.port, undefined, { pid: msg.pid });
        break;
      case 'toggleWatch':
        await toggleWatchedPort(msg.port); // setting change re-renders
        break;
      case 'open':
        await openInBrowser(msg.port, msg.scheme, msg.host === '127.0.0.1' ? '127.0.0.1' : 'localhost');
        break;
      case 'editLabel':
        await editPortLabel(msg.port); // saving the setting re-renders via onDidChangeConfiguration
        break;
      case 'pause':
        this.store.setPaused(msg.paused);
        this.post(this.store.snapshot);
        break;
      case 'setFilter':
        // Saving the setting triggers onDidChangeConfiguration → refresh → re-render.
        await vscode.workspace.getConfiguration('killport').update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        break;
      case 'openFolder':
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.cwd));
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage('$(copy) Copied', 2000);
        break;
    }
  }

  private post(s: Snapshot): void {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'data',
      ...s,
      paused: this.store.isPaused,
      labels: getPortLabels(),
      watched: this.watcher?.status() ?? [],
      host: remoteHostLabel(),
      // Ports where one program is on IPv4 and another on IPv6 (localhost vs 127.0.0.1 reach different apps).
      shared: findSharedPorts(s.entries).map((x) => ({ port: x.port, ipv4: x.ipv4.map((e) => e.pid), ipv6: x.ipv6.map((e) => e.pid) })),
      // The panel shows what its switches leave visible; shared-port info still uses everything.
      entries: this.store.visibleEntries,
      hidden: this.store.hiddenCounts,
      filters: viewFilters(),
      workspaceRoots: workspaceRoots(),
      platform: process.platform,
      home: homedir(),
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Killport</title>
</head>
<body>
  <header class="toolbar">
    <input id="filter" type="search" placeholder="Filter by port, process, command or folder…" aria-label="Filter ports">
    <label class="toggle" title="Hide desktop apps (Discord, Chrome, VS Code's own helpers…), OS services and editor/agent helpers. Docker containers and your servers stay."><input id="hide-apps" type="checkbox" checked> Hide apps &amp; system</label>
    <label class="toggle" id="workspace-toggle" title="Only servers started from the folder open in this window"><input id="workspace-only" type="checkbox"> This workspace</label>
    <label class="toggle" title="Refresh automatically"><input id="auto" type="checkbox" checked> Auto-refresh</label>
    <button id="kill-selected" class="kill danger" type="button" hidden title="Kill every selected port. Shift+click to force kill."></button>
    <span id="status" class="status" aria-live="polite"></span>
  </header>
  <div id="error" class="error" hidden></div>
  <table>
    <thead>
      <tr>
        <th class="c-sel"><input id="select-all" type="checkbox" title="Select all visible ports" aria-label="Select all visible ports"></th>
        <th class="c-port" data-sort="port"><button type="button" class="sort">Port</button></th>
        <th class="c-proc" data-sort="process"><button type="button" class="sort">Process</button></th>
        <th class="c-pid" data-sort="pid"><button type="button" class="sort">PID</button></th>
        <th class="c-addr" data-sort="addr"><button type="button" class="sort">Address</button></th>
        <th class="c-up" data-sort="uptime"><button type="button" class="sort" title="How long the process has been running">Uptime</button></th>
        <th class="c-mem" data-sort="memory"><button type="button" class="sort" title="Memory (and CPU when busy)">Memory</button></th>
        <th class="c-where" data-sort="where"><button type="button" class="sort">Folder / Command</button></th>
        <th class="c-act"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <p id="empty" class="empty" hidden></p>
  <p id="hidden-note" class="hidden-note" hidden></p>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** Opens http(s)://localhost:<port> in the browser or VS Code's Simple Browser (killport.openBrowserIn). */
export async function openInBrowser(port: number, scheme: 'http' | 'https' = 'http', host = 'localhost'): Promise<void> {
  const url = `${scheme}://${host}:${port}`;
  if (vscode.workspace.getConfiguration('killport').get<string>('openBrowserIn', 'external') === 'simpleBrowser') {
    try {
      await vscode.commands.executeCommand('simpleBrowser.show', url);
      return;
    } catch {
      /* Simple Browser not available (e.g. some forks): fall back to the system browser */
    }
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}
