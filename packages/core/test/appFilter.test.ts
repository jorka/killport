import { describe, expect, it } from 'vitest';
import { appOrSystemKind } from '../src/appFilter';

const kind = (processName: string, command?: string, extra = {}) => appOrSystemKind({ processName, command, ...extra });

describe('Hide apps & system', () => {
  it('hides desktop apps, OS services and editor/agent helpers (real commands from a Mac)', () => {
    expect(kind('Code Helper (Plugin)', '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility')).toBe('app');
    expect(kind('Discord Helper (Renderer)', '/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer)')).toBe('app');
    expect(kind('Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222')).toBe('app');
    expect(kind('ControlCenter', '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter')).toBe('system');
    expect(kind('rapportd', '/usr/libexec/rapportd')).toBe('system');
    expect(kind('claude', '/Users/me/.vscode/extensions/anthropic.claude-code-2.1.322-darwin-arm64/resources/native-binary/claude --output-format stream-json')).toBe('editor');
    expect(kind('node', '/home/me/.vscode-server/bin/abc123/node /home/me/.vscode-server/bin/abc123/out/server-main.js')).toBe('editor');
    expect(kind('node', '/Users/me/.cursor/extensions/ms-python.python/server.js')).toBe('editor');
    expect(kind('svchost.exe', 'C:\\Windows\\system32\\svchost.exe -k RPCSS')).toBe('system');
    expect(kind('com.docker.backend', '/Applications/Docker.app/Contents/MacOS/com.docker.backend', { isContainerRuntime: true })).toBe('app');
  });

  it('keeps your servers, containers and dev servers installed as apps', () => {
    expect(kind('node', 'node /Users/me/app/node_modules/.bin/vite')).toBeUndefined();
    expect(kind('symfony', 'symfony local:server:start')).toBeUndefined();
    expect(kind('redis-server', '/opt/homebrew/opt/redis/bin/redis-server 127.0.0.1:6379')).toBeUndefined();
    expect(kind('php-fpm', 'php-fpm: pool www')).toBeUndefined();
    expect(kind('postgres', '/Applications/Postgres.app/Contents/Versions/16/bin/postgres -D /Users/me/Library/Application Support/Postgres/var-16')).toBeUndefined();
    expect(kind('node.exe', '"C:\\Program Files\\nodejs\\node.exe" server.js')).toBeUndefined();
    const container = { id: 'x', name: 'db', image: 'postgres:16' };
    expect(kind('com.docker.backend', '/Applications/Docker.app/Contents/MacOS/com.docker.backend', { container })).toBeUndefined();
    expect(kind('(unknown)', undefined)).toBeUndefined();
  });
});
