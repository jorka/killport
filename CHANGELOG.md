# Changelog

All notable changes to Killport (the VS Code extension and the `killport-mcp` server) are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - Unreleased

First public preview.

### Panel
- **Killport** tab next to Terminal: every listening TCP port with process, PID, address, uptime, memory/CPU, folder and command.
- Kill (graceful, Shift+click to force), with confirmation; refuses to kill VS Code itself or system processes.
- Select several rows and **Kill N selected**.
- Sort by any column; filter by port, process, command, folder, container or label; `:3000` matches exactly one port.
- **Hide apps & system** (on by default) and **This workspace** switches, with a note saying what is hidden; Address column shows `localhost` / `all interfaces`.
- Name your ports (✎), stored in `killport.portLabels`.
- Status bar count, ⚙ settings button, `Kill Process on Port…` quick pick.

### Workflow
- `killport` task type to free ports before debugging (`preLaunchTask`); labeled ports appear in Run Task.
- **Stop Servers Started in This Workspace** command, and `killport.stopServersOnClose` to do it when the window closes.
- Web servers are detected (HTTP/HTTPS) and their port opens in the browser or Simple Browser. Databases and other non-HTTP services are never probed.
- Shows which VS Code terminal started each server, with a button to jump to it (also offered in the "port in use" prompt).
- Watched ports (`killport.watchPorts`, ☆ in the panel): shown when down, status bar warning, notifications when they stop or start.

### Move to another port
- **⇄ Move** (and `Killport: Move Server to Another Port…`): restarts a server on another port, rewriting its command (port in the command → changed; known tool → its port option; otherwise `PORT=`). The command is shown for editing first; restarts in the same terminal via Ctrl+C when possible; label and watch follow.
- The "port in use" prompt offers **Use <free port>** to run your command on a free port instead.

### Shared ports
- Detects two programs on the same port, one on IPv4 and one on IPv6 (allowed by the OS, but `localhost` and `127.0.0.1` then reach different apps): **⚠ shared** badge, `IPv4`/`IPv6` labels, correct ↗ address per row, a one-time warning with **Move one…**, and a warning in MCP `list_ports`.
- `lsof` wildcards now keep their address family (`0.0.0.0` vs `[::]`) instead of both showing as `*`.
- Move targets the chosen process when several listen on the port.

### Remote
- Runs where the workspace runs (WSL, SSH, Dev Containers, Codespaces) and shows where in the panel.
- Linux fallback to `/proc` when `lsof`, `ss` or `ps` are missing (slim containers), including the parent-process check that protects VS Code itself.

### Docker
- Ports published by Docker Desktop, OrbStack or Podman show the container (service, image, compose folder, uptime).
- **Stop** runs `docker stop` on that container only; the container runtime itself is never killed.

### Terminal
- Detects "port already in use" errors (Node, Vite, Next, Go, Python/uvicorn, Rails, PHP, Spring, CRA, Docker) and offers **Kill & Run Again**. Requires VS Code 1.93+ with shell integration.

### AI agents (MCP)
- `killport-mcp` server with `list_ports`, `kill_port`, `find_free_port` and `wait_for_port` tools for Claude Code, Codex, Cursor, Gemini CLI, Copilot and others; registered automatically in VS Code 1.101+.

### Platforms
- macOS, Linux (lsof, ss or /proc) and Windows (netstat, tasklist, PowerShell).
