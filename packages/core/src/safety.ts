import { getUnixParents } from './unix';
import { getWindowsProcesses } from './windows';

export async function getParentMap(): Promise<Map<number, number>> {
  if (process.platform === 'win32') {
    const procs = await getWindowsProcesses();
    return new Map([...procs.values()].map((p) => [p.pid, p.ppid]));
  }
  return getUnixParents();
}

/** Returns pid plus all its ancestors, using a pid -> ppid map. */
export function ancestorChain(pid: number, parents: Map<number, number>): Set<number> {
  const chain = new Set<number>();
  let cur: number | undefined = pid;
  while (cur && cur > 0 && !chain.has(cur)) {
    chain.add(cur);
    cur = parents.get(cur);
  }
  return chain;
}

/** PIDs that must never be killed: OS core processes plus our own process and every ancestor. */
export function protectedPidsFrom(selfPid: number, parents: Map<number, number>): Set<number> {
  const set = ancestorChain(selfPid, parents);
  set.add(0);
  set.add(1);
  if (process.platform === 'win32') set.add(4); // "System"
  return set;
}

export async function getProtectedPids(selfPid = process.pid): Promise<Set<number>> {
  return protectedPidsFrom(selfPid, await getParentMap());
}
