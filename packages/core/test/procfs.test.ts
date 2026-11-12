import { describe, expect, it } from 'vitest';
import { decodeProcAddress, getProcInfo, getProcParents, listProcListeners, parseProcNetTcp, parseProcStat } from '../src/procfs';
import net from 'node:net';

describe('/proc parsing', () => {
  it('decodes /proc/net addresses', () => {
    expect(decodeProcAddress('0100007F')).toBe('127.0.0.1');
    expect(decodeProcAddress('00000000')).toBe('0.0.0.0');
    expect(decodeProcAddress('00000000000000000000000000000000')).toBe('[::]');
    expect(decodeProcAddress('00000000000000000000000001000000')).toBe('[::1]');
    expect(decodeProcAddress('0000000000000000FFFF00000100007F')).toBe('[::ffff:127.0.0.1]');
  });

  it('keeps only listening sockets, with port and inode', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0',
      '   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 223344 1 0000000000000000 100 0 0 10 0',
      '   2: 0100007F:0BB8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 999999 1 0000000000000000 20 4 30 10 -1',
    ].join('\n');
    expect(parseProcNetTcp(tcp)).toEqual([
      { address: '127.0.0.1', port: 3000, inode: 123456 },
      { address: '0.0.0.0', port: 8080, inode: 223344 },
    ]);
  });

  it('parses /proc/<pid>/stat even with spaces and parens in the name', () => {
    const stat = '4121 (node (dev) srv) S 4000 4121 4000 34816 4121 4194304 1 0 0 0 5 1 0 0 20 0 11 0 987654 1234 567 18446744073709551615';
    expect(parseProcStat(stat)).toEqual({ ppid: 4000, startTicks: 987654 });
  });
});

describe.runIf(process.platform === 'linux')('/proc fallback on a real Linux system', () => {
  it('finds a listening socket, its process details and parents', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const mine = (await listProcListeners()).find((l) => l.port === port);
      expect(mine?.pid).toBe(process.pid);
      const info = (await getProcInfo([process.pid])).get(process.pid);
      expect(info?.command).toContain('node');
      expect(info?.memoryKB).toBeGreaterThan(0);
      expect((await getProcParents()).get(process.pid)).toBe(process.ppid);
    } finally {
      server.close();
    }
  });
});
