import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import { stopEntry, type PortEntry } from '@killport/core';
import { killMany } from './kill';
import type { PortStore } from './store';

/**
 * Workspace folder paths, plus their real paths when they go through a symlink: the OS reports a
 * process's folder resolved (macOS /var → /private/var, ~/code → /Volumes/Dev/code), VS Code doesn't.
 */
export function workspaceRoots(): string[] {
  const roots = new Set<string>();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    roots.add(f.uri.fsPath);
    try {
      roots.add(realpathSync(f.uri.fsPath));
    } catch {
      /* folder missing */
    }
  }
  return [...roots];
}

/** True when `dir` is one of the workspace folders or inside one. */
export function isInWorkspace(dir: string | undefined): boolean {
  if (!dir) return false;
  const win = process.platform === 'win32';
  const norm = (p: string) => (win ? p.toLowerCase().replace(/\//g, '\\') : p).replace(/[\\/]+$/, '');
  const sep = win ? '\\' : '/';
  const d = norm(dir);
  return workspaceRoots().some((r) => {
    const root = norm(r);
    return d === root || d.startsWith(root + sep);
  });
}

/** Listening processes (and compose containers) started from this workspace, excluding protected ones. */
export async function workspaceServers(store: PortStore, opts: { includeContainers: boolean }): Promise<PortEntry[]> {
  await store.refresh();
  const protectedPids = await store.getProtected();
  return store.snapshot.entries.filter((e) => {
    if (!isInWorkspace(e.cwd)) return false;
    if (e.container) return opts.includeContainers;
    return !e.isContainerRuntime && e.pid > 0 && !protectedPids.has(e.pid);
  });
}

/** Command: stop every server started from this workspace, after one confirmation. */
export async function stopWorkspaceServers(store: PortStore): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage('Open a folder first: this stops servers started from the open workspace.');
    return;
  }
  const servers = await workspaceServers(store, { includeContainers: true });
  if (servers.length === 0) {
    void vscode.window.showInformationMessage('No servers from this workspace are listening on a port.');
    return;
  }
  await killMany(store, servers);
}

/**
 * Called from deactivate() when the window closes and `killport.stopServersOnClose` is on.
 * Stops processes only (docker stop is too slow for shutdown), in parallel and with a short grace period.
 */
export async function stopWorkspaceServersOnClose(store: PortStore): Promise<void> {
  if (!vscode.workspace.getConfiguration('killport').get<boolean>('stopServersOnClose', false)) return;
  const servers = await Promise.race([
    workspaceServers(store, { includeContainers: false }),
    new Promise<PortEntry[]>((r) => setTimeout(() => r(store.snapshot.entries.filter((e) => isInWorkspace(e.cwd) && !e.container && !e.isContainerRuntime)), 1500)),
  ]);
  const protectedPids = await store.getProtected();
  const pids = [...new Map(servers.map((s) => [s.pid, s])).values()];
  await Promise.all(pids.map((e) => stopEntry(e, { force: true, graceMs: 800, protectedPids })));
}
