import { describe, expect, it } from 'vitest';
import { isContainerRuntime, parseDockerPs, parseDockerUptime, parsePublishedPorts } from '../src/docker';
import { parsePortConflict, portFromCommand } from '../src/conflict';

describe('docker', () => {
  it('parses published host ports from the docker ps Ports column', () => {
    expect(parsePublishedPorts('127.0.0.1:8001->8000/tcp')).toEqual([8001]);
    expect(parsePublishedPorts('0.0.0.0:5432->5432/tcp, :::5432->5432/tcp')).toEqual([5432]);
    expect(parsePublishedPorts('0.0.0.0:3000-3002->3000-3002/tcp')).toEqual([3000, 3001, 3002]);
    expect(parsePublishedPorts('5540/tcp, 1025/tcp')).toEqual([]);
    expect(parsePublishedPorts('0.0.0.0:53->53/udp')).toEqual([]);
    expect(parsePublishedPorts('')).toEqual([]);
  });

  it('maps host ports to containers with compose info', () => {
    const out = [
      'abc123\trezicard-api-postgres-1\tpostgres:16\t127.0.0.1:55432->5432/tcp\trezicard-api\tpostgres\t/Users/me/rezicard-api\tUp 2 hours',
      'def456\tmailpit\taxllent/mailpit\t127.0.0.1:1025->1025/tcp, 127.0.0.1:8025->8025/tcp\t\t\t',
      'ghi789\tworker\tpython:3\t\t\t\t',
    ].join('\n');
    const m = parseDockerPs(out);
    expect(m.get(55432)).toEqual({ id: 'abc123', name: 'rezicard-api-postgres-1', image: 'postgres:16', composeProject: 'rezicard-api', composeService: 'postgres', composeDir: '/Users/me/rezicard-api', status: 'Up 2 hours' });
    expect(m.get(8025)?.name).toBe('mailpit');
    expect(m.get(8025)?.composeDir).toBeUndefined();
    expect(m.size).toBe(3);
  });

  it('parses docker uptime text', () => {
    expect(parseDockerUptime('Up 5 seconds')).toBe(5);
    expect(parseDockerUptime('Up About a minute')).toBe(60);
    expect(parseDockerUptime('Up About an hour')).toBe(3600);
    expect(parseDockerUptime('Up 2 hours (healthy)')).toBe(7200);
    expect(parseDockerUptime('Up 3 days')).toBe(259200);
    expect(parseDockerUptime('Up Less than a second')).toBe(0);
    expect(parseDockerUptime('Restarting (1) 55 seconds ago')).toBeUndefined();
    expect(parseDockerUptime(undefined)).toBeUndefined();
  });

  it('recognises container runtime processes', () => {
    for (const n of ['com.docker.backend', 'com.docker.backend.exe', 'docker-proxy', 'vpnkit-bridge', 'OrbStack Helper', 'gvproxy', 'limactl']) expect(isContainerRuntime(n)).toBe(true);
    for (const n of ['node', 'postgres', 'dockerize-me-not'.replace('dockerize-me-not', 'nginx')]) expect(isContainerRuntime(n)).toBe(false);
  });
});

describe('parsePortConflict', () => {
  const cases: Array<[string, string, ReturnType<typeof parsePortConflict>]> = [
    ['node', 'Error: listen EADDRINUSE: address already in use :::3000\n    at Server.setupListenHandle', { port: 3000, kind: 'failed' }],
    ['node ipv4', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:8080', { port: 8080, kind: 'failed' }],
    ['vite', '\x1b[33mPort 5173 is in use, trying another one...\x1b[39m', { port: 5173, kind: 'moved' }],
    ['next', ' ⚠ Port 3000 is in use, trying 3001 instead.', { port: 3000, kind: 'moved' }],
    ['next 15', ' ⚠ Port 3000 is in use by process 4121, using available port 3001 instead.', { port: 3000, kind: 'moved' }],
    ['go', 'listen tcp :8080: bind: address already in use', { port: 8080, kind: 'failed' }],
    ['rails', 'Address already in use - bind(2) for "127.0.0.1" port 3000 (Errno::EADDRINUSE)', { port: 3000, kind: 'failed' }],
    ['php', '[Wed Nov 12 10:00:00 2026] Failed to listen on localhost:8000 (reason: Address already in use)', { port: 8000, kind: 'failed' }],
    ['spring', 'Web server failed to start. Port 8080 was already in use.', { port: 8080, kind: 'failed' }],
    ['cra', '? Something is already running on port 3000.', { port: 3000, kind: 'failed' }],
    ['docker', 'Error response from daemon: Bind for 0.0.0.0:5432 failed: port is already allocated', { port: 5432, kind: 'failed' }],
    ['uvicorn', 'ERROR:    [Errno 48] error while attempting to bind on address (\'127.0.0.1\', 8000): address already in use', { port: 8000, kind: 'failed' }],
    ['python no port', 'OSError: [Errno 48] Address already in use', { kind: 'failed' }],
    ['windows', 'OSError: [WinError 10048] Only one usage of each socket address (protocol/network address/port) is normally permitted', { kind: 'failed' }],
  ];
  for (const [name, text, expected] of cases) {
    it(name, () => expect(parsePortConflict(text)).toEqual(expected));
  }

  it('ignores normal output', () => {
    expect(parsePortConflict('  VITE v6.0.0  ready in 300 ms\n  ➜  Local:   http://localhost:5173/')).toBeUndefined();
    expect(parsePortConflict('Server listening on port 3000')).toBeUndefined();
  });
});

describe('portFromCommand', () => {
  it.each([
    ['python3 -m http.server 8000', 8000],
    ['uvicorn app.main:app --port 8001 --reload', 8001],
    ['rails s -p 3001', 3001],
    ['PORT=4000 npm start', 4000],
    ['php -S localhost:8080 -t public', 8080],
    ['vite --port=5174', 5174],
    ['npm run dev', undefined],
    [undefined, undefined],
  ])('%s → %s', (cmd, port) => expect(portFromCommand(cmd as string | undefined)).toBe(port));
});
