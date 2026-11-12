import type { PortEntry } from './types';

/**
 * "Hide apps & system": a predictable rule based on *where a program is installed*, not on guessing.
 * Hidden: desktop apps (inside a macOS .app bundle), OS services, and helpers that editors and AI
 * agents run from their extensions folder. Docker containers are never hidden.
 */
const APP_OR_SYSTEM_PATH = /(\.app[\\/]Contents[\\/]|^\/System\/|^\/usr\/(libexec|sbin)\/|^\/sbin\/|^[a-z]:\\windows\\)/i;

/** Editor / agent helpers: ~/.vscode/extensions/..., ~/.cursor/extensions/..., ~/.vscode-server/... (remote). */
const EDITOR_HELPER_PATH = /[\\/]\.(vscode|vscode-insiders|vscode-oss|cursor|windsurf|positron)(-server)?[\\/](extensions|bin|cli)[\\/]/i;

/**
 * Dev servers that are commonly *installed* as desktop apps (Postgres.app, DBngin, Laravel Herd,
 * Ollama, LM Studio...). They live in a .app bundle but you still want to see them.
 */
const DEV_SERVER_IN_APP = /^(postgres|postmaster|mysqld|mariadbd|mongod|redis-server|valkey-server|memcached|php|php-fpm|php-cgi|nginx|httpd|caddy|node|bun|deno|python[\d.]*|ruby|java|ollama|lm-studio|LM Studio)$/i;

export type HiddenKind = 'app' | 'system' | 'editor';

/** Why an entry is hidden by "Hide apps & system", or undefined if it is shown. */
export function appOrSystemKind(e: Pick<PortEntry, 'processName' | 'command' | 'container' | 'isContainerRuntime'>): HiddenKind | undefined {
  if (e.container) return undefined;
  if (e.isContainerRuntime) return 'app'; // Docker Desktop's own ports, not a container's
  const cmd = e.command ?? '';
  if (EDITOR_HELPER_PATH.test(cmd)) return 'editor';
  if (!APP_OR_SYSTEM_PATH.test(cmd)) return undefined;
  if (DEV_SERVER_IN_APP.test(e.processName.replace(/\.exe$/i, ''))) return undefined;
  return /\.app[\\/]Contents[\\/]/i.test(cmd) && !/^\/System\//.test(cmd) ? 'app' : 'system';
}

export const isAppOrSystem = (e: Parameters<typeof appOrSystemKind>[0]) => appOrSystemKind(e) !== undefined;
