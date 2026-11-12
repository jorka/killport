/**
 * Real-system tests: start a server, find it, kill it — using the actual OS tools
 * (lsof/ps on macOS, lsof or ss on Linux, netstat/tasklist/PowerShell on Windows).
 * CI runs these on all three operating systems.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearProcessCache, findFreePort, killPort, listPorts, waitForPort } from '../src/index';

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function startServer(port: number, cwd: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `require('http').createServer().listen(${port}, '127.0.0.1', () => console.log('ready'))`], {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d) => String(d).includes('ready') && resolve(child));
    child.on('error', reject);
  });
}

const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())));

describe(`system (${process.platform})`, () => {
  it('finds a real listening process with its details', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'killport-sys-')));
    const port = await freePort();
    const child = await startServer(port, cwd);

    clearProcessCache();
    const [entry] = await listPorts({ port });
    expect(entry, `port ${port} should be listed`).toBeDefined();
    expect(entry.pid).toBe(child.pid);
    expect(entry.processName.toLowerCase()).toMatch(/node/);
    expect(entry.addresses).toContain('127.0.0.1');
    expect(entry.command).toContain('createServer');
    expect(entry.memoryKB).toBeGreaterThan(0);
    expect(entry.startedAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(Date.now() - entry.startedAt!).toBeLessThan(5 * 60_000);
    if (process.platform !== 'win32') expect(entry.cwd).toBe(cwd);

    expect((await listPorts({ port, localhostOnly: true })).length).toBe(1);
    // A second, cached refresh returns the same details.
    expect((await listPorts({ port }))[0].command).toBe(entry.command);
  });

  it('kills it and frees the port', async () => {
    const port = await freePort();
    const child = await startServer(port, tmpdir());
    const res = await killPort(port);
    expect(res.results[0]).toMatchObject({ ok: true });
    expect(res.portFree).toBe(true);
    await exited(child);
  });

  it('never kills its own process', async () => {
    const port = await freePort();
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
    try {
      const res = await killPort(port, { force: true });
      expect(res.results[0]).toMatchObject({ ok: false, code: 'PROTECTED' });
      expect(server.listening).toBe(true);
    } finally {
      server.close();
    }
  });

  it('finds a free port and says who holds the preferred one', async () => {
    const port = await freePort();
    const child = await startServer(port, tmpdir());
    const res = await findFreePort({ preferred: port, count: 2 });
    expect(res.ports).toHaveLength(2);
    expect(res.ports).not.toContain(port);
    expect(res.preferredHeldBy[0]?.pid).toBe(child.pid);
    expect((await findFreePort({ preferred: res.ports[0] })).ports[0]).toBe(res.ports[0]);
    child.kill();
    await exited(child);
  });

  it('waits for a port to start listening, and to become free', async () => {
    const port = await freePort();
    const waiting = waitForPort(port, { timeoutMs: 10_000 });
    setTimeout(() => void startServer(port, tmpdir()), 600); // start the server a bit later
    const up = await waiting;
    expect(up.ok).toBe(true);
    expect(up.elapsedMs).toBeGreaterThanOrEqual(400);
    expect(up.entries[0]?.port).toBe(port);

    const freeing = waitForPort(port, { state: 'free', timeoutMs: 10_000 });
    process.kill(up.entries[0].pid);
    expect((await freeing).ok).toBe(true);

    const never = await waitForPort(port, { timeoutMs: 600 });
    expect(never.ok).toBe(false);
  });
});
