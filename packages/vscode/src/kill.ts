import * as vscode from 'vscode';
import { RUNTIME_REFUSAL, stopEntry, type PortEntry } from '@killport/core';
import type { PortStore } from './store';

export function entryLabel(e: PortEntry): string {
  if (e.container) return `container ${e.container.name} on port ${e.port}`;
  return `${e.processName} (pid ${e.pid}) on port ${e.port}`;
}

export interface KillEntryOptions {
  force?: boolean;
  /** Skip the confirmation dialog (the user already chose "Kill" somewhere else). */
  skipConfirm?: boolean;
}

/**
 * Asks for confirmation (if enabled), stops the process or container and refreshes the list.
 * Returns true when it is gone.
 */
export async function killEntry(store: PortStore, entry: PortEntry, opts: KillEntryOptions = {}): Promise<boolean> {
  let force = !!opts.force;
  const label = entryLabel(entry);
  const verb = entry.container ? 'Stop' : 'Kill';

  if (entry.isContainerRuntime) {
    void vscode.window.showErrorMessage(`Port ${entry.port}: ${RUNTIME_REFUSAL}`);
    return false;
  }
  if (!entry.container && !entry.pid) {
    void vscode.window.showErrorMessage(`Cannot kill port ${entry.port}: the owning process is not visible (it probably belongs to another user or root).`);
    return false;
  }
  const protectedPids = await store.getProtected();
  if (!entry.container && protectedPids.has(entry.pid)) {
    void vscode.window.showErrorMessage(`Refusing to kill ${label}: that is VS Code itself or a system process.`);
    return false;
  }

  if (!opts.skipConfirm && vscode.workspace.getConfiguration('killport').get<boolean>('confirmBeforeKill', true)) {
    const c = entry.container;
    const detail = c
      ? [`Image: ${c.image}`, c.composeProject && `Compose: ${c.composeProject} / ${c.composeService ?? '?'}`, `Runs: docker ${force ? 'kill' : 'stop'} ${c.id}`].filter(Boolean).join('\n')
      : [entry.command, entry.cwd && `Directory: ${entry.cwd}`].filter(Boolean).join('\n\n');
    const forceLabel = `Force ${verb}`;
    const choice = await vscode.window.showWarningMessage(`${verb} ${label}?`, { modal: true, detail }, force ? forceLabel : verb, ...(force ? [] : [forceLabel]));
    if (!choice) return false;
    force = choice === forceLabel;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `${verb === 'Stop' ? 'Stopping' : 'Killing'} ${label}…` },
    () => stopEntry(entry, { force, protectedPids }),
  );
  await store.refresh();

  if (result.ok) {
    vscode.window.setStatusBarMessage(`$(check) ${verb === 'Stop' ? 'Stopped' : 'Killed'} ${label}`, 4000);
    return true;
  }
  if (result.code === 'STILL_RUNNING' && !force) {
    const again = await vscode.window.showWarningMessage(`${label} is still running.`, `Force ${verb}`);
    return again ? killEntry(store, entry, { force: true, skipConfirm: true }) : false;
  }
  void vscode.window.showErrorMessage(`Could not ${verb.toLowerCase()} ${label}: ${result.error}`);
  return false;
}

/** Kills / stops several entries after a single confirmation. Protected ones are skipped and reported. */
export async function killMany(store: PortStore, entries: PortEntry[], force = false, skipConfirm = false): Promise<void> {
  if (entries.length === 0) return;
  if (entries.length === 1) {
    await killEntry(store, entries[0], { force, skipConfirm });
    return;
  }
  const protectedPids = await store.getProtected();
  const blocked = (e: PortEntry) => e.isContainerRuntime || (!e.container && (!e.pid || protectedPids.has(e.pid)));
  const targets = entries.filter((e) => !blocked(e));
  const skipped = entries.length - targets.length;
  if (targets.length === 0) {
    void vscode.window.showErrorMessage('None of the selected ports can be killed (VS Code, system processes or the container runtime).');
    return;
  }

  if (!skipConfirm && vscode.workspace.getConfiguration('killport').get<boolean>('confirmBeforeKill', true)) {
    const lines = targets.map((e) => `:${e.port}  ${entryLabel(e).replace(/ on port \d+$/, '')}`);
    if (skipped) lines.push('', `${skipped} protected port${skipped === 1 ? '' : 's'} will be skipped.`);
    const choice = await vscode.window.showWarningMessage(
      `Kill ${targets.length} ports?`,
      { modal: true, detail: lines.join('\n') },
      force ? 'Force Kill All' : 'Kill All',
      ...(force ? [] : ['Force Kill All']),
    );
    if (!choice) return;
    force = choice === 'Force Kill All';
  }

  // One kill per process / container, even when it holds several of the selected ports.
  const done = new Map<string, Promise<boolean>>();
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Killing ${targets.length} ports…` },
    () =>
      Promise.all(
        targets.map((e) => {
          const key = e.container ? `c:${e.container.id}` : `p:${e.pid}`;
          if (!done.has(key)) done.set(key, stopEntry(e, { force, protectedPids }).then((r) => r.ok));
          return done.get(key)!;
        }),
      ),
  );
  await store.refresh();

  const failed = targets.filter((_, i) => !results[i]);
  if (failed.length === 0) {
    vscode.window.setStatusBarMessage(`$(check) Killed ${targets.length} ports`, 4000);
  } else {
    const ports = failed.map((e) => e.port).join(', ');
    const again = force ? undefined : await vscode.window.showWarningMessage(`Could not free port${failed.length === 1 ? '' : 's'} ${ports}.`, 'Force Kill');
    if (again) await killMany(store, failed, true, true);
    else if (force) void vscode.window.showErrorMessage(`Could not free port${failed.length === 1 ? '' : 's'} ${ports}.`);
  }
}
