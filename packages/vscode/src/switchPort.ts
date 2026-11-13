import * as vscode from 'vscode';
import { basename } from 'node:path';
import {
  findFreePort,
  isPortFree,
  listPorts,
  probeHttp,
  rewriteCommandForPort,
  shouldProbeHttp,
  stopEntry,
  waitForPort,
  type PortEntry,
  type PortRewrite,
  type ShellKind,
} from '@killport/core';
import { entryLabel } from './kill';
import { getPortLabels } from './labels';
import type { PortStore } from './store';
import { runningCommand } from './terminalWatch';
import { getWatchedPorts } from './watch';

export interface SwitchPortOptions {
  /** Skip the confirm/edit step and run the suggested command (API / tests). */
  confirm?: boolean;
  /** Use this command instead of the suggestion. */
  command?: string;
  /** Which process to move when several listen on the port (e.g. one on IPv4, one on IPv6). */
  pid?: number;
}

export interface SwitchPortResult {
  ok: boolean;
  command?: string;
  newPort?: number;
  message: string;
}

export function shellKindOf(terminal: vscode.Terminal | undefined): ShellKind {
  const opts = terminal?.creationOptions as vscode.TerminalOptions | undefined;
  const shell = basename(opts?.shellPath ?? vscode.env.shell ?? '').toLowerCase();
  if (shell.includes('pwsh') || shell.includes('powershell')) return 'pwsh';
  if (shell === 'cmd.exe' || shell === 'cmd') return 'cmd';
  return 'posix';
}

const HOW: Record<PortRewrite['how'], string> = {
  replaced: 'The port was written in the command, so it was changed there.',
  flag: 'Added the port option for {tool}.',
  env: "Couldn't tell which tool this is, so PORT is set (Express, Create React App and most Node servers read it).",
};

/**
 * Moves a server to another port: restarts the command that started it with the new port.
 * (A running process can't change the port it listens on.)
 */
