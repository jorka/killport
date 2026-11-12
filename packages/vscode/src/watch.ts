import * as vscode from 'vscode';
import { probeHttp, shouldProbeHttp } from '@killport/core';
import { getPortLabels } from './labels';
import type { PortStore } from './store';

export interface WatchedPortChange {
  port: number;
  listening: boolean;
}

export function getWatchedPorts(): number[] {
  const raw = vscode.workspace.getConfiguration('killport').get<unknown[]>('watchPorts', []);
  return [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535))];
}

export async function toggleWatchedPort(port: number): Promise<void> {
  const ports = getWatchedPorts();
  const next = ports.includes(port) ? ports.filter((p) => p !== port) : [...ports, port].sort((a, b) => a - b);
  await vscode.workspace.getConfiguration('killport').update('watchPorts', next, vscode.ConfigurationTarget.Global);
}

/**
 * Tracks the watched ports (killport.watchPorts) across refreshes: which are down, and
 * notifications when one stops or starts listening.
 */
export class PortWatcher implements vscode.Disposable {
  private listening?: Set<number>;
  private lastUpdate?: number;
  private readonly emitter = new vscode.EventEmitter<WatchedPortChange>();
  readonly onDidChange = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly store: PortStore,
    private readonly actions: { show: (port: number) => unknown; open: (port: number, scheme: 'http' | 'https') => unknown },
  ) {
    this.sub = store.onDidChange((s) => {
      if (s.loading || s.updatedAt === this.lastUpdate || s.error) return;
      this.lastUpdate = s.updatedAt;
      this.check();
    });
  }

  /** Watched ports and whether each is listening right now. */
  status(): Array<{ port: number; listening: boolean }> {
    const up = new Set(this.store.allEntries.map((e) => e.port));
    return getWatchedPorts().map((port) => ({ port, listening: up.has(port) }));
  }

  /** Watched ports that are not listening. */
  down(): number[] {
    return this.status().filter((s) => !s.listening).map((s) => s.port);
  }

  /** Call when the watch list changes so newly added ports don't trigger notifications. */
  resetBaseline(): void {
    this.listening = undefined;
    this.check();
  }

  private check(): void {
    const now = new Set(this.status().filter((s) => s.listening).map((s) => s.port));
    const before = this.listening;
    this.listening = now;
    if (!before) return; // first look: baseline only, no notifications
    for (const port of getWatchedPorts()) {
      const was = before.has(port);
      const is = now.has(port);
      if (was === is) continue;
      this.emitter.fire({ port, listening: is });
      if (vscode.workspace.getConfiguration('killport').get<boolean>('notifyWatchedPorts', true)) void this.notify(port, is);
    }
  }

  private async notify(port: number, listening: boolean): Promise<void> {
    const label = getPortLabels()[port];
    const name = label ? `Port ${port} (${label})` : `Port ${port}`;
    if (!listening) {
      const choice = await vscode.window.showWarningMessage(`${name} stopped listening.`, 'Show');
      if (choice) this.actions.show(port);
      return;
    }
    const entry = this.store.allEntries.find((e) => e.port === port);
    const scheme = entry && shouldProbeHttp(entry) ? await probeHttp(port, entry.addresses) : undefined;
    const choice = await vscode.window.showInformationMessage(`${name} is up.`, ...(scheme ? ['Open'] : []), 'Show');
    if (choice === 'Open' && scheme) this.actions.open(port, scheme);
    else if (choice === 'Show') this.actions.show(port);
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
