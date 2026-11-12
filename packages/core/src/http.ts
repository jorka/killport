import http from 'node:http';
import https from 'node:https';
import type { PortEntry } from './types';

export type HttpScheme = 'http' | 'https';

/**
 * Services that are known not to speak HTTP. Probing them is not just useless but noisy:
 * Redis logs "Possible SECURITY ATTACK detected" on an HTTP request, Postgres logs
 * "invalid startup packet", php-fpm (port 9000) speaks FastCGI.
 */
const NON_HTTP_NAMES = /^(redis|valkey|keydb|postgres|postmaster|mysqld|mariadbd|mongod|mongos|memcached|rabbitmq|beam\.smp|epmd|php-fpm|sshd|ssh|smtpd|master|dnsmasq|mDNSResponder|rapportd|launchd|ControlCenter|kdc|cupsd|clickhouse|cassandra|zookeeper|kafka|nats-server|etcd|mosquitto)/i;
const NON_HTTP_IMAGES = /(^|\/)(redis|valkey|keydb|postgres|postgis|mysql|mariadb|mongo|memcached|rabbitmq|clickhouse|cassandra|zookeeper|kafka|nats|etcd|eclipse-mosquitto|mailhog|mailpit|bitnami\/(redis|postgresql|mysql|mongodb|kafka))(:|$|-)/i;
const NON_HTTP_PORTS = new Set([21, 22, 23, 25, 53, 110, 143, 465, 587, 993, 995, 1025, 1433, 1521, 2375, 2376, 3306, 5432, 5672, 6379, 9000, 9042, 9092, 11211, 27017, 27018, 2181, 4222, 1883, 6380, 33060]);

/** Whether it is reasonable (and harmless) to send this port an HTTP request. */
export function shouldProbeHttp(e: Pick<PortEntry, 'port' | 'processName' | 'container' | 'isContainerRuntime' | 'addresses'>): boolean {
  if (e.isContainerRuntime) return false;
  if (NON_HTTP_PORTS.has(e.port)) {
    // mailpit/mailhog web UIs live on 8025, which is fine; the SMTP side is 1025.
    return false;
  }
  if (e.container) {
    if (NON_HTTP_IMAGES.test(e.container.image) && !/mail(pit|hog)/i.test(e.container.image)) return false;
  } else if (NON_HTTP_NAMES.test(e.processName)) {
    return false;
  }
  return probeHost(e.addresses) !== undefined;
}

/** Which loopback address to connect to, given what the socket is bound to. */
export function probeHost(addresses: string[]): string | undefined {
  const a = addresses.map((x) => x.replace(/^\[|\]$/g, ''));
  if (a.some((x) => x === '*' || x === '0.0.0.0' || x.startsWith('127.'))) return '127.0.0.1';
  if (a.some((x) => x === '::' || x === '::1')) return '::1';
  return undefined; // bound to a specific LAN address only: don't poke it
}

function tryRequest(mod: typeof http | typeof https, host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = mod.request(
      { host, port, method: 'HEAD', path: '/', timeout: timeoutMs, headers: { 'User-Agent': 'killport-probe' }, rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve(true); // any HTTP status (200, 404, 302...) means it speaks HTTP
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Returns 'http' or 'https' if the port answers HTTP, otherwise undefined. */
export async function probeHttp(port: number, addresses: string[], timeoutMs = 700): Promise<HttpScheme | undefined> {
  const host = probeHost(addresses);
  if (!host) return undefined;
  if (await tryRequest(http, host, port, timeoutMs)) return 'http';
  if (await tryRequest(https, host, port, timeoutMs)) return 'https';
  return undefined;
}
