import { getUnixCwds, getUnixPsInfo, listUnixListeners } from './unix';
import { getWindowsProcesses, lastTasklist, listWindowsListeners } from './windows';
import { killPid, type KillOptions } from './kill';
import { getProtectedPids } from './safety';
import { getContainersByPort, isContainerRuntime, parseDockerUptime, stopContainer } from './docker';
import type { KillResult, ListOptions, PortEntry, RawListener } from './types';

export * from './types';
export { killPid, isAlive, type KillOptions } from './kill';
export { getProtectedPids, protectedPidsFrom, ancestorChain, getParentMap } from './safety';
export { parseEtime, parsePsInfo } from './unix';
export { probeHttp, probeHost, shouldProbeHttp, type HttpScheme } from './http';
export { appOrSystemKind, isAppOrSystem, type HiddenKind } from './appFilter';
export { addressFamily, findSharedPorts, type AddressFamily, type SharedPort } from './shared';
export { rewriteCommandForPort, detectTool, withPortEnv, type PortRewrite, type ShellKind } from './portSwitch';
export { canBind, isPortFree, findFreePort, waitForPort, type FindFreePortOptions, type FindFreePortResult, type WaitForPortOptions, type WaitForPortResult } from './availability';
export { isContainerRuntime, stopContainer, parseDockerPs, parsePublishedPorts, parseDockerUptime } from './docker';
export { parsePortConflict, portFromCommand, type PortConflict } from './conflict';

/**
 * Parses "3000-9999", "3000-3999,5432,8080". Returns undefined for an empty
 * string (no filter). Invalid parts are ignored.
 */
export function parseRange(range: string | undefined): ((port: number) => boolean) | undefined {
  if (!range || !range.trim()) return undefined;
  const parts: Array<[number, number]> = [];
  for (const raw of range.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(raw);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    parts.push([Math.min(a, b), Math.max(a, b)]);
  }
  if (parts.length === 0) return undefined;
  return (port) => parts.some(([a, b]) => port >= a && port <= b);
}

/** True for loopback addresses: 127.x.x.x, ::1, localhost. */
export function isLoopback(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase();
  return a.startsWith('127.') || a === '::1' || a === 'localhost' || a.startsWith('::ffff:127.');
}

/** True when every address is loopback, i.e. the port is only reachable from this machine. */
export function isLocalhostOnly(addresses: string[]): boolean {
  return addresses.length > 0 && addresses.every(isLoopback);
}

