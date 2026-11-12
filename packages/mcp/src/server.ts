import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { findFreePort, findSharedPorts, getProtectedPids, isAppOrSystem, isLocalhostOnly, killPort, listPorts, probeHttp, shouldProbeHttp, waitForPort, type PortEntry } from '@killport/core';

declare const __KILLPORT_VERSION__: string;
const VERSION = typeof __KILLPORT_VERSION__ === 'string' ? __KILLPORT_VERSION__ : '0.0.0-dev';

function describe(e: PortEntry): string {
  const where = e.cwd ? ` in ${e.cwd}` : '';
  const tag = isLocalhostOnly(e.addresses) ? ' [localhost]' : ' [all interfaces]';
  const short = e.command && e.command.length > 160 ? e.command.slice(0, 157) + '…' : e.command;
  const cmd = short ? ` — ${short}` : '';
  if (e.container) {
    const c = e.container;
    const compose = c.composeProject ? `, compose ${c.composeProject}/${c.composeService ?? '?'}` : '';
    return `:${e.port}  container ${c.name} (image ${c.image}${compose}, id ${c.id})${tag}${where}`;
  }
  const runtime = e.isContainerRuntime ? ' [container runtime: cannot be killed]' : '';
  return `:${e.port}  ${e.processName} (pid ${e.pid || '?'})${tag}${runtime}${where}${cmd}`;
}

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], isError };
}

const server = new McpServer({ name: 'killport', version: VERSION });

