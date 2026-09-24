// The addresses VidVNC shows to people (CLI banner, `info`, the desktop host's ready line),
// built in one place so they always agree with what is actually listening.
//
// Everything here is pure: interfaces and the TLS state are passed in, so it is tested
// without sockets. `tls` is the shape `createTlsListener().status()` returns.
import { networkInterfaces as systemInterfaces } from 'node:os';
import { isIP } from 'node:net';

const DEFAULT_PORTS = { http: 80, https: 443 };

// Browsers omit a port that equals the scheme's default, so `https://host:443` is shown as
// `https://host`. Any other port stays, and a plaintext listener on port 80 is likewise bare.
function origin(scheme, host, port) {
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  return port === DEFAULT_PORTS[scheme]
    ? `${scheme}://${authority}`
    : `${scheme}://${authority}:${port}`;
}

export function httpConnectionAddresses(bindings = []) {
  const rows = bindings.filter(
    ({ host, port }) => isIP(host) && Number.isInteger(port) && port > 0 && port <= 65535,
  );
  const lan = rows
    .filter(({ host }) => host !== '127.0.0.1' && host !== '::1')
    .map(({ host, port }) => origin('http', host, port));
  const localRow = rows.find(({ host }) => host === '127.0.0.1');
  const local = localRow ? origin('http', localRow.host, localRow.port) : null;
  const ipv6Loopback = rows
    .filter(({ host }) => host === '::1')
    .map(({ host, port }) => origin('http', host, port));
  return { lan, local, urls: [...lan, ...(local ? [local] : []), ...ipv6Loopback] };
}

// HTTP addresses come only from actual bounded listeners. HTTPS addresses follow the TLS
// bind preference; an inactive HTTPS-required service has no viewer URL to advertise.
export function connectionAddresses({
  interfaces = systemInterfaces,
  plaintextPort,
  httpBindings = [],
  tls = { active: false, port: null },
  plaintextMode = 'lan-http',
  hostPreference = '0.0.0.0',
}) {
  const secure = tls.active && tls.port !== null;
  if (!secure)
    return plaintextMode === 'lan-http'
      ? httpConnectionAddresses(httpBindings)
      : { lan: [], local: null, urls: [] };
  const preference = hostPreference || '0.0.0.0';
  const wildcard = preference === '0.0.0.0' || preference === '::';
  const family = preference === '::' || isIP(preference) === 6 ? 'IPv6' : 'IPv4';
  const allHosts = Object.values(interfaces())
    .flat()
    .filter(
      (n) =>
        !n.internal &&
        n.family === family &&
        (family === 'IPv4' || (!n.address.includes('%') && !/^fe80:/i.test(n.address))),
    )
    .map((n) => n.address);
  const hosts = wildcard ? allHosts : allHosts.filter((address) => address === preference);
  if (!wildcard && !isIP(preference) && preference !== 'localhost') hosts.push(preference);
  const lan = hosts.map((host) => origin('https', host, tls.port));
  const localHost =
    preference === '::' || preference === '::1'
      ? '::1'
      : preference === '0.0.0.0' || preference === '127.0.0.1' || preference === 'localhost'
        ? '127.0.0.1'
        : null;
  const local = localHost ? origin('https', localHost, tls.port) : null;
  return { lan, local, urls: [...lan, ...(local ? [local] : [])] };
}

// The one follow-up block printed when HTTPS comes up after the startup banner. It says
// nothing about how a device enrols the certificate: it is only honest about what the
// browser will do.
export function secureAddressLines({ lan, local }) {
  return [
    '',
    'VidVNC · Secure connection ready',
    '',
    ...lan.map((url) => `Open ${url}`),
    ...(local ? [`Local preview: ${local}`] : []),
    'Live diagnostics (this PC only): use diagnostics open',
    'Connections on these addresses are encrypted. Local HTTP remains for trust enrollment; other HTTP paths redirect to HTTPS.',
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
