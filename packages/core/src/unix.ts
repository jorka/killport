import { readlink } from 'node:fs/promises';
import { run } from './exec';
import { getProcInfo, getProcParents, listProcListeners } from './procfs';
import type { RawListener } from './types';

/** Splits "host:port" (host may be "*", "1.2.3.4" or "[::1]"). */
export function splitHostPort(s: string): { address: string; port: number } | undefined {
  const i = s.lastIndexOf(':');
  if (i < 0) return undefined;
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { address: s.slice(0, i) || '*', port };
}

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output.
 * Field lines: p<pid>, c<command>, f<fd>, t<type>, n<name>. Each "n" is one socket.
 */
export function parseLsofListen(out: string): RawListener[] {
  const result: RawListener[] = [];
  let pid = 0;
  let name = '';
  let family = ''; // "IPv4" / "IPv6" from the t field: lsof prints "*:3000" for both wildcards
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      name = '';
    } else if (tag === 'c') {
      name = value;
    } else if (tag === 'f') {
      family = '';
    } else if (tag === 't') {
      family = value;
    } else if (tag === 'n') {
      // Listening sockets have no "->" (that would be a connection).
      if (value.includes('->')) continue;
      const hp = splitHostPort(value);
      if (!hp) continue;
      // Keep the wildcard's family: an IPv4 and an IPv6 listener on the same port are different sockets.
      const address = hp.address === '*' && family === 'IPv4' ? '0.0.0.0' : hp.address === '*' && family === 'IPv6' ? '[::]' : hp.address;
      result.push({ pid, processName: name, address, port: hp.port });
    }
  }
  return result;
}

/** Parses `lsof -a -d cwd -p <pids> -F pn` output into pid -> cwd. */
export function parseLsofCwd(out: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) map.set(pid, line.slice(1));
  }
  return map;
}

export interface PsInfo {
  command: string;
  memoryKB: number;
  /** Not available from the /proc fallback. */
  cpuPercent?: number;
  /** Seconds since the process started. */
  elapsed: number;
}

/** Parses ps "etime": [[dd-]hh:]mm:ss → seconds. */
export function parseEtime(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** Parses `ps -o pid=,rss=,%cpu=,etime=,command= -p ...` output. */
export function parsePsInfo(out: string): Map<number, PsInfo> {
  const map = new Map<number, PsInfo>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    map.set(Number(m[1]), {
      memoryKB: Number(m[2]),
      cpuPercent: Number(m[3].replace(',', '.')),
      elapsed: parseEtime(m[4]) ?? 0,
      command: m[5].trim(),
    });
  }
  return map;
}

/**
 * Parses `ss -ltnpH` output (Linux fallback when lsof is missing). Example line:
 * LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=20))
 */
export function parseSs(out: string): RawListener[] {
  const result: RawListener[] = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    // With -H there is no header; local address is column 4 (index 3).
    const hp = splitHostPort(cols[3].replace(/%[^:\]]+/, ''));
    if (!hp) continue;
    const users = cols.slice(5).join(' ');
    const procs = [...users.matchAll(/\("([^"]*)",pid=(\d+)/g)];
    if (procs.length === 0) {
      result.push({ pid: 0, processName: '(unknown)', address: hp.address, port: hp.port });
    } else {
      for (const p of procs) {
        result.push({ pid: Number(p[2]), processName: p[1], address: hp.address, port: hp.port });
      }
    }
  }
  return result;
}

export async function listUnixListeners(): Promise<RawListener[]> {
  try {
    const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pctn']);
    return parseLsofListen(r.stdout);
  } catch (err) {
    if (process.platform !== 'linux') throw err;
  }
  // Linux without lsof: try ss, then read /proc directly (slim containers have neither tool).
  try {
    const r = await run('ss', ['-ltnpH']);
    if (r.code === 0) return parseSs(r.stdout);
  } catch {
    /* ss not installed */
  }
  return listProcListeners();
}

/** Command line, memory, CPU and uptime for each pid, in one ps call. */
export async function getUnixPsInfo(pids: number[]): Promise<Map<number, PsInfo>> {
  if (pids.length === 0) return new Map();
  try {
    const r = await run('ps', ['-o', 'pid=,rss=,%cpu=,etime=,command=', '-p', pids.join(',')]);
    return parsePsInfo(r.stdout);
  } catch {
    // ps missing (minimal Linux containers): read /proc instead.
    return process.platform === 'linux' ? getProcInfo(pids) : new Map();
  }
}

export async function getUnixCwds(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  if (process.platform === 'linux') {
    const map = new Map<number, string>();
    await Promise.all(
      pids.map(async (pid) => {
        try {
          map.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          /* not ours / gone */
        }
      }),
    );
    return map;
  }
  try {
    const r = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn']);
    return parseLsofCwd(r.stdout);
  } catch {
    return new Map();
  }
}

/** pid -> parent pid for every process. */
export async function getUnixParents(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const r = await run('ps', ['-A', '-o', 'pid=,ppid=']);
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)/.exec(line);
      if (m) map.set(Number(m[1]), Number(m[2]));
    }
  } catch {
    // ps missing: on Linux read /proc. This matters for safety: the parent chain decides
    // which processes (VS Code, the agent) must never be killed.
    if (process.platform === 'linux') return getProcParents();
  }
  return map;
}