/** Merges raw sockets into one entry per (port, pid), applying filters. */
export function mergeListeners(raw: RawListener[], opts: ListOptions = {}): PortEntry[] {
  const inRange = parseRange(opts.range);
  const includeSystem = opts.includeSystem ?? true;
  const byKey = new Map<string, PortEntry>();
  for (const r of raw) {
    if (opts.port !== undefined && r.port !== opts.port) continue;
    if (!includeSystem && r.port < 1024) continue;
    if (inRange && !inRange(r.port)) continue;
    const key = `${r.port}:${r.pid}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.addresses.includes(r.address)) existing.addresses.push(r.address);
    } else {
      byKey.set(key, { port: r.port, protocol: 'tcp', addresses: [r.address], pid: r.pid, processName: r.processName });
    }
  }
  // Filter after merging: a port is only "localhost only" if *all* its sockets are loopback.
  const merged = opts.localhostOnly ? [...byKey.values()].filter((e) => isLocalhostOnly(e.addresses)) : [...byKey.values()];
  return merged.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/*
 * Per-process details that never change while a process lives (cwd, and on Windows the command line
 * and start time) are cached, so a refresh only does the expensive lookups for new processes.
 * Entries are keyed by pid and validated with an identity (start time or image name), so a reused
 * pid never inherits another process's details.
 */
interface CachedProc {
  identity: string;
  cwd?: string;
  command?: string;
  startedAt?: number;
  seen: number;
}
const procCache = new Map<number, CachedProc>();

function cacheGet(pid: number, identity: string): CachedProc | undefined {
  const c = procCache.get(pid);
  if (!c || c.identity !== identity) return undefined;
  c.seen = Date.now();
  return c;
}

function cacheSet(pid: number, value: Omit<CachedProc, 'seen'>): void {
  procCache.set(pid, { ...value, seen: Date.now() });
  // Forget processes not seen for 10 minutes.
  if (procCache.size > 500) {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of procCache) if (v.seen < cutoff) procCache.delete(k);
  }
}

/** Clears cached process details (tests, or a manual "hard refresh"). */
export function clearProcessCache(): void {
  procCache.clear();
}

async function enrichUnix(entries: PortEntry[], pids: number[]): Promise<void> {
  const now = Date.now();
  const ps = await getUnixPsInfo(pids);
  // Start time rounded to 5s is the identity: ps etime has 1s resolution and refreshes take time.
  const identity = (pid: number) => {
    const info = ps.get(pid);
    return info ? String(Math.round((now - info.elapsed * 1000) / 5000)) : 'gone';
  };
  const missing = pids.filter((pid) => !cacheGet(pid, identity(pid)));
  if (missing.length) {
    const cwds = await getUnixCwds(missing);
    for (const pid of missing) cacheSet(pid, { identity: identity(pid), cwd: cwds.get(pid) });
  }
  for (const e of entries) {
    const info = ps.get(e.pid);
    e.command = info?.command;
    e.memoryKB = info?.memoryKB;
    e.cpuPercent = info?.cpuPercent;
    e.startedAt = info ? now - info.elapsed * 1000 : undefined;
    e.cwd = procCache.get(e.pid)?.cwd;
  }
}

async function enrichWindows(entries: PortEntry[], pids: number[]): Promise<void> {
  const identity = (pid: number) => lastTasklist.get(pid)?.name ?? '?';
  const missing = pids.filter((pid) => !cacheGet(pid, identity(pid)));
  if (missing.length) {
    // PowerShell is slow to start, so only ask about processes we haven't seen yet.
    const procs = await getWindowsProcesses(missing);
    for (const pid of missing) {
      const p = procs.get(pid);
      cacheSet(pid, { identity: identity(pid), command: p?.command, startedAt: p?.startedAt });
    }
  }
  for (const e of entries) {
    const c = procCache.get(e.pid);
    e.command = c?.command;
    e.startedAt = c?.startedAt;
    e.memoryKB = lastTasklist.get(e.pid)?.memoryKB;
  }
}

/** Lists every listening TCP port with its owning process. */
export async function listPorts(opts: ListOptions = {}): Promise<PortEntry[]> {
  const isWin = process.platform === 'win32';
  const raw = isWin ? await listWindowsListeners() : await listUnixListeners();
  const entries = mergeListeners(raw, opts);
  if (opts.enrich === false || entries.length === 0) return entries;

  const pids = [...new Set(entries.map((e) => e.pid).filter((p) => p > 0))];
  if (isWin) await enrichWindows(entries, pids);
  else await enrichUnix(entries, pids);

  // Ports forwarded by Docker Desktop / OrbStack / Podman: name the container behind them.
  const runtimeEntries = entries.filter((e) => isContainerRuntime(e.processName));
  if (runtimeEntries.length) {
    const containers = await getContainersByPort();
    for (const e of runtimeEntries) {
      e.container = containers.get(e.port);
      e.isContainerRuntime = !e.container;
      // The runtime's own cwd (e.g. ~/Library/Containers/com.docker.docker/Data) means nothing to the user.
      if (e.container) {
        e.cwd = e.container.composeDir;
        // Memory/CPU would be Docker's, not the container's: don't show misleading numbers.
        e.memoryKB = e.cpuPercent = undefined;
        const up = parseDockerUptime(e.container.status);
        e.startedAt = up === undefined ? undefined : Date.now() - up * 1000;
      }
    }
  }
  return entries;
}

export const RUNTIME_REFUSAL =
  'Refusing to kill the container runtime itself (Docker Desktop / OrbStack / Podman): it would stop every container. Stop the container that publishes this port instead.';
export const PROTECTED_REFUSAL =
  'Refusing to kill this process: it is a system process or part of the calling process tree (it would kill the tool/agent itself).';

/**
 * Stops whatever holds one port entry, applying all safety rules:
 * containers are stopped with docker, the runtime itself and protected PIDs are refused.
 */
export async function stopEntry(entry: PortEntry, opts: KillOptions & { protectedPids: Set<number> }): Promise<KillResult> {
  if (entry.container) return { ...(await stopContainer(entry.container, opts)), pid: entry.pid };
  if (entry.isContainerRuntime) return { pid: entry.pid, ok: false, code: 'PROTECTED', error: RUNTIME_REFUSAL };
  if (opts.protectedPids.has(entry.pid)) return { pid: entry.pid, ok: false, code: 'PROTECTED', error: PROTECTED_REFUSAL };
  return killPid(entry.pid, opts);
}

export interface KillPortOptions extends KillOptions {
  /** PIDs that must not be killed. Defaults to our own process tree + OS core processes. */
  protectedPids?: Set<number>;
}

export interface KillPortResult {
  port: number;
  /** Processes that were listening on the port before the kill. */
  found: PortEntry[];
  /** results[i] is the outcome for found[i]. */
  results: KillResult[];
  /** True when nothing is listening on the port anymore. */
  portFree: boolean;
}

/** Kills every process listening on `port`, skipping protected PIDs. */
export async function killPort(port: number, opts: KillPortOptions = {}): Promise<KillPortResult> {
  const found = await listPorts({ port });
  const protectedPids = opts.protectedPids ?? (await getProtectedPids());
  // One kill per process / container, even if it shows up on several rows.
  const done = new Map<string, KillResult>();
  const results: KillResult[] = [];
  for (const e of found) {
    const key = e.container ? `c:${e.container.id}` : `p:${e.pid}`;
    if (!done.has(key)) done.set(key, await stopEntry(e, { ...opts, protectedPids }));
    results.push(done.get(key)!);
  }
  const after = found.length ? await listPorts({ port, enrich: false }) : [];
  return { port, found, results, portFree: after.length === 0 };
}
