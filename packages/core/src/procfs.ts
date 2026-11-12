/**
 * Linux fallback that reads /proc directly, for minimal environments (slim Docker images,
 * Dev Containers) where lsof, ss and even ps are not installed.
 */
import { readFile, readdir, readlink } from 'node:fs/promises';
import type { RawListener } from './types';
import type { PsInfo } from './unix';

/** /proc/net/tcp stores addresses as little-endian 32-bit hex words. */
function wordToBytes(hex: string): number[] {
  const b = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return b.reverse();
}

/** "0100007F" → "127.0.0.1"; 32 hex chars → "[0:0:0:0:0:0:0:1]"-style IPv6 (shortened for :: and ::1). */
export function decodeProcAddress(hex: string): string {
  if (hex.length === 8) return wordToBytes(hex).join('.');
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 8) bytes.push(...wordToBytes(hex.slice(i, i + 8)));
  if (bytes.every((x) => x === 0)) return '[::]';
  if (bytes.slice(0, 15).every((x) => x === 0) && bytes[15] === 1) return '[::1]';
  // IPv4-mapped ::ffff:a.b.c.d
  if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return `[::ffff:${bytes.slice(12).join('.')}]`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return `[${groups.join(':')}]`;
}

/** Parses /proc/net/tcp or /proc/net/tcp6: listening sockets (state 0A) with their inode. */
export function parseProcNetTcp(content: string): Array<{ address: string; port: number; inode: number }> {
  const out: Array<{ address: string; port: number; inode: number }> = [];
  for (const line of content.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== '0A') continue; // 0A = TCP_LISTEN
    const [addrHex, portHex] = cols[1].split(':');
    const port = parseInt(portHex, 16);
    const inode = Number(cols[9]);
    if (!port || !inode) continue;
    const address = decodeProcAddress(addrHex);
    out.push({ address, port, inode });
  }
  return out;
}

/** Parses /proc/<pid>/stat: { ppid, starttime (clock ticks) }. The comm field may contain spaces and ')'. */
export function parseProcStat(stat: string): { ppid: number; startTicks: number } | undefined {
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // rest[0] = state (field 3), rest[1] = ppid (field 4), rest[19] = starttime (field 22)
  const ppid = Number(rest[1]);
  const startTicks = Number(rest[19]);
  return Number.isFinite(ppid) ? { ppid, startTicks } : undefined;
}

const numericDirs = async (): Promise<number[]> => (await readdir('/proc')).filter((d) => /^\d+$/.test(d)).map(Number);

/** Listening TCP sockets from /proc, mapped to the processes that own them (only those we may inspect). */
export async function listProcListeners(): Promise<RawListener[]> {
  const sockets = [
    ...parseProcNetTcp(await readFile('/proc/net/tcp', 'utf8').catch(() => '')),
    ...parseProcNetTcp(await readFile('/proc/net/tcp6', 'utf8').catch(() => '')),
  ];
  if (sockets.length === 0) return [];
  const wanted = new Set(sockets.map((s) => s.inode));
  const owner = new Map<number, number>();
  for (const pid of await numericDirs()) {
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue; // another user's process
    }
    for (const fd of fds) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && wanted.has(Number(m[1]))) owner.set(Number(m[1]), pid);
    }
    if (owner.size === wanted.size) break;
  }
  const names = new Map<number, string>();
  for (const pid of new Set(owner.values())) {
    names.set(pid, (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '(unknown)')).trim());
  }
  return sockets.map((s) => {
    const pid = owner.get(s.inode) ?? 0;
    return { port: s.port, address: s.address, pid, processName: pid ? names.get(pid) ?? '(unknown)' : '(unknown)' };
  });
}

/** Command line, memory and uptime from /proc (CPU is not available without sampling). */
export async function getProcInfo(pids: number[]): Promise<Map<number, PsInfo>> {
  const map = new Map<number, PsInfo>();
  const uptime = Number((await readFile('/proc/uptime', 'utf8').catch(() => '0')).split(' ')[0]);
  const HZ = 100; // USER_HZ is 100 on practically every Linux system
  for (const pid of pids) {
    try {
      const [cmdline, status, stat] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`, 'utf8'),
        readFile(`/proc/${pid}/status`, 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const rss = /VmRSS:\s+(\d+)\s*kB/.exec(status);
      const st = parseProcStat(stat);
      map.set(pid, {
        command: cmdline.split('\0').filter(Boolean).join(' '),
        memoryKB: rss ? Number(rss[1]) : 0,
        cpuPercent: NaN,
        elapsed: st && uptime ? Math.max(0, Math.round(uptime - st.startTicks / HZ)) : 0,
      });
    } catch {
      /* process gone or not ours */
    }
  }
  return map;
}

/** pid → parent pid for every process we can see. */
export async function getProcParents(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const pid of await numericDirs()) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    const st = stat && parseProcStat(stat);
    if (st) map.set(pid, st.ppid);
  }
  return map;
}
