import { describe, expect, it } from 'vitest';
import { parseLsofListen } from '../src/unix';
import { addressFamily, findSharedPorts } from '../src/shared';
import { mergeListeners } from '../src/index';
import type { PortEntry } from '../src/types';

// Real lsof output from two Nuxt dev servers both on port 3000.
const LSOF = `p56561
cnode
f17
tIPv4
n*:3000
p58508
cnode
f17
tIPv6
n*:3000
`;

describe('IPv4 / IPv6 wildcards', () => {
  it('keeps the family that lsof prints as "*:3000" for both', () => {
    expect(parseLsofListen(LSOF).map((l) => [l.pid, l.address])).toEqual([
      [56561, '0.0.0.0'],
      [58508, '[::]'],
    ]);
  });

  it('classifies address families', () => {
    expect(addressFamily(['0.0.0.0'])).toBe('ipv4');
    expect(addressFamily(['127.0.0.1'])).toBe('ipv4');
    expect(addressFamily(['[::]'])).toBe('ipv6');
    expect(addressFamily(['[::1]'])).toBe('ipv6');
    expect(addressFamily(['127.0.0.1', '[::1]'])).toBe('both');
    expect(addressFamily(['*'])).toBe('both');
  });
});

describe('findSharedPorts', () => {
  const entry = (port: number, pid: number, addresses: string[], extra: Partial<PortEntry> = {}): PortEntry => ({ port, pid, addresses, protocol: 'tcp', processName: 'node', ...extra });

  it('reports two programs on the same port, one IPv4 and one IPv6', () => {
    const shared = findSharedPorts(mergeListeners(parseLsofListen(LSOF)));
    expect(shared).toHaveLength(1);
    expect(shared[0].port).toBe(3000);
    expect(shared[0].ipv4.map((e) => e.pid)).toEqual([56561]);
    expect(shared[0].ipv6.map((e) => e.pid)).toEqual([58508]);
  });

  it('reports a container on 127.0.0.1 next to a local server on [::]', () => {
    const container = { id: 'c1', name: 'web', image: 'nginx' };
    expect(findSharedPorts([entry(8080, 900, ['127.0.0.1'], { container }), entry(8080, 4000, ['[::]'])])).toHaveLength(1);
  });

  it('ignores workers sharing one socket and one program on both families', () => {
    expect(findSharedPorts([entry(9000, 1, ['127.0.0.1']), entry(9000, 2, ['127.0.0.1']), entry(9000, 3, ['127.0.0.1'])])).toEqual([]);
    expect(findSharedPorts([entry(3000, 7, ['0.0.0.0', '[::]'])])).toEqual([]);
    expect(findSharedPorts([entry(3000, 7, ['0.0.0.0']), entry(3000, 7, ['[::]'])])).toEqual([]);
  });
});
