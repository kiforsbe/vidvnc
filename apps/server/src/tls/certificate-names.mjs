import { isIP } from 'node:net';

// The names the generated certificate covers. With remote access off it is every local name
// and address (tls/local-addresses.mjs). With remote access on, anyone who reaches the HTTPS
// port can read the certificate, so it carries the public names and drops the PC's own
// hostname: VidVNC advertises only IP-address URLs, so no client needs that name, and it is
// the one entry that identifies the machine. Local IPs stay, because LAN and VPN devices
// connect by them; a `provided` certificate avoids listing them.
export function certificateNames(local, access) {
  if (!access.remoteAccess) return local;
  const publicNames = access.publicHostnames.filter((name) => !isIP(name));
  const publicIps = access.publicHostnames.filter((name) => isIP(name));
  return {
    ...local,
    hostnames: [...new Set(['localhost', ...publicNames])],
    ips: [...new Set([...local.ips, ...publicIps])],
  };
}
