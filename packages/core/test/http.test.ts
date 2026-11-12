import http from 'node:http';
import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { probeHost, probeHttp, shouldProbeHttp } from '../src/http';

const servers: net.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
  servers.push(server);
  return new Promise((r) => server.listen(0, host, () => r((server.address() as net.AddressInfo).port)));
}

describe('probeHttp', () => {
  it('detects an HTTP server (any status)', async () => {
    const port = await listen(http.createServer((_, res) => res.writeHead(404).end()));
    expect(await probeHttp(port, ['127.0.0.1'])).toBe('http');
  });

  it('returns undefined for a non-HTTP TCP server', async () => {
    const port = await listen(net.createServer((s) => s.end('220 smtp ready\r\n')));
    expect(await probeHttp(port, ['127.0.0.1'], 400)).toBeUndefined();
  });

  it('returns undefined for a silent server (timeout)', async () => {
    const port = await listen(net.createServer(() => {}));
    expect(await probeHttp(port, ['127.0.0.1'], 300)).toBeUndefined();
  });
});

describe('shouldProbeHttp', () => {
  const base = { addresses: ['127.0.0.1'], container: undefined, isContainerRuntime: false };
  it('probes dev servers', () => {
    expect(shouldProbeHttp({ ...base, port: 5173, processName: 'node' })).toBe(true);
    expect(shouldProbeHttp({ ...base, port: 7080, processName: 'symfony', addresses: ['*'] })).toBe(true);
  });
  it('never probes databases and other non-HTTP services', () => {
    expect(shouldProbeHttp({ ...base, port: 6379, processName: 'redis-server' })).toBe(false);
    expect(shouldProbeHttp({ ...base, port: 16379, processName: 'redis-server' })).toBe(false);
    expect(shouldProbeHttp({ ...base, port: 9000, processName: 'php-fpm' })).toBe(false);
    expect(shouldProbeHttp({ ...base, port: 5432, processName: 'whatever' })).toBe(false);
    const container = (image: string) => ({ id: 'x', name: 'x', image });
    expect(shouldProbeHttp({ ...base, port: 55432, processName: 'com.docker.backend', container: container('postgres:16-alpine') })).toBe(false);
    expect(shouldProbeHttp({ ...base, port: 56379, processName: 'com.docker.backend', container: container('redis:7-alpine') })).toBe(false);
    expect(shouldProbeHttp({ ...base, port: 8025, processName: 'com.docker.backend', container: container('axllent/mailpit:v1.27') })).toBe(true);
    expect(shouldProbeHttp({ ...base, port: 1025, processName: 'com.docker.backend', container: container('axllent/mailpit:v1.27') })).toBe(false);
    expect(shouldProbeHttp({ ...base, port: 8001, processName: 'com.docker.backend', isContainerRuntime: true })).toBe(false);
  });
  it('only probes loopback-reachable sockets', () => {
    expect(probeHost(['*'])).toBe('127.0.0.1');
    expect(probeHost(['[::1]'])).toBe('::1');
    expect(probeHost(['192.168.1.20'])).toBeUndefined();
  });
});
