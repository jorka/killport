// Integration tests: run inside a real VS Code instance (see test/runTest.mjs).
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'JoroGeorgiev.killport';
// The extension host runs on Electron; this env makes the same binary behave like plain node.
const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

// Newer terminal APIs: reading them on old VS Code (where they were proposals) throws, so guard the read.
const hasShellApis = () => {
  try {
    // On 1.90-1.92 these exist but subscribing throws (they were proposals), so actually subscribe.
    vscode.window.onDidStartTerminalShellExecution(() => {}).dispose();
    vscode.window.onDidChangeTerminalShellIntegration(() => {}).dispose();
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Starts a separate node process listening on 127.0.0.1:port; resolves once it is listening. */
function startServer(port, cwd) {
  const script = `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1', () => console.log('ready'))`;
  const child = spawn(process.execPath, ['-e', script], {
    cwd,
    env: NODE_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('ready') && resolve(child));
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`test server exited early (${code})`)));
  });
}

const exited = (child) => new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', () => r())));

describe('Killport extension', function () {
  /** @type {import('vscode').Extension<any>} */
  let ext;
  const children = [];

  before(async () => {
    ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    await ext.activate();
    // Killing from tests must not open modal dialogs.
    await vscode.workspace.getConfiguration('killport').update('confirmBeforeKill', false, vscode.ConfigurationTarget.Global);
  });

  after(() => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  });

  it('activates and registers its commands', async () => {
    assert.strictEqual(ext.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['killport.refresh', 'killport.killPort', 'killport.show', 'killport.openSettings', 'killport.editLabel', 'killport.toggleHideApps', 'killport.toggleWorkspaceOnly']) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  it('opens the panel', async () => {
    await vscode.commands.executeCommand('killport.show');
    await vscode.commands.executeCommand('killport.refresh');
  });

  it('kills the process listening on a port', async () => {
    const port = await freePort();
    const child = await startServer(port, process.env.KILLPORT_TEST_WORKSPACE);
    children.push(child);
    assert.strictEqual(await isPortFree(port), false, 'test server should hold the port');

    await vscode.commands.executeCommand('killport.killPort', port);

    await Promise.race([exited(child), sleep(5000).then(() => assert.fail('process was not killed'))]);
    await waitFor(() => isPortFree(port), 5000, `port ${port} to be free`);
  });

  it('refuses to kill VS Code itself', async () => {
    // A server inside the extension host: killing its owner would kill VS Code.
    const port = await freePort();
    const server = net.createServer();
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    try {
      await vscode.commands.executeCommand('killport.killPort', port);
      await sleep(500);
      assert.strictEqual(server.listening, true, 'the extension host server must still be listening');
    } finally {
      server.close();
    }
  });

  it('ships an MCP server that starts on VS Code\'s own runtime', async () => {
    const server = spawn(process.execPath, [path.join(ext.extensionPath, 'dist', 'mcp-server.js')], { env: NODE_ENV, stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(server);
    let buf = '';
    const responses = new Map();
    server.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        responses.get(msg.id)?.(msg);
      }
    });
    const request = (id, method, params) =>
      new Promise((resolve) => {
        responses.set(id, resolve);
        server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '1' } });
    const list = await request(2, 'tools/list', {});
    assert.deepStrictEqual(list.result.tools.map((t) => t.name).sort(), ['find_free_port', 'kill_port', 'list_ports', 'wait_for_port']);
    server.kill();
  });

  it('stops only the servers started from this workspace', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const inside = path.join(process.env.KILLPORT_TEST_WORKSPACE, 'apps', 'web');
    fs.mkdirSync(inside, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'killport-outside-'));
    const [p1, p2] = [await freePort(), await freePort()];
    const mine = await startServer(p1, inside);
    const other = await startServer(p2, outside);
    children.push(mine, other);

    await vscode.commands.executeCommand('killport.stopWorkspaceServers');

    await Promise.race([exited(mine), sleep(5000).then(() => assert.fail('workspace server was not stopped'))]);
    await sleep(300);
    assert.strictEqual(other.exitCode, null, 'a server outside the workspace must keep running');
    assert.strictEqual(await isPortFree(p2), false);
  });

  it('detects web servers so their port opens in the browser', async () => {
    const port = await freePort();
    const child = await startServer(port, process.env.KILLPORT_TEST_WORKSPACE);
    children.push(child);
    await waitFor(async () => {
      await ext.exports.refresh();
      return ext.exports.getPorts().find((e) => e.port === port)?.http === 'http';
    }, 10000, `port ${port} to be detected as http`);
    child.kill();
  });

  it('knows which VS Code terminal started a server', async function () {
    this.timeout(30000);
    const port = await freePort();
    const terminal = vscode.window.createTerminal({ name: 'dev-server', cwd: process.env.KILLPORT_TEST_WORKSPACE, ...(process.platform === 'win32' ? {} : { shellPath: '/bin/bash' }) });
    try {
      const script = `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')`;
      terminal.sendText(
        process.platform === 'win32'
          ? `$env:ELECTRON_RUN_AS_NODE=1; & "${process.execPath}" -e "${script}"`
          : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" -e "${script}"`,
      );
      await waitFor(async () => !(await isPortFree(port)), 15000, 'server in terminal to listen');
      await ext.exports.refresh();
      const entry = ext.exports.getPorts().find((e) => e.port === port);
      assert.ok(entry, 'port should be listed');
      assert.strictEqual(entry.terminal, 'dev-server');
    } finally {
      terminal.dispose();
    }
    await waitFor(() => isPortFree(port), 10000, 'server to stop with its terminal');
  });

  it('reports when a watched port starts and stops listening', async function () {
    this.timeout(30000);
    const cfg = () => vscode.workspace.getConfiguration('killport');
    await cfg().update('notifyWatchedPorts', false, vscode.ConfigurationTarget.Global);
    const port = await freePort();
    await cfg().update('watchPorts', [port], vscode.ConfigurationTarget.Global);
    await ext.exports.refresh();

    const next = (listening) =>
      new Promise((resolve) => {
        const sub = ext.exports.onDidChangeWatchedPort((c) => {
          if (c.port === port && c.listening === listening) {
            sub.dispose();
            resolve();
          }
        });
      });

    try {
      const up = next(true);
      const child = await startServer(port, process.env.KILLPORT_TEST_WORKSPACE);
      children.push(child);
      await ext.exports.refresh();
      await Promise.race([up, sleep(5000).then(() => assert.fail('no "listening" event'))]);

      const down = next(false);
      child.kill();
      await exited(child);
      await ext.exports.refresh();
      await Promise.race([down, sleep(5000).then(() => assert.fail('no "stopped" event'))]);
    } finally {
      await cfg().update('watchPorts', [], vscode.ConfigurationTarget.Global);
    }
  });

  describe('move a server to another port', () => {
    const fs = require('node:fs');
    // A typical small server: port from --port, else PORT, else 3000.
    const serverJs = `const i = process.argv.indexOf('--port');
const port = Number(i > 0 ? process.argv[i + 1] : process.env.PORT || 3000);
require('http').createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1');`;
    const node = (args) => (process.platform === 'win32' ? `$env:ELECTRON_RUN_AS_NODE=1; & "${process.execPath}" ${args}` : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" ${args}`);

    before(() => fs.writeFileSync(path.join(process.env.KILLPORT_TEST_WORKSPACE, 'server.js'), serverJs));

    it('restarts a server running in a VS Code terminal on the new port, in the same terminal', async function () {
      if (!hasShellApis()) this.skip(); // VS Code < 1.93
      this.timeout(60000);
      const [from, to] = [await freePort(), await freePort()];
      const terminal = vscode.window.createTerminal({ name: 'app', cwd: process.env.KILLPORT_TEST_WORKSPACE, ...(process.platform === 'win32' ? {} : { shellPath: '/bin/bash' }) });
      try {
        const integration = await new Promise((resolve) => {
          if (terminal.shellIntegration) return resolve(terminal.shellIntegration);
          const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => e.terminal === terminal && (sub.dispose(), resolve(e.shellIntegration)));
          setTimeout(() => resolve(undefined), 20000);
        });
        if (!integration) this.skip();
        const started = process.platform === 'win32' ? `$env:PORT=${from}; ${node('server.js')}` : `PORT=${from} ${node('server.js')}`;
        integration.executeCommand(started);
        await waitFor(async () => !(await isPortFree(from)), 15000, 'server to listen');

        const result = await vscode.commands.executeCommand('killport.switchPort', from, to, { confirm: false });
        assert.strictEqual(result.ok, true, result.message);
        assert.ok(result.command.includes(`PORT=${to}`), `command should set the new port: ${result.command}`);
        assert.strictEqual(await isPortFree(from), true, 'old port should be free');
        await ext.exports.refresh();
        const moved = ext.exports.getPorts().find((e) => e.port === to);
        assert.ok(moved, 'new port should be listening');
        assert.strictEqual(moved.terminal, 'app', 'should be restarted in the same terminal');
      } finally {
        terminal.dispose();
      }
    });

    it('with two programs on one port (IPv4 + IPv6), moves only the chosen one', async function () {
      this.timeout(60000);
      await vscode.workspace.getConfiguration('killport').update('warnSharedPorts', false, vscode.ConfigurationTarget.Global);
      const [port, to] = [await freePort(), await freePort()];
      const listen = (host) =>
        spawn(process.execPath, ['-e', `require('http').createServer((q, s) => s.end('${host}')).listen(${port}, '${host}')`], { env: NODE_ENV, stdio: 'ignore', cwd: process.env.KILLPORT_TEST_WORKSPACE });
      const v4 = listen('127.0.0.1');
      const v6 = listen('::1');
      children.push(v4, v6);
      await waitFor(async () => {
        await ext.exports.refresh();
        return ext.exports.getPorts().filter((e) => e.port === port).length === 2;
      }, 10000, 'both servers to listen on the same port');

      const result = await vscode.commands.executeCommand('killport.switchPort', port, to, { pid: v4.pid, command: node(`server.js --port ${to}`) });
      assert.strictEqual(result.ok, true, result.message);
      await exited(v4);
      assert.strictEqual(v6.exitCode, null, 'the IPv6 server must keep running');
      await ext.exports.refresh();
      assert.deepStrictEqual(ext.exports.getPorts().filter((e) => e.port === port).map((e) => e.pid), [v6.pid]);
      assert.ok(ext.exports.getPorts().some((e) => e.port === to), 'moved server should listen on the new port');
      vscode.window.terminals.find((t) => t.name.endsWith(`:${to}`))?.dispose();
    });

    it('restarts a server that was not started from VS Code in a new terminal, in its folder', async function () {
      this.timeout(60000);
      const [from, to] = [await freePort(), await freePort()];
      const child = spawn(process.execPath, ['server.js', '--port', String(from)], { cwd: process.env.KILLPORT_TEST_WORKSPACE, env: NODE_ENV, stdio: 'ignore' });
      children.push(child);
      await waitFor(async () => !(await isPortFree(from)), 10000, 'server to listen');

      const result = await vscode.commands.executeCommand('killport.switchPort', from, to, { command: node(`server.js --port ${to}`) });
      assert.strictEqual(result.ok, true, result.message);
      await exited(child);
      await ext.exports.refresh();
      const moved = ext.exports.getPorts().find((e) => e.port === to);
      assert.ok(moved, 'new port should be listening');
      assert.ok(fs.realpathSync(moved.cwd) === fs.realpathSync(process.env.KILLPORT_TEST_WORKSPACE), 'should start in the original folder');
      vscode.window.terminals.find((t) => t.name.endsWith(`:${to}`))?.dispose();
    });
  });

  it('"This workspace" and "Hide apps & system" narrow the list', async function () {
    this.timeout(30000);
    const fs = require('node:fs');
    const os = require('node:os');
    const cfg = () => vscode.workspace.getConfiguration('killport');
    const [inside, outside] = [await freePort(), await freePort()];
    const a = await startServer(inside, process.env.KILLPORT_TEST_WORKSPACE);
    const b = await startServer(outside, fs.mkdtempSync(path.join(os.tmpdir(), 'killport-elsewhere-')));
    children.push(a, b);
    const visible = async () => {
      await ext.exports.refresh();
      return ext.exports.getVisiblePorts().map((e) => e.port);
    };
    try {
      await cfg().update('hideAppsAndSystem', false, vscode.ConfigurationTarget.Global);
      await cfg().update('workspaceOnly', true, vscode.ConfigurationTarget.Global);
      let ports = await visible();
      assert.ok(ports.includes(inside), 'server from the workspace should be shown');
      assert.ok(!ports.includes(outside), 'server from another folder should be hidden');

      await cfg().update('workspaceOnly', false, vscode.ConfigurationTarget.Global);
      assert.ok((await visible()).includes(outside), 'everything is shown again');

      // These test servers run on VS Code's own binary. On macOS that lives inside "Visual Studio Code.app",
      // so it counts as a desktop app, exactly like Discord or Chrome would.
      if (process.platform === 'darwin') {
        await cfg().update('hideAppsAndSystem', true, vscode.ConfigurationTarget.Global);
        ports = await visible();
        assert.ok(!ports.includes(inside) && !ports.includes(outside), 'programs inside an .app should be hidden');
      }
    } finally {
      await cfg().update('workspaceOnly', undefined, vscode.ConfigurationTarget.Global);
      await cfg().update('hideAppsAndSystem', undefined, vscode.ConfigurationTarget.Global);
      a.kill();
      b.kill();
    }
  });

  it('frees a port with a killport task from tasks.json (preLaunchTask)', async () => {
    const port = Number(process.env.KILLPORT_TEST_TASK_PORT);
    const child = await startServer(port, process.env.KILLPORT_TEST_WORKSPACE);
    children.push(child);

    const tasks = await vscode.tasks.fetchTasks({ type: 'killport' });
    const task = tasks.find((t) => t.name === 'Free test port');
    assert.ok(task, `task from tasks.json not found (got: ${tasks.map((t) => t.name).join(', ')})`);

    const ended = new Promise((resolve) => {
      const sub = vscode.tasks.onDidEndTask((e) => {
        if (e.execution.task.name === task.name) {
          sub.dispose();
          resolve();
        }
      });
    });
    await vscode.tasks.executeTask(task);
    await Promise.race([ended, sleep(15000).then(() => assert.fail('task did not finish'))]);
    await exited(child);
    await waitFor(() => isPortFree(port), 5000, `port ${port} to be free`);
  });

  it('detects "port already in use" in the terminal', async function () {
    if (!hasShellApis()) this.skip(); // VS Code < 1.93
    this.timeout(60000);

    const port = await freePort();
    const holder = await startServer(port, process.env.KILLPORT_TEST_WORKSPACE);
    children.push(holder);

    // Plain bash without user rc files on macOS/Linux: personal shell configs can break shell integration.
    // (VS Code only injects shell integration for argument lists it recognises, so pass none.)
    const shell = process.platform === 'win32' ? {} : { shellPath: '/bin/bash', env: { BASH_ENV: '', HISTFILE: '/dev/null' } };
    const terminal = vscode.window.createTerminal({ name: 'killport-it', cwd: process.env.KILLPORT_TEST_WORKSPACE, ...shell });
    terminal.show(true);
    try {
      // Shell integration is needed to read command output; it is injected automatically for bash/zsh/pwsh.
      const integration = await new Promise((resolve) => {
        if (terminal.shellIntegration) return resolve(terminal.shellIntegration);
        const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
          if (e.terminal === terminal) {
            sub.dispose();
            resolve(e.shellIntegration);
          }
        });
        setTimeout(() => resolve(undefined), 20000);
      });
      if (!integration) {
        console.warn('      (shell integration did not activate in this environment; skipping)');
        this.skip();
      }

      const detected = new Promise((resolve) => {
        const sub = ext.exports.onDidDetectPortConflict((c) => {
          if (c.port === port) {
            sub.dispose();
            resolve(c);
          }
        });
      });
      const script = `require('http').createServer().listen(${port}, '127.0.0.1')`;
      const cmd = process.platform === 'win32'
        ? `$env:ELECTRON_RUN_AS_NODE=1; & "${process.execPath}" -e "${script}"`
        : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" -e "${script}"`;
      integration.executeCommand(cmd);

      const conflict = await Promise.race([detected, sleep(30000).then(() => assert.fail('no conflict detected within 30s'))]);
      assert.strictEqual(conflict.kind, 'failed');
      assert.ok(conflict.holders.some((h) => h.pid === holder.pid), 'should name the process holding the port');
    } finally {
      terminal.dispose();
    }
  });
});
