import { execFile } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs a binary with arguments (no shell). Resolves even on a non-zero exit code,
 * because tools like lsof exit 1 when nothing matches. Rejects only when the
 * binary cannot be started (e.g. ENOENT) or the timeout is hit.
 */
export function run(file: string, args: string[], timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (typeof e.code === 'string' || e.killed) {
            reject(err);
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr), code: typeof e.code === 'number' ? e.code : 1 });
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
      },
    );
  });
}
