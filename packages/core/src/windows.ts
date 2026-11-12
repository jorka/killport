import { run } from './exec';
import { splitHostPort } from './unix';
import type { RawListener } from './types';

/**
 * Parses `netstat -ano -p TCP` output. Listening sockets are detected by the
 * foreign address being 0.0.0.0:0 / [::]:0 rather than by the "LISTENING"
 * state text, which is translated on non-English Windows.
 */
export function parseNetstat(out: string): Array<{ address: string; port: number; pid: number }> {
  const result: Array<{ address: string; port: number; pid: number }> = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue;
    const foreign = cols[2];
    if (foreign !== '0.0.0.0:0' && foreign !== '[::]:0' && foreign !== '*:*') continue;
    const hp = splitHostPort(cols[1].replace(/%\d+(?=\])/, ''));
    const pid = Number(cols[cols.length - 1]);
    if (hp && Number.isInteger(pid)) result.push({ ...hp, pid });
  }
  return result;
}

/** Parses one CSV line with quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  const re = /"((?:[^"]|"")*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) fields.push(m[1].replace(/""/g, '"'));
  return fields;
}

export interface TasklistInfo {
  name: string;
  memoryKB?: number;
}

/** Parses `tasklist /FO CSV /NH` output into pid -> image name + memory. */
export function parseTasklist(out: string): Map<number, TasklistInfo> {
  const map = new Map<number, TasklistInfo>();
  for (const line of out.split(/\r?\n/)) {
    const f = parseCsvLine(line);
    if (f.length < 2 || !/^\d+$/.test(f[1])) continue;
    // Memory looks like "45,000 K" / "45.000 K" / "45 000 K" depending on locale.
    const mem = f[4] ? Number(f[4].replace(/[^\d]/g, '')) : NaN;
    map.set(Number(f[1]), { name: f[0], memoryKB: Number.isFinite(mem) && f[4] ? mem : undefined });
  }
  return map;
}

export interface WinProcessInfo {
  pid: number;
  ppid: number;
  command?: string;
  /** Process start time, epoch ms. */
  startedAt?: number;
}

/** CreationDate as serialised by ConvertTo-Json: "/Date(1731400000000)/" (PS 5.1) or ISO (PS 7). */
export function parseCimDate(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /\/Date\((\d+)\)\//.exec(v);
  if (m) return Number(m[1]);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Parses PowerShell `Get-CimInstance Win32_Process | ConvertTo-Json` output. */
export function parseCimProcesses(out: string): Map<number, WinProcessInfo> {
  const map = new Map<number, WinProcessInfo>();
  const text = out.trim();
  if (!text) return map;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return map;
  }
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows as Array<Record<string, unknown>>) {
    const pid = Number(row.ProcessId);
    if (!Number.isInteger(pid)) continue;
    map.set(pid, {
      pid,
      ppid: Number(row.ParentProcessId) || 0,
      command: typeof row.CommandLine === 'string' && row.CommandLine ? row.CommandLine : undefined,
      startedAt: parseCimDate(row.CreationDate),
    });
  }
  return map;
}

/** Image name + memory from the last tasklist call (reused by listPorts for the memory column). */
export let lastTasklist = new Map<number, TasklistInfo>();

export async function listWindowsListeners(opts: { names?: boolean } = {}): Promise<RawListener[]> {
  // tasklist is the slow part; skip it when only "is something listening?" matters (wait_for_port polling).
  const names = opts.names ?? true;
  const [ns, tl] = await Promise.all([
    run('netstat', ['-ano', '-p', 'TCP']),
    names ? run('tasklist', ['/FO', 'CSV', '/NH']).catch(() => ({ stdout: '' })) : Promise.resolve({ stdout: '' }),
  ]);
  // netstat -p TCP only shows IPv4; also ask for TCPv6.
  const ns6 = await run('netstat', ['-ano', '-p', 'TCPv6']).catch(() => ({ stdout: '' }));
  if (names) lastTasklist = parseTasklist(tl.stdout);
  return [...parseNetstat(ns.stdout), ...parseNetstat(ns6.stdout)].map((s) => ({
    ...s,
    processName: s.pid === 0 ? 'System Idle Process' : lastTasklist.get(s.pid)?.name ?? '(unknown)',
  }));
}

/** All processes, or only `pids` when given (much faster). */
export async function getWindowsProcesses(pids?: number[]): Promise<Map<number, WinProcessInfo>> {
  if (pids && pids.length === 0) return new Map();
  const filter = pids ? ` -Filter "${pids.map((p) => `ProcessId=${Math.trunc(p)}`).join(' OR ')}"` : '';
  try {
    const r = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`,
      ],
      10000,
    );
    return parseCimProcesses(r.stdout);
  } catch {
    return new Map();
  }
}
