// The addresses VidVNC shows to people (CLI banner, `info`, the desktop host's ready line),
// built in one place so they always agree with what is actually listening.
//
// Everything here is pure: interfaces and the TLS state are passed in, so it is tested
// without sockets. `tls` is the shape `createTlsListener().status()` returns.
import { networkInterfaces as systemInterfaces } from 'node:os';

const DEFAULT_PORTS = { http: 80, https: 443 };

// Browsers omit a port that equals the scheme's default, so `https://host:443` is shown as
// `https://host`. Any other port stays, and a plaintext listener on port 80 is likewise bare.
function origin(scheme, host, port) {
  return port === DEFAULT_PORTS[scheme] ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

// `lan` are the non-loopback IPv4 addresses (each NIC in enumeration order), `local` the
// loopback preview and `urls` both together. The separate private diagnostics listener
// is deliberately not derived from these public-capable addresses.
export function connectionAddresses({
  interfaces = systemInterfaces,
  plaintextPort,
  tls = { active: false, port: null },
}) {
  const secure = tls.active && tls.port !== null;
  const scheme = secure ? 'https' : 'http';
  const port = secure ? tls.port : plaintextPort;
  const lan = Object.values(interfaces())
    .flat()
    .filter((n) => n.family === 'IPv4' && !n.internal)
    .map((n) => origin(scheme, n.address, port));
  const local = origin(scheme, '127.0.0.1', port);
  return { lan, local, urls: [...lan, local] };
}

// The one follow-up block printed when HTTPS comes up after the plaintext banner. It says
// nothing about how a device enrols the certificate: it is only honest about what the
// browser will do.
export function secureAddressLines({ lan, local }) {
  return [
    '',
    'VidVNC · Secure connection ready',
    '',
    ...lan.map((url) => `Open ${url}`),
    `Local preview: ${local}`,
    'Live diagnostics (this PC only): use diagnostics open',
    'Connections on these addresses are encrypted, and the http addresses above now redirect to them.',
    "Devices that have not enrolled this PC's certificate will show a browser warning.",
    'Trusted LAN only. Do not forward this port.',
    '',
  ];
}

// One TLS attempt, announcing only a genuine inactive -> active transition. The listener's
// own attempt() logs why a failure happened, so a failed attempt adds nothing here, and a
// re-check while already serving is not news either.
export async function attemptAndAnnounce({ listener, announce, log }) {
  const wasActive = listener.status().active;
  try {
    await listener.attempt();
  } catch (error) {
    log(`TLS attempt failed (${error?.message ?? error}).`);
    return;
  }
  if (!wasActive && listener.status().active) announce();
}
