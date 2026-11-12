import * as vscode from 'vscode';
import { isInWorkspace } from './workspaceServers';
import { optionalApi } from './optionalApi';
import { ancestorChain, getParentMap, getProtectedPids, isAppOrSystem, listPorts, parseRange, probeHttp, shouldProbeHttp, type PortEntry } from '@killport/core';

export interface Snapshot {
  entries: PortEntry[];
  protectedPids: number[];
  error?: string;
  loading: boolean;
  updatedAt?: number;
}

/** Holds the latest port list and refreshes it on demand / on an interval. */
export class PortStore implements vscode.Disposable {
  /** Every listening port, before the hideSystemPorts / portRange display filters. */
  private all: PortEntry[] = [];
  /** After the display filters. */
  private entries: PortEntry[] = [];
  private error?: string;
  private loading = false;
  private updatedAt?: number;
  private running?: Promise<void>;
  private rerun?: Promise<void>;
  private protectedPids?: Set<number>;
  private timer?: NodeJS.Timeout;
  private paused = false;
  /** HTTP probe results per process+port: scheme, null (not HTTP) or 'pending'. */
  private readonly httpCache = new Map<string, 'http' | 'https' | null | 'pending'>();
  /** pid of a listening process → the VS Code terminal it was started from. */
  private terminalsByPid = new Map<number, vscode.Terminal>();
  private parentCache?: { at: number; map: Map<number, number> };
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  readonly onDidChange = this.emitter.event;

  get snapshot(): Snapshot {
    return {
      entries: this.entries,
      protectedPids: [...(this.protectedPids ?? [])],
      error: this.error,
      loading: this.loading,
      updatedAt: this.updatedAt,
    };
  }

  /** Every listening port, ignoring display filters (used for watched ports). */
  get allEntries(): PortEntry[] {
    return this.all;
  }

  /** Entries after the panel's "Hide apps & system" and "This workspace" switches. */
  get visibleEntries(): PortEntry[] {
    const f = viewFilters();
    return this.entries.filter((e) => !(f.hideApps && isAppOrSystem(e)) && !(f.workspaceOnly && !isInWorkspace(e.cwd)));
  }