export async function switchPort(store: PortStore, port?: number, newPort?: number, opts: SwitchPortOptions = {}): Promise<SwitchPortResult> {
  const fail = (message: string, show: 'info' | 'error' = 'error'): SwitchPortResult => {
    void (show === 'info' ? vscode.window.showInformationMessage(message) : vscode.window.showErrorMessage(message));
    return { ok: false, message };
  };

  await store.refresh();
  if (port === undefined) {
    const picked = await vscode.window.showQuickPick(
      store.visibleEntries.filter((e) => !e.container && e.pid > 0).map((e) => ({ label: `:${e.port}`, description: `${e.processName} · pid ${e.pid}`, detail: e.cwd, port: e.port })),
      { placeHolder: 'Which server do you want to move to another port?' },
    );
    if (!picked) return { ok: false, message: 'cancelled' };
    port = picked.port;
  }

  let holders = store.snapshot.entries.filter((e) => e.port === port);
  if (opts.pid) holders = holders.filter((e) => e.pid === opts.pid);
  if (holders.length === 0) return fail(`Nothing is listening on port ${port}.`, 'info');
  const container = holders.find((e) => e.container)?.container;
  if (container) {
    return fail(
      `Port ${port} is published by the container ${container.name}. A container's ports are fixed when it is created: change the mapping (e.g. "${port + 1}:…" in docker-compose.yml) and recreate it.`,
      'info',
    );
  }
  const protectedPids = await store.getProtected();
  const main = holders[0];
  // Only stop the chosen program, not another one sharing the port on the other IP family.
  const mainPids = new Set(holders.filter((h) => h.pid === main.pid).map((h) => h.pid));
  if (!main.pid || protectedPids.has(main.pid) || main.isContainerRuntime) return fail(`Can't move ${entryLabel(main)}: it is VS Code, a system process or not visible to you.`);

  const terminal = store.terminalFor(main);
  const running = terminal ? runningCommand(terminal) : undefined;
  const baseCommand = running?.commandLine || main.command;
  if (!baseCommand) return fail(`Can't tell how ${entryLabel(main)} was started, so it can't be restarted on another port.`);

  // Pick the new port.
  if (newPort === undefined) {
    const suggestion = (await findFreePort({ preferred: port + 1 })).ports[0];
    const input = await vscode.window.showInputBox({
      title: `Move ${entryLabel(main)}`,
      prompt: 'New port',
      value: suggestion ? String(suggestion) : '',
      validateInput: async (v) => {
        const n = Number(v.trim());
        if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Enter a port number (1-65535)';
        if (n === port) return 'That is the current port';
        return (await isPortFree(n)) ? undefined : `Port ${n} is in use`;
      },
    });
    if (!input) return { ok: false, message: 'cancelled' };
    newPort = Number(input.trim());
  }

  // Work out the restart command, and let the user check / edit it.
  const rewrite = rewriteCommandForPort(baseCommand, port, newPort, { processCommand: main.command, shell: shellKindOf(terminal) });
  let command = opts.command ?? rewrite.command;
  if (opts.confirm !== false && opts.command === undefined) {
    const edited = await vscode.window.showInputBox({
      title: `Restart on port ${newPort}`,
      prompt:
        (running?.commandLine
          ? ''
          : "This is the process's own command line (it wasn't started from a VS Code terminal), so quoting or environment variables may be missing. ") +
        `${HOW[rewrite.how].replace('{tool}', rewrite.tool ?? 'this tool')} Edit if needed, then press Enter.`,
      value: command,
      valueSelection: [command.length, command.length],
      ignoreFocusOut: true,
    });
    if (!edited?.trim()) return { ok: false, message: 'cancelled' };
    command = edited.trim();
  }

  const who = getPortLabels()[port] ? `"${getPortLabels()[port]}"` : entryLabel(main).replace(/ on port \d+$/, '');
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Moving ${who} to port ${newPort}…` },
    async (progress) => {
      // 1. Stop it. In a VS Code terminal, Ctrl+C stops the whole job (npm + watchers), like the user would.
      progress.report({ message: 'stopping' });
      if (terminal && running) terminal.sendText('\x03', false);
      const ourPidGone = async (timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (!(await listPorts({ port, enrich: false })).some((h) => mainPids.has(h.pid))) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };
      let freed = terminal && running ? await ourPidGone(4000) : false;
      if (!freed) {
        for (const h of await listPorts({ port })) if (mainPids.has(h.pid)) await stopEntry(h, { force: true, protectedPids });
        freed = await ourPidGone(4000);
      }
      if (!freed) return fail(`Could not stop the server on port ${port}; nothing was restarted.`);

      // 2. Start it again with the new port: in the same terminal once its command has ended, else a new one.
      progress.report({ message: 'starting' });
      let target = terminal;
      if (terminal && running) {
        const endedWithin = (ms: number) => Promise.race([running.ended.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
        let done = await endedWithin(process.platform === 'win32' ? 1500 : 3000);
        // Windows: npm/yarn/pnpm are .cmd shims, and Ctrl+C makes cmd ask "Terminate batch job (Y/N)?".
        // The server is already gone (port free) but the prompt waits: answer it instead of typing into it.
        if (!done && process.platform === 'win32' && /^\s*(npm|npx|yarn|pnpm|pnpx)(\.cmd)?\s/i.test(baseCommand)) {
          terminal.sendText('Y', true);
          done = await endedWithin(3000);
        }
        if (!done) target = undefined; // still busy (a wrapper that ignored Ctrl+C): don't type into it
      }
      target ??= vscode.window.createTerminal({ name: `${main.processName} :${newPort}`, cwd: main.cwd });
      target.show(true);
      target.sendText(command, true);

      // 3. Carry the label and the ★ watch over to the new port.
      await moveSettings(port!, newPort!);
      void store.refresh();

      // 4. Wait until it listens.
      progress.report({ message: `waiting for port ${newPort}` });
      const up = await waitForPort(newPort!, { timeoutMs: 60_000 });
      void store.refresh();
      if (!up.ok) {
        const message = `Nothing is listening on port ${newPort} after 60s. Check the terminal; if the app ignores the new setting, set its port in its config.`;
        void vscode.window.showWarningMessage(message, 'Show Terminal').then((c) => c && target!.show());
        return { ok: false, command, newPort, message };
      }
      const e = up.entries[0] as PortEntry | undefined;
      const scheme = e && shouldProbeHttp(e) ? await probeHttp(newPort!, e.addresses) : undefined;
      const message = `${who} is now on port ${newPort}.`;
      void vscode.window.showInformationMessage(message, ...(scheme ? ['Open'] : [])).then((c) => {
        if (c === 'Open') void vscode.env.openExternal(vscode.Uri.parse(`${scheme}://localhost:${newPort}`));
      });
      return { ok: true, command, newPort, message };
    },
  );
}

async function moveSettings(from: number, to: number): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('killport');
  const labels = getPortLabels();
  if (labels[from] && !labels[to]) {
    labels[to] = labels[from];
    delete labels[from];
    await cfg.update('portLabels', labels, vscode.ConfigurationTarget.Global);
  }
  const watched = getWatchedPorts();
  if (watched.includes(from)) {
    await cfg.update('watchPorts', [...new Set(watched.map((p) => (p === from ? to : p)))].sort((a, b) => a - b), vscode.ConfigurationTarget.Global);
  }
}
