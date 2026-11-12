import { describe, expect, it } from 'vitest';
import { parseLsofListen, parseLsofCwd, parsePsInfo, parseEtime, parseSs, splitHostPort } from '../src/unix';
import { parseNetstat, parseTasklist, parseCimProcesses, parseCimDate } from '../src/windows';
import { mergeListeners, parseRange, protectedPidsFrom, ancestorChain, isLocalhostOnly } from '../src/index';

const LSOF = `p644
crapportd
f12
n*:60743
f13
n*:60743
p4121
cnode
f22
n127.0.0.1:3000
f23
n[::1]:3000
f24
n127.0.0.1:3000->127.0.0.1:51000
p210
cpostgres
f7
n*:5432
`;

describe('unix parsers', () => {
  it('splits host:port including IPv6', () => {
    expect(splitHostPort('*:80')).toEqual({ address: '*', port: 80 });
    expect(splitHostPort('[::1]:3000')).toEqual({ address: '[::1]', port: 3000 });
    expect(splitHostPort('nonsense')).toBeUndefined();
    expect(splitHostPort('1.2.3.4:*')).toBeUndefined();
  });

  it('parses lsof -F pcn and ignores connections', () => {
    const r = parseLsofListen(LSOF);
    expect(r).toHaveLength(5);
    expect(r[2]).toEqual({ pid: 4121, processName: 'node', address: '127.0.0.1', port: 3000 });
    expect(r.some((x) => x.port === 51000)).toBe(false);
  });

  it('parses lsof cwd output', () => {
    const m = parseLsofCwd('p4121\nfcwd\nn/Users/me/my-app\np210\nfcwd\nn/\n');
    expect(m.get(4121)).toBe('/Users/me/my-app');
    expect(m.get(210)).toBe('/');
  });

  it('parses ps info (memory, cpu, uptime, command with spaces)', () => {
    const m = parsePsInfo(
      ' 4121  123456   2.5    01:02:03 node /Users/me/my-app/node_modules/.bin/vite --port 3000\n' +
        '  210   8800   0,0  3-04:05:06 /Applications/Postgres App.app/Contents/postgres -D data\n',
    );
    expect(m.get(4121)).toEqual({ memoryKB: 123456, cpuPercent: 2.5, elapsed: 3723, command: 'node /Users/me/my-app/node_modules/.bin/vite --port 3000' });
    expect(m.get(210)).toEqual({ memoryKB: 8800, cpuPercent: 0, elapsed: 3 * 86400 + 4 * 3600 + 5 * 60 + 6, command: '/Applications/Postgres App.app/Contents/postgres -D data' });
  });

  it('parses ps etime formats', () => {
    expect(parseEtime('00:05')).toBe(5);
    expect(parseEtime('12:34')).toBe(754);
    expect(parseEtime('1:00:00')).toBe(3600);
    expect(parseEtime('2-00:00:01')).toBe(172801);
    expect(parseEtime('garbage')).toBeUndefined();
  });

  it('parses ss -ltnpH', () => {
    const out = [
      'LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*    users:(("node",pid=1234,fd=20))',
      'LISTEN 0      4096         [::]:22           [::]:*',
      'LISTEN 0      128   [fe80::1%eth0]:8080      [::]:*    users:(("python3",pid=55,fd=3),("python3",pid=56,fd=3))',
    ].join('\n');
    const r = parseSs(out);
    expect(r).toEqual([
      { pid: 1234, processName: 'node', address: '0.0.0.0', port: 3000 },
      { pid: 0, processName: '(unknown)', address: '[::]', port: 22 },
      { pid: 55, processName: 'python3', address: '[fe80::1]', port: 8080 },
      { pid: 56, processName: 'python3', address: '[fe80::1]', port: 8080 },
    ]);
  });
});

