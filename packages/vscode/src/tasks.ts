import * as vscode from 'vscode';
import { listPorts, stopEntry, type PortEntry } from '@killport/core';
import { entryLabel } from './kill';
import { getPortLabels } from './labels';
import type { PortStore } from './store';

/**
 * `killport` task type: frees ports before something else starts. Typical use is as a
 * preLaunchTask, so F5 never fails with "port already in use":
 *
 *   tasks.json:   { "label": "Free port 3000", "type": "killport", "ports": [3000] }
 *   launch.json:  "preLaunchTask": "Free port 3000"
 */
export interface KillportTaskDefinition extends vscode.TaskDefinition {
  type: 'killport';
  ports: number[];
  /** Kill hard if a process ignores the graceful stop. Default true: a task can't ask. */
  force?: boolean;
}

export const TASK_TYPE = 'killport';

export function registerTasks(ctx: vscode.ExtensionContext, store: PortStore): void {
  ctx.subscriptions.push(
    vscode.tasks.registerTaskProvider(TASK_TYPE, {
      // Offer one ready-made task per labeled port in "Run Task".
      provideTasks: () =>
        Object.entries(getPortLabels()).map(([port, label]) =>
          createTask({ type: TASK_TYPE, ports: [Number(port)] }, vscode.TaskScope.Workspace, `Free port ${port} (${label})`, store),
        ),
      resolveTask: (task) => {
        const def = task.definition as KillportTaskDefinition;
        if (!Array.isArray(def.ports)) return undefined;
        return createTask(def, task.scope ?? vscode.TaskScope.Workspace, task.name, store);
      },
    }),
  );
}

function createTask(def: KillportTaskDefinition, scope: vscode.TaskScope | vscode.WorkspaceFolder, name: string, store: PortStore): vscode.Task {
  const task = new vscode.Task(def, scope, name, 'killport', new vscode.CustomExecution(async () => new FreePortsTerminal(def, store)));
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
  return task;
}

/** Pseudo-terminal that frees the ports and reports what happened. Exit code 1 if a port stays busy. */
class FreePortsTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(
    private readonly def: KillportTaskDefinition,
    private readonly store: PortStore,
  ) {}

  open(): void {
    void this.run().then(
      (code) => this.closeEmitter.fire(code),
      (err) => {
        this.line(`\x1b[31mKillport failed: ${(err as Error).message}\x1b[0m`);
        this.closeEmitter.fire(1);
      },
    );
  }

  close(): void {}

  private line(text: string): void {
    this.writeEmitter.fire(text + '\r\n');
  }

  private async run(): Promise<number> {
    const ports = [...new Set(this.def.ports.map(Number))].filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
    if (ports.length === 0) {
      this.line('No valid ports in the task definition ("ports": [3000]).');
      return 1;
    }
    const protectedPids = await this.store.getProtected();
    const force = this.def.force ?? true;
    let failed = 0;

    for (const port of ports) {
      const holders = await listPorts({ port });
      if (holders.length === 0) {
        this.line(`Port ${port}: free`);
        continue;
      }
      const done = new Set<string>();
      for (const h of holders) {
        const key = h.container ? `c:${h.container.id}` : `p:${h.pid}`;
        if (done.has(key)) continue;
        done.add(key);
        const r = await stopEntry(h, { force, protectedPids });
        this.line(r.ok ? `Port ${port}: ${verb(h)} ${describe(h)} (${r.method})` : `\x1b[31mPort ${port}: could not stop ${describe(h)}: ${r.error}\x1b[0m`);
      }
      const still = await listPorts({ port, enrich: false });
      if (still.length) failed++;
    }
    void this.store.refresh();
    return failed ? 1 : 0;
  }
}

const verb = (e: PortEntry) => (e.container ? 'stopped' : 'killed');
const describe = (e: PortEntry) => entryLabel(e).replace(/ on port \d+$/, '');
