import { existsSync, statSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';

/**
 * Windows has no tool that reports another process's working directory, so we infer the project
 * folder from the command line: `node C:\proj\node_modules\vite\bin\vite.js` → C:\proj,
 * `python C:\proj\api\main.py` → the nearest folder above it with a project marker.
 */

const MARKERS = ['package.json', '.git', 'pyproject.toml', 'requirements.txt', 'composer.json', 'go.mod', 'Cargo.toml', 'Gemfile', 'manage.py', 'deno.json', 'pom.xml', 'build.gradle'];

/** Splits a Windows command line into arguments, respecting double quotes. */
export function splitWindowsArgs(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

const isAbsWin = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\');

/**
 * The folder to search from, before looking for project markers. Pure (no file system), for tests:
 * the first absolute path argument after the executable; for anything inside node_modules, the
 * folder that contains node_modules.
 */
export function pathFromCommand(command: string | undefined): { path: string; insideNodeModules: boolean } | undefined {
  if (!command) return undefined;
  const args = splitWindowsArgs(command).slice(1);
  for (const raw of args) {
    const a = raw.replace(/^--?[\w-]+=/, ''); // --config=C:\proj\vite.config.ts
    if (!isAbsWin(a)) continue;
    const nm = a.search(/[\\/]node_modules[\\/]/i);
    if (nm > 0) return { path: a.slice(0, nm), insideNodeModules: true };
    return { path: a, insideNodeModules: false };
  }
  return undefined;
}

/** Best-effort project folder for a Windows process, or undefined. */
export function guessCwdFromCommand(command: string | undefined): string | undefined {
  const found = pathFromCommand(command);
  if (!found) return undefined;
  if (found.insideNodeModules) return found.path;
  let dir = found.path;
  try {
    if (!existsSync(dir)) return undefined;
    if (statSync(dir).isFile()) dir = dirname(dir);
  } catch {
    return undefined;
  }
  // Walk up to the project root (a folder with package.json, .git, ...); stop at the drive root.
  for (let d = dir, i = 0; i < 8; i++) {
    if (MARKERS.some((m) => existsSync(join(d, m)))) return d;
    const parent = win32.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return dir;
}
