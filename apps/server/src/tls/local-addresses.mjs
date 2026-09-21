import { networkInterfaces as systemInterfaces, hostname as systemHostname } from 'node:os';

const LOOPBACK_HOSTNAMES = ['localhost'];
const LOOPBACK_IPS = ['127.0.0.1', '::1'];

// IPv4 addresses sort before IPv6 (a plain colon count is enough to tell them apart),
// then lexicographically within each family, so order never depends on how the OS
// happened to enumerate adapters.
function compareIps(a, b) {
  const family = (address) => (address.includes(':') ? 1 : 0);
  return family(a) - family(b) || a.localeCompare(b);
}

// The hostnames and IP addresses a TLS certificate should cover on this machine.
// Loopback and `localhost` are always included, so a source that fails to enumerate
// anything still leaves the server reachable over HTTPS from itself. A source that
// throws (a disabled adapter, a sandboxed hostname lookup) is reported through
// `errors` instead of failing the whole call, since a degraded certificate is far
// better than no certificate.
export function localAddresses({ interfaces = systemInterfaces, hostname = systemHostname } = {}) {
  const hostnames = new Set(LOOPBACK_HOSTNAMES);
  const ips = new Set(LOOPBACK_IPS);
  const errors = [];

  try {
    const name = hostname();
    if (typeof name === 'string' && name.trim()) hostnames.add(name.trim());
  } catch (error) {
    errors.push({ source: 'hostname', message: error.message });
  }

  try {
    for (const entries of Object.values(interfaces() ?? {})) {
      for (const entry of entries ?? []) {
        if (!entry?.address) continue;
        // Node reports link-local IPv6 addresses as `fe80::1%eth0`; the zone id is not
        // part of the address and is not valid in a certificate SAN entry.
        ips.add(entry.address.split('%')[0]);
      }
    }
  } catch (error) {
    errors.push({ source: 'interfaces', message: error.message });
  }

  return {
    hostnames: [...hostnames].sort(),
    ips: [...ips].sort(compareIps),
    errors,
  };
}
