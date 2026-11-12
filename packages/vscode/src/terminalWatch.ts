import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { findFreePort, listPorts, parsePortConflict, portFromCommand, rewriteCommandForPort, type PortConflict, type PortEntry } from '@killport/core';
import { entryLabel, killEntry } from './kill';
import { shellKindOf } from './switchPort';
import type { PortStore } from './store';

/*
 * Minimal typings for the terminal shell-execution API (VS Code 1.93+).
 * The extension supports 1.90, so we feature-detect at runtime instead of
 * raising the @types/vscode version.
 */
interface ShellExecution {
  readonly commandLine: { readonly value: string; readonly confidence: number };
  read(): AsyncIterable<string>;
}
interface ShellExecutionEvent {
  readonly terminal: vscode.Terminal;
  readonly execution: ShellExecution;
}
interface ShellApi {
  onDidStartTerminalShellExecution?: vscode.Event<ShellExecutionEvent>;
  onDidEndTerminalShellExecution?: vscode.Event<ShellExecutionEvent>;
}

/** Only look at the start of a run's output; a conflict always shows up right after startup. */
const MAX_SCAN_CHARS = 256 * 1024;
/** Don't ask about the same port twice within this window (several terminals, restarts by watchers...). */
const DEDUPE_MS = 15_000;
/** TerminalShellExecutionCommandLineConfidence.High */
const HIGH_CONFIDENCE = 2;

export interface DetectedConflict {
  port: number;
  kind: PortConflict['kind'];
  command: string;
  /** What holds the port right now. */
  holders: PortEntry[];
}

/** The command currently running in a terminal, as typed (from shell integration). */
export interface RunningCommand {
  commandLine: string;
  /** VS Code is sure about the exact text (not reconstructed from the prompt). */
  confident: boolean;
  /** Resolves when the command finishes. */
  ended: Promise<void>;
}

const runningCommands = new Map<vscode.Terminal, { execution: ShellExecution; info: RunningCommand }>();

export function runningCommand(terminal: vscode.Terminal): RunningCommand | undefined {
  return runningCommands.get(terminal)?.info;
}

/**
 * Registers the watcher. Returns an event fired whenever a conflict is detected (before the prompt),
 * exposed through the extension API for other extensions and integration tests.
 */
