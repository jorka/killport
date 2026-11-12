import net from 'node:net';
import { listPorts, parseRange } from './index';
import type { PortEntry } from './types';

/** Tries to bind host:port; true when it worked (the port is free on that address). */
export function canBind(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/** Free = nothing listening on it (any address) and we can bind it on localhost. */
export async function isPortFree(port: number): Promise<boolean> {
  const listening = await listPorts({ port, enrich: false });
  return listening.length === 0 && (await canBind(port));
}

export interface FindFreePortOptions {
  /** Port you would like; returned if free. */
  preferred?: number;
  /** Where to look, e.g. "3000-3999". Default: preferred..preferred+100, or 3000-3999. */
  range?: string;
  /** How many free ports to return. Default 1. */
  count?: number;
}

export interface FindFreePortResult {
  /** Free ports, in search order (preferred first). Empty if none found. */
  ports: number[];
  /** What holds the preferred port, when it is taken. */
  preferredHeldBy: PortEntry[];
}

export async function findFreePort(opts: FindFreePortOptions = {}): Promise<FindFreePortResult> {
  const count = Math.max(1, Math.min(opts.count ?? 1, 50));
  const start = opts.preferred ?? 3000;
  const inRange = parseRange(opts.range ?? (opts.preferred ? `${start}-${Math.min(start + 100, 65535)}` : '3000-3999'));
  const busy = new Set((await listPorts({ enrich: false })).map((e) => e.port));

  const candidates: number[] = [];
  if (opts.preferred) candidates.push(opts.preferred);
  const [lo, hi] = rangeBounds(opts.range) ?? [start, opts.preferred ? Math.min(start + 100, 65535) : 3999];
  for (let p = lo; p <= hi && candidates.length < 5000; p++) if (p !== opts.preferred && (!inRange || inRange(p))) candidates.push(p);

  const ports: number[] = [];
  for (const p of candidates) {
    if (ports.length >= count) break;
    if (p < 1 || p > 65535 || busy.has(p)) continue;
    if (await canBind(p)) ports.push(p);
  }
  const preferredHeldBy = opts.preferred && !ports.includes(opts.preferred) ? await listPorts({ port: opts.preferred }) : [];
  return { ports, preferredHeldBy };
}

function rangeBounds(range: string | undefined): [number, number] | undefined {
  if (!range) return undefined;
  const nums = range.match(/\d+/g)?.map(Number);
  return nums?.length ? [Math.min(...nums), Math.max(...nums)] : undefined;
}

export interface WaitForPortOptions {
  /** Wait until the port is listening (default) or until it is free. */
  state?: 'listening' | 'free';
  timeoutMs?: number;
  intervalMs?: number;
}

export interface WaitForPortResult {
  ok: boolean;
  elapsedMs: number;
  /** What is listening at the end (with details), when state is 'listening'. */
  entries: PortEntry[];
}

export async function waitForPort(port: number, opts: WaitForPortOptions = {}): Promise<WaitForPortResult> {
  const state = opts.state ?? 'listening';
  const timeout = opts.timeoutMs ?? 30_000;
  const interval = opts.intervalMs ?? 250;
  const started = Date.now();
  for (;;) {
    const listening = (await listPorts({ port, enrich: false })).length > 0;
    if (listening === (state === 'listening')) {
      const entries = state === 'listening' ? await listPorts({ port }) : [];
      return { ok: true, elapsedMs: Date.now() - started, entries };
    }
    if (Date.now() - started >= timeout) {
      return { ok: false, elapsedMs: Date.now() - started, entries: state === 'free' ? await listPorts({ port }) : [] };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
