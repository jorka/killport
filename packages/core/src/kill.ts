import { run } from './exec';
import type { KillResult } from './types';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

function errorResult(pid: number, err: unknown, method: string): KillResult {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPERM') {
    return { pid, ok: false, method, code: 'EPERM', error: 'Permission denied: the process belongs to another user (try running with sudo / as administrator).' };
  }
  if (code === 'ESRCH') {
    return { pid, ok: true, method, code: 'ESRCH', error: 'Process had already exited.' };
  }
  return { pid, ok: false, method, code: 'UNKNOWN', error: String((err as Error).message ?? err) };
}

export interface KillOptions {
  /**
   * false (default): ask the process to exit (SIGTERM / taskkill) and report if it is still running.
   * true: if it does not exit within the grace period, kill it hard (SIGKILL / taskkill /F).
   */
  force?: boolean;
  /** How long to wait for a graceful exit, ms. Default 1500. */
  graceMs?: number;
}

export async function killPid(pid: number, opts: KillOptions = {}): Promise<KillResult> {
  const grace = opts.graceMs ?? 1500;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid, ok: false, code: 'PROTECTED', error: 'Unknown or invalid PID.' };
  }

  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    let r = await run('taskkill', args);
    let method = 'taskkill';
    // Console programs (node, python, ...) have no window to close, so a graceful taskkill always fails
    // with "can only be terminated forcefully". Windows has no gentler option for them: use /F.
    const consoleOnly = r.code !== 0 && /forcefully|\/F\b/i.test(r.stderr + r.stdout);
    if (r.code !== 0 && (opts.force || consoleOnly)) {
      r = await run('taskkill', [...args, '/F']);
      method = 'taskkill /F';
    }
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim();
      if (/denied/i.test(msg)) return { pid, ok: false, method, code: 'EPERM', error: 'Access denied (try running as administrator).' };
      if (!isAlive(pid)) return { pid, ok: true, method };
      return { pid, ok: false, method, code: opts.force ? 'UNKNOWN' : 'STILL_RUNNING', error: msg || 'taskkill failed' + (opts.force ? '' : ' (try force kill)') };
    }
    const exited = await waitForExit(pid, grace);
    return exited ? { pid, ok: true, method } : { pid, ok: false, method, code: 'STILL_RUNNING', error: 'Process is still running.' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return errorResult(pid, err, 'SIGTERM');
  }
  if (await waitForExit(pid, grace)) return { pid, ok: true, method: 'SIGTERM' };
  if (!opts.force) {
    return { pid, ok: false, method: 'SIGTERM', code: 'STILL_RUNNING', error: 'Process ignored SIGTERM and is still running (use force kill).' };
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    return errorResult(pid, err, 'SIGKILL');
  }
  return (await waitForExit(pid, 1000))
    ? { pid, ok: true, method: 'SIGKILL' }
    : { pid, ok: false, method: 'SIGKILL', code: 'STILL_RUNNING', error: 'Process survived SIGKILL.' };
}
