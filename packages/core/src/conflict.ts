/** A "port already in use" error spotted in terminal output. */
export interface PortConflict {
  /** The port, when the message names it. */
  port?: number;
  /**
   * failed: the server could not start (node EADDRINUSE, go, python, rails, php, spring...).
   * moved:  the dev server picked another port by itself (vite, next) and kept running.
   */
  kind: 'failed' | 'moved';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const valid = (n: number) => Number.isInteger(n) && n > 0 && n <= 65535;

/** Dev servers that notice the port is busy and move to another one. */
const MOVED: RegExp[] = [
  /\bport (\d{2,5}) is (?:already )?in use(?: by [^,]*)?,? (?:trying|using)/i, // vite, next
];

/** Servers that fail to start, with the port in the message. */
const FAILED: RegExp[] = [
  /EADDRINUSE\b[^\n]*?(?:::|\]|[\w.-]):(\d{2,5})\b/, // node: listen EADDRINUSE: address already in use :::3000
  /listen tcp [^\s]*:(\d{2,5}): bind: address already in use/i, // go
  /bind\(2\) for "?[^"\s]*"? port (\d{2,5})/i, // ruby / puma / rails
  /Failed to listen on [^\s]*:(\d{2,5})/i, // php -S
  /\bport (\d{2,5}) was already in use/i, // spring boot
  /something is already running on port (\d{2,5})/i, // create-react-app
  /\bport (\d{2,5}) is (?:already )?in use/i, // generic (after MOVED has been checked)
  /\bport (\d{2,5}) (?:is )?already (?:in use|bound|allocated)/i,
  /(?:address|port) already in use[^\n]*?[:\s](\d{2,5})\b/i,
  /Bind for [^\s]*:(\d{2,5}) failed: port is already allocated/i, // docker
  /bind on address \(['"][^'"]*['"],\s*(\d{2,5})\)/i, // uvicorn / asyncio: ('127.0.0.1', 8000)
];

/** Same failure, but the message does not include the port (python, uvicorn on some versions...). */
const FAILED_NO_PORT = /address already in use|EADDRINUSE|\[Errno (?:48|98)\]|WinError 10048|only one usage of each socket address/i;

/** Looks for a "port already in use" error in a chunk of terminal output. */
export function parsePortConflict(output: string): PortConflict | undefined {
  const text = output.replace(ANSI, '');
  for (const re of MOVED) {
    const m = re.exec(text);
    if (m && valid(Number(m[1]))) return { port: Number(m[1]), kind: 'moved' };
  }
  for (const re of FAILED) {
    const m = re.exec(text);
    if (m && valid(Number(m[1]))) return { port: Number(m[1]), kind: 'failed' };
  }
  if (FAILED_NO_PORT.test(text)) return { kind: 'failed' };
  return undefined;
}

/**
 * Best-effort guess of the port from the command that failed, for errors that
 * don't name it: "python -m http.server 8000", "uvicorn app:app --port 8001",
 * "PORT=4000 npm start", "php -S localhost:8080", "rails s -p 3001".
 */
export function portFromCommand(command: string | undefined): number | undefined {
  if (!command) return undefined;
  const patterns = [
    /(?:--port|--listen|-p)(?:[ =]|(?=\d))(?:[\w.-]+:)?(\d{2,5})\b/,
    /\bPORT=(\d{2,5})\b/,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]|^|\s):(\d{2,5})\b/,
    /\bhttp\.server\s+(\d{2,5})\b/,
    /\s(\d{4,5})\s*$/,
  ];
  for (const re of patterns) {
    const m = re.exec(command);
    if (m && valid(Number(m[1]))) return Number(m[1]);
  }
  return undefined;
}
