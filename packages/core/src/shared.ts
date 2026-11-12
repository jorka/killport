import type { PortEntry } from './types';

export type AddressFamily = 'ipv4' | 'ipv6' | 'both';

const isV6 = (a: string) => a.startsWith('[') || a.includes(':');

/** Which IP families the addresses cover ("*" from tools that don't say counts as both). */
export function addressFamily(addresses: string[]): AddressFamily {
  if (addresses.some((a) => a === '*')) return 'both';
  const v6 = addresses.some(isV6);
  const v4 = addresses.some((a) => !isV6(a));
  return v4 && v6 ? 'both' : v6 ? 'ipv6' : 'ipv4';
}

export interface SharedPort {
  port: number;
  /** Holders listening only on IPv4: they get 127.0.0.1:<port>. */
  ipv4: PortEntry[];
  /** Holders listening on IPv6: they get [::1]:<port>, which is what "localhost" usually resolves to first. */
  ipv6: PortEntry[];
}

const holderKey = (e: PortEntry) => (e.container ? `c:${e.container.id}` : `p:${e.pid}`);

/**
 * Ports where two *different* programs listen at the same time, one on IPv4 and one on IPv6.
 * The OS allows it (they are different sockets), so neither gets "address already in use", but
 * http://localhost:<port> and http://127.0.0.1:<port> then reach different apps.
 * Several processes sharing one socket (php-fpm/nginx workers, Node cluster) are not reported.
 */
export function findSharedPorts(entries: PortEntry[]): SharedPort[] {
  const byPort = new Map<number, PortEntry[]>();
  for (const e of entries) byPort.set(e.port, [...(byPort.get(e.port) ?? []), e]);
  const out: SharedPort[] = [];
  for (const [port, holders] of byPort) {
    if (new Set(holders.map(holderKey)).size < 2) continue;
    const ipv4 = holders.filter((e) => addressFamily(e.addresses) === 'ipv4');
    const ipv6 = holders.filter((e) => addressFamily(e.addresses) !== 'ipv4');
    if (ipv4.length === 0 || ipv6.length === 0) continue;
    const v4keys = new Set(ipv4.map(holderKey));
    if (ipv6.every((e) => v4keys.has(holderKey(e)))) continue; // same program on both families
    out.push({ port, ipv4, ipv6 });
  }
  return out.sort((a, b) => a.port - b.port);
}
