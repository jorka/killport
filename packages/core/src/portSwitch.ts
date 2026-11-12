/**
 * Rewrites the command that started a server so it listens on another port.
 * A process can't change its listening port, so "switching" means restarting with this command.
 * The result is a best guess shown to the user for confirmation/editing before it runs.
 */

export type ShellKind = 'posix' | 'pwsh' | 'cmd';

export interface PortRewrite {
  command: string;
  /**
   * replaced: the old port was written in the command and was changed.
   * flag:     the dev tool was recognised and its port flag was added.
   * env:      fallback, PORT=<new> set for the command (Express, CRA, most Node apps read it).
   */
  how: 'replaced' | 'flag' | 'env';
  /** Tool that was recognised, for messages ("vite", "next"...). */
  tool?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Dev tools and how to pass them a port. Matched against the process command line and the typed command. */
const TOOLS: Array<{ name: string; match: RegExp; flag: (p: number) => string }> = [
  { name: 'vite', match: /[\\/]vite(\.js)?(\s|$)|[\\/]vite[\\/]bin|(^|\s)vite(\s|$)/, flag: (p) => `--port ${p}` },
  { name: 'next', match: /[\\/]next[\\/]dist[\\/]|(^|\s)next\s+(dev|start)/, flag: (p) => `--port ${p}` },
  { name: 'nuxt', match: /nuxi|[\\/]nuxt[\\/]|(^|\s)nuxt\s/, flag: (p) => `--port ${p}` },
  { name: 'astro', match: /[\\/]astro[\\/]|(^|\s)astro\s+(dev|preview)/, flag: (p) => `--port ${p}` },
  { name: 'angular', match: /@angular[\\/]cli|(^|\s)ng\s+serve/, flag: (p) => `--port ${p}` },
  { name: 'webpack', match: /webpack(-dev-server)?([\\/]|\s|$)|webpack\s+serve/, flag: (p) => `--port ${p}` },
  { name: 'remix', match: /@remix-run[\\/]dev|(^|\s)remix\s+dev/, flag: (p) => `--port ${p}` },
  { name: 'vue-cli', match: /vue-cli-service\s+serve/, flag: (p) => `--port ${p}` },
  { name: 'parcel', match: /[\\/]parcel[\\/]|(^|\s)parcel(\s|$)/, flag: (p) => `--port ${p}` },
  { name: 'storybook', match: /storybook/, flag: (p) => `-p ${p}` },
  { name: 'gatsby', match: /gatsby\s+develop|[\\/]gatsby[\\/]/, flag: (p) => `-p ${p}` },
  { name: 'docusaurus', match: /docusaurus\s+start/, flag: (p) => `--port ${p}` },
  { name: 'expo', match: /expo\s+start|[\\/]expo[\\/]bin/, flag: (p) => `--port ${p}` },
  { name: 'http-server', match: /http-server/, flag: (p) => `-p ${p}` },
  { name: 'uvicorn', match: /uvicorn/, flag: (p) => `--port ${p}` },
  { name: 'flask', match: /flask\s+run/, flag: (p) => `--port ${p}` },
  { name: 'django', match: /manage\.py\s+runserver/, flag: (p) => `${p}` },
  { name: 'rails', match: /rails\s+s(erver)?(\s|$)|bin[\\/]rails/, flag: (p) => `-p ${p}` },
  { name: 'artisan', match: /artisan\s+serve/, flag: (p) => `--port=${p}` },
  { name: 'symfony', match: /symfony\s+(serve|server:start|local:server:start)/, flag: (p) => `--port=${p}` },
  { name: 'hugo', match: /hugo\s+server/, flag: (p) => `--port ${p}` },
  { name: 'jekyll', match: /jekyll\s+serve/, flag: (p) => `--port ${p}` },
  // Generic last: the `serve` package would otherwise match "php artisan serve", "symfony serve"...
  { name: 'serve', match: /[\\/]serve[\\/]build|(^|\s)serve(\s|$)/, flag: (p) => `-l ${p}` },
];

/** Package-manager script runners: extra flags must follow `--` for npm. */
const NPM_RUN = /^\s*npm\s+(run(-script)?\s+\S+|start|run\s*$)/;
const OTHER_RUNNERS = /^\s*(pnpm|yarn|bun|npx|pnpx|bunx)\s/;

export function detectTool(...commands: Array<string | undefined>): string | undefined {
  const text = commands.filter(Boolean).join('\n');
  return TOOLS.find((t) => t.match.test(text))?.name;
}

/** Sets PORT for the command in the given shell's syntax. */
export function withPortEnv(command: string, port: number, shell: ShellKind): string {
  const cmd = command.replace(/^\s*PORT=\d+\s+/, ''); // replace an existing PORT= prefix
  if (shell === 'pwsh') return `$env:PORT=${port}; ${cmd}`;
  if (shell === 'cmd') return `set PORT=${port}&& ${cmd}`;
  return `PORT=${port} ${cmd}`;
}

export function rewriteCommandForPort(
  command: string,
  oldPort: number,
  newPort: number,
  opts: { processCommand?: string; shell?: ShellKind } = {},
): PortRewrite {
  const shell = opts.shell ?? 'posix';
  const old = escapeRe(String(oldPort));

  // 1. The old port is written in the command: change it there.
  const explicit = [
    new RegExp(`(--port[= ]|--listen[= ]|-p[= ]?|-l[= ]|--http-port[= ]|PORT=|\\$env:PORT=|PORT\\s*=\\s*)${old}\\b`, 'g'),
    new RegExp(`(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]|\\s|^):${old}\\b`, 'g'),
    new RegExp(`(\\s)${old}(?=\\s|$)`, 'g'), // a bare argument: "http.server 3000", "runserver 3000"
  ];
  for (const re of explicit) {
    if (re.test(command)) {
      re.lastIndex = 0;
      return { command: command.replace(re, (m) => m.replace(String(oldPort), String(newPort))), how: 'replaced', tool: detectTool(opts.processCommand, command) };
    }
  }

  // 2. A known dev tool: add its port flag (after `--` for npm scripts).
  const tool = TOOLS.find((t) => t.match.test(`${opts.processCommand ?? ''}\n${command}`));
  if (tool) {
    const flag = tool.flag(newPort);
    let cmd = command.trimEnd();
    if (NPM_RUN.test(cmd)) cmd += / -- /.test(cmd) || /\s--$/.test(cmd) ? ` ${flag}` : ` -- ${flag}`;
    else cmd += ` ${flag}`;
    // Also set PORT: harmless for tools that ignore it, and some (next) honour both.
    return { command: cmd, how: 'flag', tool: tool.name };
  }

  // 3. Unknown: most Node servers (Express, CRA, Koa, Fastify templates...) read PORT.
  return { command: withPortEnv(command, newPort, shell), how: 'env' };
}

/** "npm run dev" style commands that go through a package manager (OTHER_RUNNERS exported for completeness). */
export const isScriptRunner = (cmd: string) => NPM_RUN.test(cmd) || OTHER_RUNNERS.test(cmd);
