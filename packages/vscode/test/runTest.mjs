// Launches a separate VS Code instance (own profile, other extensions disabled) with Killport loaded
// and runs test/suite. Uses $VSCODE_EXECUTABLE_PATH if set, otherwise downloads VS Code
// ($VSCODE_TEST_VERSION, default "stable"; CI also runs the oldest supported version).
import { runTests } from '@vscode/test-electron';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// When this runs from a terminal inside VS Code (or an agent running in it), the environment carries
// ELECTRON_RUN_AS_NODE / VSCODE_* variables that make the test instance start as plain Node or attach
// to the running editor. Start it clean.
for (const key of Object.keys(process.env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || (key.startsWith('VSCODE_') && key !== 'VSCODE_EXECUTABLE_PATH' && key !== 'VSCODE_TEST_VERSION')) delete process.env[key];
}
const tmp = mkdtempSync(join(tmpdir(), 'killport-it-'));
const workspace = join(tmp, 'workspace');
mkdirSync(workspace);
writeFileSync(join(workspace, 'package.json'), '{"name":"killport-test-workspace"}');

// A tasks.json exactly like a user would write, freeing a port chosen now.
const taskPort = await new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => r(port));
  });
});
mkdirSync(join(workspace, '.vscode'));
writeFileSync(
  join(workspace, '.vscode', 'tasks.json'),
  JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Free test port', type: 'killport', ports: [taskPort] }] }, null, 2),
);

try {
  await runTests({
    extensionDevelopmentPath: resolve(here, '..'),
    extensionTestsPath: join(here, 'suite', 'index.js'),
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || undefined,
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${join(tmp, 'user-data')}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
    extensionTestsEnv: { KILLPORT_TEST_WORKSPACE: workspace, KILLPORT_TEST_TASK_PORT: String(taskPort) },
  });
} catch (err) {
  console.error('Integration tests failed:', err);
  process.exit(1);
}
