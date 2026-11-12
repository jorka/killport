import * as vscode from 'vscode';
import { findSharedPorts, type PortEntry } from '@killport/core';
import { getPortLabels } from './labels';
import type { PortStore } from './store';

const who = (e: PortEntry) => {
  const name = e.container ? `container ${e.container.name}` : e.processName;
  const dir = e.cwd ? ` (${e.cwd.split(/[\\/]/).filter(Boolean).pop()})` : '';
  return `${name}${dir}`;
};

/**
 * Warns once per conflict when two programs share a port on different IP families: nothing fails,
 * but localhost:<port> and 127.0.0.1:<port> reach different apps, which is very confusing.
 */
export function registerSharedPortWarning(
  ctx: vscode.ExtensionContext,
  store: PortStore,
  actions: { show: (port: number) => unknown; move: (port: number, pid: number) => unknown },
): void {
  const warned = new Set<string>();
  ctx.subscriptions.push(
    store.onDidChange((s) => {
      if (s.loading || s.error) return;
      if (!vscode.workspace.getConfiguration('killport').get<boolean>('warnSharedPorts', true)) return;
      for (const shared of findSharedPorts(store.allEntries)) {
        const key = `${shared.port}|${[...shared.ipv4, ...shared.ipv6].map((e) => e.pid).sort().join(',')}`;
        if (warned.has(key)) continue;
        warned.add(key);
        void warn(shared.port, shared.ipv4[0], shared.ipv6[0]);
      }
    }),
  );

  async function warn(port: number, v4: PortEntry, v6: PortEntry): Promise<void> {
    const label = getPortLabels()[port];
    const choice = await vscode.window.showWarningMessage(
      `Port ${port}${label ? ` (${label})` : ''} is used by two programs: ${who(v6)} on IPv6 and ${who(v4)} on IPv4. ` +
        `localhost:${port} opens ${who(v6)}, 127.0.0.1:${port} opens ${who(v4)}.`,
      'Move one…',
      'Show',
    );
    if (choice === 'Show') actions.show(port);
    if (choice === 'Move one…') {
      const pick = await vscode.window.showQuickPick(
        [
          { label: who(v4), description: `IPv4 · pid ${v4.pid}`, detail: v4.cwd, pid: v4.pid },
          { label: who(v6), description: `IPv6 · pid ${v6.pid}`, detail: v6.cwd, pid: v6.pid },
        ],
        { placeHolder: `Which one should move off port ${port}?` },
      );
      if (pick) actions.move(port, pick.pid);
    }
  }
}
