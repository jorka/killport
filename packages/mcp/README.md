# killport-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI coding agents see which process is holding a port, and free it.

Useful when `npm run dev` fails with `EADDRINUSE: address already in use :::3000`: the agent can check what is on port 3000 (a stale dev server from another project? a Docker container?) and stop it, instead of guessing or picking another port.

Works on **macOS, Linux and Windows**. No configuration, no network access, no telemetry.

## Tools

| Tool | What it does |
| --- | --- |
| `list_ports` | Lists listening TCP ports with pid, process, command line, working directory and Docker container. Filters: `port`, `range` (`"3000-9999"`), `includeSystem`, `localhostOnly`, `includeApps` (desktop apps and editor helpers are left out unless a port is given). Read-only. |
| `find_free_port` | Is a port free? If not, which process holds it, and which nearby ports are free. Inputs: `preferred`, `range`, `count`. Read-only. |
| `wait_for_port` | Waits until a port is listening (reports the process and whether it answers HTTP) or until it is free. Inputs: `port`, `state` (`listening`/`free`), `timeoutSeconds`. Read-only. |
| `kill_port` | Frees a port. Sends a graceful terminate; `force: true` escalates to a hard kill. Ports published by Docker containers are freed with `docker stop` on that container. Marked destructive, so clients ask before running it. |

### Safety

`kill_port` will never kill:
- the agent itself, or anything in its own process tree (even with `force`)
- Docker Desktop / OrbStack / Podman themselves (that would stop every container)
- PID 0/1 or Windows "System"
- ports below 1024 unless `force: true`

## Setup

**Claude Code**

```sh
claude mcp add killport -- npx -y killport-mcp
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.killport]
command = "npx"
args = ["-y", "killport-mcp"]
```

**Cursor, Windsurf, Gemini CLI, Claude Desktop and others**

```json
{
  "mcpServers": {
    "killport": { "command": "npx", "args": ["-y", "killport-mcp"] }
  }
}
```

**VS Code / GitHub Copilot**: install the [Killport extension](https://marketplace.visualstudio.com/items?itemName=JoroGeorgiev.killport); it registers this server automatically (VS Code 1.101+), along with a panel that shows the same information.

Requires Node.js 18 or newer.

## License

MIT