describe('windows parsers', () => {
  it('parses netstat regardless of locale', () => {
    const out = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1012
  TCP    127.0.0.1:3000         0.0.0.0:0              ABHÖREN          8840
  TCP    127.0.0.1:3000         127.0.0.1:50122        HERGESTELLT      8840
  TCP    [::]:5432              [::]:0                 ABHÖREN          3320
  TCP    [fe80::1%12]:7000      [::]:0                 ABHÖREN          77
`;
    expect(parseNetstat(out)).toEqual([
      { address: '0.0.0.0', port: 135, pid: 1012 },
      { address: '127.0.0.1', port: 3000, pid: 8840 },
      { address: '[::]', port: 5432, pid: 3320 },
      { address: '[fe80::1]', port: 7000, pid: 77 },
    ]);
  });

  it('parses tasklist CSV', () => {
    const m = parseTasklist('"System Idle Process","0","Services","0","8 K"\r\n"node.exe","8840","Console","1","45,000 K"\r\n');
    expect(m.get(8840)).toEqual({ name: 'node.exe', memoryKB: 45000 });
    expect(m.get(0)).toEqual({ name: 'System Idle Process', memoryKB: 8 });
    expect(parseTasklist('"x.exe","5","Console","1","1.234.567 K"').get(5)?.memoryKB).toBe(1234567);
  });

  it('parses CIM process JSON (array and single object)', () => {
    const arr = parseCimProcesses('[{"ProcessId":8840,"ParentProcessId":100,"CommandLine":"node server.js"},{"ProcessId":4,"ParentProcessId":0,"CommandLine":null}]');
    expect(arr.get(8840)).toEqual({ pid: 8840, ppid: 100, command: 'node server.js' });
    expect(arr.get(4)?.command).toBeUndefined();
    expect(parseCimProcesses('{"ProcessId":1,"ParentProcessId":0,"CommandLine":"x"}').size).toBe(1);
    expect(parseCimProcesses('garbage').size).toBe(0);
    expect(parseCimProcesses('{"ProcessId":7,"ParentProcessId":1,"CommandLine":"x","CreationDate":"/Date(1731400000000)/"}').get(7)?.startedAt).toBe(1731400000000);
    expect(parseCimDate('2026-11-12T10:00:00+02:00')).toBe(Date.parse('2026-11-12T08:00:00Z'));
    expect(parseCimDate(null)).toBeUndefined();
  });
});

describe('merge + filter', () => {
  const raw = parseLsofListen(LSOF);

  it('merges IPv4/IPv6 sockets of the same port+pid', () => {
    const e = mergeListeners(raw);
    expect(e.map((x) => x.port)).toEqual([3000, 5432, 60743]);
    expect(e[0].addresses).toEqual(['127.0.0.1', '[::1]']);
    expect(e[2].addresses).toEqual(['*']);
  });

  it('filters by port, range and system ports', () => {
    expect(mergeListeners(raw, { port: 5432 }).map((x) => x.pid)).toEqual([210]);
    expect(mergeListeners(raw, { range: '3000-9999' }).map((x) => x.port)).toEqual([3000, 5432]);
    const sys = [{ pid: 1, processName: 'launchd', address: '*', port: 22 }, ...raw];
    expect(mergeListeners(sys, { includeSystem: false }).some((x) => x.port === 22)).toBe(false);
  });

  it('filters to localhost-only ports (all sockets must be loopback)', () => {
    const mixed = [...raw, { pid: 4121, processName: 'node', address: '*', port: 4000 }, { pid: 4121, processName: 'node', address: '127.0.0.1', port: 4000 }];
    expect(mergeListeners(mixed, { localhostOnly: true }).map((x) => x.port)).toEqual([3000]);
    expect(isLocalhostOnly(['127.0.0.1', '[::1]'])).toBe(true);
    expect(isLocalhostOnly(['127.0.0.1', '0.0.0.0'])).toBe(false);
    expect(isLocalhostOnly(['[::ffff:127.0.0.1]'])).toBe(true);
    expect(isLocalhostOnly([])).toBe(false);
  });

  it('parses ranges', () => {
    const f = parseRange('3000-3999, 5432,9000-8000')!;
    expect([2999, 3000, 3999, 5432, 8500, 5433].map(f)).toEqual([false, true, true, true, true, false]);
    expect(parseRange('')).toBeUndefined();
    expect(parseRange('abc')).toBeUndefined();
  });
});

describe('safety', () => {
  const parents = new Map([
    [500, 400], // mcp server -> agent
    [400, 300], // agent -> shell
    [300, 1], // shell -> launchd
    [600, 400], // dev server started by agent (sibling)
  ]);

  it('walks the ancestor chain', () => {
    expect([...ancestorChain(500, parents)]).toEqual([500, 400, 300, 1]);
  });

  it('protects self, ancestors and core pids but not siblings', () => {
    const p = protectedPidsFrom(500, parents);
    for (const pid of [0, 1, 300, 400, 500]) expect(p.has(pid)).toBe(true);
    expect(p.has(600)).toBe(false);
  });
});
