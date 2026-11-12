export interface PortEntry {
  /** TCP port number being listened on. */
  port: number;
  protocol: 'tcp';
  /** Local addresses bound for this port/pid, e.g. ["*", "[::1]", "127.0.0.1"]. */
  addresses: string[];
  /** Owning process id. 0 when the OS would not reveal it (permissions). */
  pid: number;
  /** Short process name, e.g. "node". */
  processName: string;
  /** Full command line, when available. */
  command?: string;
  /** Working directory of the process, when available (not on Windows). */
  cwd?: string;
  /** Resident memory of the process in KB. */
  memoryKB?: number;
  /** CPU usage in percent (macOS/Linux only). */
  cpuPercent?: number;
  /** When the process started, epoch ms. */
  startedAt?: number;
  /** Name of the VS Code terminal the process was started from (set by the VS Code extension). */
  terminal?: string;
  /** Set when the port answers HTTP(S) (filled in by callers that probe; see http.ts). */
  http?: 'http' | 'https';
  /** Set when the port is published by a container: kill means `docker stop` for this container. */
  container?: ContainerInfo;
  /**
   * True when the listener is the container runtime itself (Docker Desktop, OrbStack, ...)
   * and no container could be matched. Killing it would stop every container, so it is refused.
   */
  isContainerRuntime?: boolean;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  composeProject?: string;
  composeService?: string;
  /** docker compose working directory (the project folder). */
  composeDir?: string;
  /** docker ps status text, e.g. "Up 2 hours". */
  status?: string;
}

/** One raw listening socket as reported by the OS, before merging. */
export interface RawListener {
  port: number;
  address: string;
  pid: number;
  processName: string;
}

export interface ListOptions {
  /** Only return this exact port. */
  port?: number;
  /** Port range filter, e.g. "3000-9999" or "3000-3999,5432,8080". */
  range?: string;
  /** Include ports below 1024. Default true. */
  includeSystem?: boolean;
  /** Look up full command line and cwd. Default true. */
  enrich?: boolean;
  /** Only return ports bound to loopback (127.0.0.1 / ::1), i.e. not reachable from the network. */
  localhostOnly?: boolean;
}

export interface KillResult {
  pid: number;
  ok: boolean;
  /** Signal / method used, e.g. "SIGTERM", "SIGKILL", "taskkill", "taskkill /F". */
  method?: string;
  /** Present when ok is false. */
  error?: string;
  /** Machine readable reason for failures. */
  code?: 'EPERM' | 'ESRCH' | 'PROTECTED' | 'STILL_RUNNING' | 'UNKNOWN';
}