  /** How many ports each switch is hiding right now (for the "N hidden · Show" note). */
  get hiddenCounts(): { apps: number; otherFolders: number } {
    const f = viewFilters();
    const apps = f.hideApps ? this.entries.filter((e) => isAppOrSystem(e)) : [];
    const rest = this.entries.filter((e) => !apps.includes(e));
    return { apps: apps.length, otherFolders: f.workspaceOnly ? rest.filter((e) => !isInWorkspace(e.cwd)).length : 0 };
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Our own process tree (the VS Code extension host and its ancestors). */
  async getProtected(): Promise<Set<number>> {
    this.protectedPids ??= await getProtectedPids(process.pid);
    return this.protectedPids;
  }

  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.doRefresh().finally(() => (this.running = undefined));
      return this.running;
    }
    // A refresh is already running, but it may have started before the caller's change (e.g. a server
    // that was just launched). Run exactly one more after it; concurrent callers share that rerun.
    this.rerun ??= this.running.then(() => {
      this.rerun = undefined;
      return this.refresh();
    });
    return this.rerun;
  }

  private async doRefresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('killport');
    this.loading = true;
    this.emitter.fire(this.snapshot);
    try {
      const [entries] = await Promise.all([
        listPorts(),
        this.getProtected(),
      ]);
      this.all = entries;
      const hideSystem = cfg.get<boolean>('hideSystemPorts', false);
      const inRange = parseRange(cfg.get<string>('portRange', ''));
      this.entries = entries.filter((e) => !(hideSystem && e.port < 1024) && (!inRange || inRange(e.port)));
      this.error = undefined;
      this.applyHttp(entries);
      await this.matchTerminals(entries);
      void this.probeNewPorts(entries);
    } catch (err) {
      this.error = `Could not list ports: ${(err as Error).message}`;
    } finally {
      this.loading = false;
      this.updatedAt = Date.now();
      this.emitter.fire(this.snapshot);
    }
  }

  /** The VS Code terminal a listening process was started from, if any. */
  terminalFor(e: PortEntry): vscode.Terminal | undefined {
    return this.terminalsByPid.get(e.pid);
  }

  /**
   * Finds, for each listening process, the VS Code terminal whose shell is one of its ancestors.
   * Parent lookups are cheap with ps (every refresh) but slow on Windows (PowerShell), so cached there.
   */
  private async matchTerminals(entries: PortEntry[]): Promise<void> {
    this.terminalsByPid = new Map();
    const terminals = vscode.window.terminals;
    const candidates = entries.filter((e) => !e.container && e.pid > 0);
    if (terminals.length === 0 || candidates.length === 0) return;
    const shells = new Map<number, vscode.Terminal>();
    await Promise.all(
      terminals.map(async (t) => {
        const pid = await Promise.race([t.processId, new Promise<undefined>((r) => setTimeout(() => r(undefined), 500))]);
        if (pid) shells.set(pid, t);
      }),
    );
    if (shells.size === 0) return;
    const maxAge = process.platform === 'win32' ? 15_000 : 0;
    const cached = this.parentCache;
    const fresh = cached && Date.now() - cached.at <= maxAge && candidates.every((e) => cached.map.has(e.pid)); // new processes force a refresh
    const parents = fresh ? cached.map : await getParentMap();
    if (!fresh) this.parentCache = { at: Date.now(), map: parents };
    for (const e of candidates) {
      for (const pid of ancestorChain(e.pid, parents)) {
        const t = shells.get(pid);
        if (t) {
          this.terminalsByPid.set(e.pid, t);
          e.terminal = t.name;
          if (!e.cwd) {
            const cwd = terminalCwd(t);
            if (cwd) {
              e.cwd = cwd;
              e.cwdGuessed = true;
            }
          }
          break;
        }
      }
    }
  }

  private static httpKey(e: PortEntry): string {
    return e.container ? `c:${e.container.id}:${e.port}` : `p:${e.pid}:${e.port}`;
  }

  private applyHttp(entries: PortEntry[]): void {
    for (const e of entries) {
      const v = this.httpCache.get(PortStore.httpKey(e));
      e.http = v === 'http' || v === 'https' ? v : undefined;
    }
  }

  /** Probes each new process/port once (4 at a time), then re-renders with the "open in browser" links. */
  private async probeNewPorts(entries: PortEntry[]): Promise<void> {
    const todo = entries.filter((e) => !this.httpCache.has(PortStore.httpKey(e)) && shouldProbeHttp(e));
    if (todo.length === 0) return;
    for (const e of todo) this.httpCache.set(PortStore.httpKey(e), 'pending');
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(
        todo.slice(i, i + 4).map(async (e) => this.httpCache.set(PortStore.httpKey(e), (await probeHttp(e.port, e.addresses)) ?? null)),
      );
    }
    if (this.httpCache.size > 2000) this.httpCache.clear(); // processes come and go; keep it bounded
    this.applyHttp(this.entries);
    this.emitter.fire(this.snapshot);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.restartTimer();
  }

  restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const seconds = vscode.workspace.getConfiguration('killport').get<number>('autoRefreshInterval', 5);
    if (this.paused || !seconds || seconds <= 0) return;
    this.timer = setInterval(() => {
      if (vscode.window.state.focused) void this.refresh();
    }, Math.max(1, seconds) * 1000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.emitter.dispose();
  }
}

/** Where ports are being scanned, for remote windows: "WSL", "SSH", "Dev Container"... undefined when local. */
export function remoteHostLabel(): string | undefined {
  const name = vscode.env.remoteName;
  if (!name) return undefined;
  const known: Record<string, string> = {
    wsl: 'WSL',
    'ssh-remote': 'SSH',
    'dev-container': 'Dev Container',
    'attached-container': 'Container',
    codespaces: 'Codespaces',
    tunnel: 'Tunnel',
  };
  return known[name] ?? name;
}

/** The panel's view switches. "This workspace" does nothing when no folder is open. */
export function viewFilters(): { hideApps: boolean; workspaceOnly: boolean; hasWorkspace: boolean } {
  const cfg = vscode.workspace.getConfiguration('killport');
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  return {
    hideApps: cfg.get<boolean>('hideAppsAndSystem', true),
    workspaceOnly: hasWorkspace && cfg.get<boolean>('workspaceOnly', false),
    hasWorkspace,
  };
}

/** The folder a terminal is in: from shell integration (follows `cd`), else the folder it was opened in. */
function terminalCwd(t: vscode.Terminal): string | undefined {
  const live = optionalApi(() => (t as unknown as { shellIntegration?: { cwd?: vscode.Uri } }).shellIntegration?.cwd?.fsPath);
  if (live) return live;
  const opened = (t.creationOptions as vscode.TerminalOptions).cwd;
  if (typeof opened === 'string') return opened;
  return opened?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