server.registerTool(
  'list_ports',
  {
    title: 'List listening ports',
    description:
      'List TCP ports that are currently listening on this machine, with the owning process (pid, name, full command line, working directory). ' +
      'Use it to find what is holding a port, e.g. after an EADDRINUSE / "port already in use" error, or to discover which dev servers are running.',
    inputSchema: {
      port: z.number().int().min(1).max(65535).optional().describe('Only show this port.'),
      range: z.string().optional().describe('Port range filter, e.g. "3000-9999" or "3000-3999,5432".'),
      includeSystem: z.boolean().optional().describe('Include ports below 1024. Default false.'),
      includeApps: z
        .boolean()
        .optional()
        .describe('Also list ports held by desktop apps, OS services and editor/agent helpers (hidden by default unless a port is given).'),
      localhostOnly: z
        .boolean()
        .optional()
        .describe('Only show ports bound to localhost (127.0.0.1 / ::1), not ones reachable from the network.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ port, range, includeSystem, localhostOnly, includeApps }) => {
    try {
      const all = await listPorts({ port, range, localhostOnly, includeSystem: port !== undefined ? true : includeSystem ?? false });
      // A specific port always shows whatever holds it; otherwise skip desktop apps / OS / editor helpers.
      const entries = port !== undefined || includeApps ? all : all.filter((e) => !isAppOrSystem(e));
      if (entries.length === 0) {
        return text(port !== undefined ? `Nothing is listening on port ${port}. It is free.` : 'No listening ports matched.');
      }
      const summary = entries.map(describe).join('\n');
      // Two programs on one port (IPv4 vs IPv6): `curl localhost:<port>` and `curl 127.0.0.1:<port>` hit different apps.
      const warnings = findSharedPorts(entries).map(
        (s) =>
          `WARNING: port ${s.port} is used by two programs. localhost:${s.port} (IPv6, tried first) reaches pid ${s.ipv6.map((e) => e.pid).join('/')}; ` +
          `127.0.0.1:${s.port} (IPv4) reaches pid ${s.ipv4.map((e) => e.pid).join('/')}. Use an explicit address, or move one of them to another port.`,
      );
      const warn = warnings.length ? `\n\n${warnings.join('\n')}` : '';
      return text(`${entries.length} listening port(s):\n${summary}${warn}\n\nJSON:\n${JSON.stringify(entries, null, 2)}`);
    } catch (err) {
      return text(`Failed to list ports: ${(err as Error).message}`, true);
    }
  },
);

server.registerTool(
  'kill_port',
  {
    title: 'Kill process on port',
    description:
      'Stop the process(es) listening on a TCP port so the port becomes free. Sends a graceful terminate first. ' +
      'If the port is published by a Docker container, that container is stopped (docker stop), never Docker itself. ' +
      'Before calling this, check with list_ports what is on the port and make sure it is safe to stop (e.g. a stale dev server, not a database the user needs). ' +
      'Refuses to kill system processes and the agent/tool process tree itself. Ports below 1024 require force: true.',
    inputSchema: {
      port: z.number().int().min(1).max(65535).describe('The port to free.'),
      force: z
        .boolean()
        .optional()
        .describe('If the process does not exit gracefully, kill it hard (SIGKILL / taskkill /F). Also required for ports below 1024.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ port, force }) => {
    if (port < 1024 && !force) {
      return text(`Port ${port} is a system port (<1024). Re-run with force: true if you are sure.`, true);
    }
    try {
      const protectedPids = await getProtectedPids(process.pid);
      const res = await killPort(port, { force, protectedPids });
      if (res.found.length === 0) return text(`Nothing is listening on port ${port}. It is already free.`);

      const lines = res.found.map((e, i) => {
        const r = res.results[i];
        const done = e.container ? 'stopped container' : 'killed';
        const status = r?.ok ? `${done} (${r.method})` : `NOT killed: ${r?.error ?? 'unknown error'}`;
        return `${describe(e)}\n  → ${status}`;
      });
      lines.push(res.portFree ? `Port ${port} is now free.` : `Port ${port} is still in use.`);
      return text(lines.join('\n'), !res.portFree);
    } catch (err) {
      return text(`Failed to kill port ${port}: ${(err as Error).message}`, true);
    }
  },
);

server.registerTool(
  'find_free_port',
  {
    title: 'Find a free port',
    description:
      'Check whether a port is free and find free ports nearby. Use before starting a server, instead of guessing. ' +
      'If the preferred port is taken, the result says which process holds it (so you can decide to free it with kill_port, or use another port).',
    inputSchema: {
      preferred: z.number().int().min(1).max(65535).optional().describe('The port you would like, e.g. 3000. Returned first if free.'),
      range: z.string().optional().describe('Where to look, e.g. "3000-3999". Default: preferred..preferred+100, or 3000-3999.'),
      count: z.number().int().min(1).max(50).optional().describe('How many free ports to return. Default 1.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ preferred, range, count }) => {
    try {
      const res = await findFreePort({ preferred, range, count });
      const lines: string[] = [];
      if (preferred) {
        lines.push(
          res.ports[0] === preferred
            ? `Port ${preferred} is free.`
            : res.preferredHeldBy.length
              ? `Port ${preferred} is taken:\n${res.preferredHeldBy.map(describe).join('\n')}`
              : `Port ${preferred} is not available (it could not be bound).`,
        );
      }
      const others = res.ports.filter((p) => p !== preferred);
      if (others.length) lines.push(`Free port${others.length === 1 ? '' : 's'}: ${others.join(', ')}`);
      if (res.ports.length === 0) return text(`No free port found${range ? ` in ${range}` : ''}.`, true);
      return text(lines.join('\n'));
    } catch (err) {
      return text(`Failed to find a free port: ${(err as Error).message}`, true);
    }
  },
);

server.registerTool(
  'wait_for_port',
  {
    title: 'Wait for a port',
    description:
      'Wait until a port starts listening (e.g. a dev server you just started in the background is ready) or until it is free. ' +
      'Returns as soon as the state is reached, with the process and whether it answers HTTP. Use instead of sleep loops.',
    inputSchema: {
      port: z.number().int().min(1).max(65535).describe('The port to wait for.'),
      state: z.enum(['listening', 'free']).optional().describe('What to wait for. Default "listening".'),
      timeoutSeconds: z.number().min(1).max(300).optional().describe('Give up after this many seconds. Default 30.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ port, state, timeoutSeconds }) => {
    const want = state ?? 'listening';
    const timeoutMs = (timeoutSeconds ?? 30) * 1000;
    try {
      const res = await waitForPort(port, { state: want, timeoutMs });
      const secs = (res.elapsedMs / 1000).toFixed(1);
      if (!res.ok) {
        return text(
          want === 'listening'
            ? `Port ${port} did not start listening within ${timeoutSeconds ?? 30}s. Check the server's output for errors.`
            : `Port ${port} is still in use after ${timeoutSeconds ?? 30}s:\n${res.entries.map(describe).join('\n')}`,
          true,
        );
      }
      if (want === 'free') return text(`Port ${port} is free (after ${secs}s).`);
      const e = res.entries[0];
      const scheme = e && shouldProbeHttp(e) ? await probeHttp(port, e.addresses) : undefined;
      const web = scheme ? ` It answers ${scheme.toUpperCase()}: ${scheme}://localhost:${port}` : '';
      return text(`Port ${port} is listening (after ${secs}s).${web}\n${res.entries.map(describe).join('\n')}`);
    } catch (err) {
      return text(`Failed while waiting for port ${port}: ${(err as Error).message}`, true);
    }
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('killport-mcp failed to start:', err);
  process.exit(1);
});