export function registerTerminalWatch(
  ctx: vscode.ExtensionContext,
  store: PortStore,
  showPort: (port: number) => Thenable<void> | void,
): vscode.Event<DetectedConflict> {
  const detected = new vscode.EventEmitter<DetectedConflict>();
  ctx.subscriptions.push(detected);
  const api = vscode.window as unknown as ShellApi;
  if (!api.onDidStartTerminalShellExecution || !api.onDidEndTerminalShellExecution) return detected.event;

  const ended = new WeakMap<ShellExecution, () => void>();
  const endPromises = new WeakMap<ShellExecution, Promise<void>>();
  const lastAsked = new Map<number, number>();

  ctx.subscriptions.push(
    api.onDidEndTerminalShellExecution((e) => {
      ended.get(e.execution)?.();
      if (runningCommands.get(e.terminal)?.execution === e.execution) runningCommands.delete(e.terminal);
    }),
    api.onDidStartTerminalShellExecution((e) => {
      const endPromise = new Promise<void>((resolve) => ended.set(e.execution, resolve));
      endPromises.set(e.execution, endPromise);
      // Remember what runs in each terminal (used by "Move to another port" to restart it).
      runningCommands.set(e.terminal, {
        execution: e.execution,
        info: { commandLine: e.execution.commandLine.value.trim(), confident: e.execution.commandLine.confidence === HIGH_CONFIDENCE, ended: endPromise },
      });
      if (!vscode.workspace.getConfiguration('killport').get<boolean>('detectPortConflicts', true)) return;
      void scan(e);
    }),
    vscode.window.onDidCloseTerminal((t) => runningCommands.delete(t)),
  );

  return detected.event;

  async function scan(e: ShellExecutionEvent): Promise<void> {
    let buffer = '';
    let scanned = 0;
    try {
      for await (const chunk of e.execution.read()) {
        scanned += chunk.length;
        // Keep a little of the previous chunk so a message split across chunks is still found.
        buffer = (buffer.slice(-512) + chunk).slice(-8192);
        const conflict = parsePortConflict(buffer);
        if (conflict) {
          await onConflict(e, conflict);
          return; // one prompt per run
        }
        if (scanned > MAX_SCAN_CHARS) return;
      }
    } catch {
      /* the terminal was closed while reading */
    }
  }

  async function onConflict(e: ShellExecutionEvent, conflict: PortConflict): Promise<void> {
    const command = e.execution.commandLine.value.trim();
    const port = conflict.port ?? portFromCommand(command);
    if (!port) return;

    const now = Date.now();
    if (now - (lastAsked.get(port) ?? 0) < DEDUPE_MS) return;
    lastAsked.set(port, now);

    let holders: PortEntry[];
    try {
      holders = await listPorts({ port });
    } catch {
      return;
    }
    if (holders.length === 0) return; // already freed
    detected.fire({ port, kind: conflict.kind, command, holders });

    const first = holders[0];
    const home = homedir();
    const where = first.cwd ? ` in ${first.cwd.startsWith(home) ? '~' + first.cwd.slice(home.length) : first.cwd}` : '';
    const who = holders.length > 1 ? `${holders.length} processes` : entryLabel(first).replace(/ on port \d+$/, '');
    const verb = first.container ? 'Stop' : 'Kill';

    // "Run Again" only makes sense when the command failed and we know exactly what it was.
    const canRerun = conflict.kind === 'failed' && !!command && e.execution.commandLine.confidence === HIGH_CONFIDENCE;
    const rerunLabel = `${verb} & Run Again`;
    // Or leave the other server alone and run *this* command on a free port.
    const free = canRerun ? (await findFreePort({ preferred: port + 1 })).ports[0] : undefined;
    const useFreeLabel = free ? `Use ${free}` : undefined;
    const buttons = [...(canRerun ? [rerunLabel] : []), ...(useFreeLabel ? [useFreeLabel] : []), verb, 'Show'];

    const message =
      conflict.kind === 'moved'
        ? `Port ${port} was busy, so the dev server moved to another port. It is held by ${who}${where}.`
        : `Port ${port} is already in use by ${who}${where}.`;

    // If the holder was started from another VS Code terminal, offer to jump there instead of killing.
    await store.refresh();
    const holderTerminal = holders.map((h) => store.terminalFor(h)).find((t) => t && t !== e.terminal);
    if (holderTerminal) buttons.splice(buttons.length - 1, 0, 'Go to Terminal');
    const shownMessage = holderTerminal ? `${message.replace(/\.$/, '')} (terminal "${holderTerminal.name}").` : message;

    const choice = await vscode.window.showWarningMessage(shownMessage, ...buttons);
    if (!choice) return;
    if (choice === 'Show') {
      await showPort(port);
      return;
    }
    if (choice === 'Go to Terminal') {
      holderTerminal?.show();
      return;
    }
    if (choice === useFreeLabel && free) {
      const { command: moved } = rewriteCommandForPort(command, port, free, { shell: shellKindOf(e.terminal) });
      await Promise.race([endPromises.get(e.execution), new Promise((r) => setTimeout(r, 5000))]);
      e.terminal.show(true);
      e.terminal.sendText(moved, true);
      return;
    }

    let allGone = true;
    for (const h of holders) allGone = (await killEntry(store, h, { skipConfirm: true })) && allGone;

    if (choice === rerunLabel && allGone) {
      // Wait for the failed command to finish before typing it again (it usually already has).
      await Promise.race([endPromises.get(e.execution), new Promise((r) => setTimeout(r, 5000))]);
      e.terminal.show(true);
      e.terminal.sendText(command, true);
    }
  }
}
