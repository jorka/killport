import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec';
import type { ContainerInfo, KillResult } from './types';

/**
 * Processes that forward container ports to the host. Killing one of these
 * stops the whole container runtime (every container), so we never do that:
 * we map the port to its container and stop just that container instead.
 */
const RUNTIME_PROCESS = /^(com\.docker\.|docker|vpnkit|orbstack|podman|gvproxy|limactl|colima|rancher)/i;

export function isContainerRuntime(processName: string): boolean {
  return RUNTIME_PROCESS.test(processName.replace(/\.exe$/i, ''));
}

/** Where the docker CLI usually lives when VS Code was not started from a shell (PATH may be minimal). */
function dockerCandidates(): string[] {
  if (process.platform === 'win32') return ['docker'];
  const home = homedir();
  return ['docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(home, '.docker/bin/docker'), join(home, '.orbstack/bin/docker'), join(home, '.rd/bin/docker')];
}

let dockerBin: string | undefined;

async function docker(args: string[], timeoutMs: number) {
  if (dockerBin) return run(dockerBin, args, timeoutMs);
  let lastErr: unknown;
  for (const bin of dockerCandidates()) {
    try {
      const r = await run(bin, args, timeoutMs);
      dockerBin = bin;
      return r;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw lastErr;
}

const FORMAT = [
  '{{.ID}}',
  '{{.Names}}',
  '{{.Image}}',
  '{{.Ports}}',
  '{{.Label "com.docker.compose.project"}}',
  '{{.Label "com.docker.compose.service"}}',
  '{{.Label "com.docker.compose.project.working_dir"}}',
  '{{.Status}}',
].join('\t');

/**
 * Parses the docker ps "Ports" column, e.g.
 * "127.0.0.1:8001->8000/tcp, 0.0.0.0:3000-3002->3000-3002/tcp, :::5432->5432/tcp, 5540/tcp"
 * and returns the published host TCP ports.
 */
export function parsePublishedPorts(ports: string): number[] {
  const out = new Set<number>();
  for (const part of ports.split(',')) {
    const m = /:(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = a; p <= b && p - a < 1000; p++) out.add(p);
  }
  return [...out];
}

/**
 * Approximate uptime in seconds from docker's status text: "Up 5 seconds", "Up About a minute",
 * "Up 3 minutes", "Up About an hour", "Up 2 hours (healthy)", "Up 3 days", "Up 2 weeks", "Up 4 months".
 */
export function parseDockerUptime(status: string | undefined): number | undefined {
  const m = /^Up (?:(About an?|Less than a)|(\d+)) (second|minute|hour|day|week|month|year)s?/i.exec(status ?? '');
  if (!m) return undefined;
  const n = m[2] ? Number(m[2]) : /less/i.test(m[1]) ? 0 : 1;
  const unit = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[3].toLowerCase() as 'second'];
  return n * unit;
}

/** Parses the tab-separated `docker ps --format FORMAT` output into hostPort -> container. */
export function parseDockerPs(out: string): Map<number, ContainerInfo> {
  const map = new Map<number, ContainerInfo>();
  for (const line of out.split(/\r?\n/)) {
    const [id, name, image, ports, project, service, workingDir, status] = line.split('\t');
    if (!id || !name) continue;
    const info: ContainerInfo = {
      id,
      name,
      image: image ?? '',
      composeProject: project || undefined,
      composeService: service || undefined,
      composeDir: workingDir || undefined,
      status: status || undefined,
    };
    for (const port of parsePublishedPorts(ports ?? '')) map.set(port, info);
  }
  return map;
}

/** Running containers by published host port. Empty if docker is missing or not running. */
export async function getContainersByPort(): Promise<Map<number, ContainerInfo>> {
  try {
    const r = await docker(['ps', '--format', FORMAT], 4000);
    return r.code === 0 ? parseDockerPs(r.stdout) : new Map();
  } catch {
    return new Map();
  }
}

/** Stops one container (`docker stop`, or `docker kill` when forced). */
export async function stopContainer(container: ContainerInfo, opts: { force?: boolean } = {}): Promise<KillResult> {
  const method = opts.force ? 'docker kill' : 'docker stop';
  try {
    const r = await docker([opts.force ? 'kill' : 'stop', container.id], 30000);
    if (r.code === 0) return { pid: 0, ok: true, method };
    return { pid: 0, ok: false, method, code: 'UNKNOWN', error: (r.stderr || r.stdout).trim() || `${method} failed` };
  } catch (err) {
    return { pid: 0, ok: false, method, code: 'UNKNOWN', error: `Could not run docker: ${(err as Error).message}` };
  }
}
