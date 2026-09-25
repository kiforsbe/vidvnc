import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isPrivateAddress } from './peer-network.mjs';

// Media through a router without a relay ("NAT 1:1 mapping", as Janus and mediasoup call it).
//
// The worker only knows this PC's own addresses, so the ICE candidates in its SDP answer are
// private LAN addresses an internet client cannot reach. With a fixed media port range
// forwarded on the router to this PC, the same port on the router's public address leads
// to the same socket, so for an internet client each private IPv4 host candidate is
// replaced by one on the public address with the same port and transport. Private
// candidates are removed rather than kept: they cannot work from the internet, and they
// would tell the client about the inside of the network. Public IPv6 host candidates are
// kept as they are, since they are already reachable if the firewall allows them.
//
// This rewrites text the worker produced, never text from the client.

const CANDIDATE = /^a=candidate:(\S+) (\d+) (udp|tcp) (\d+) (\S+) (\d+) typ host(.*)$/i;

export function announceCandidates(sdp, publicIpv4) {
  const lines = sdp.split(/\r\n/);
  const out = [];
  const seen = new Set();
  const replaceAddress = (line) =>
    line.replace(/\bIN IP4 (\S+)/, (match, address) =>
      isPrivateAddress(address) && publicIpv4.length ? `IN IP4 ${publicIpv4[0]}` : match,
    );
  for (const line of lines) {
    if (line.startsWith('c=') || line.startsWith('a=rtcp:')) {
      out.push(replaceAddress(line));
      continue;
    }
    if (!line.startsWith('a=candidate:')) {
      out.push(line);
      continue;
    }
    const match = CANDIDATE.exec(line);
    if (!match) {
      // A reflexive or relayed candidate: keep it unless it names a private address.
      const address = line.split(' ')[4];
      if (!isPrivateAddress(address)) out.push(line);
      continue;
    }
    const [, foundation, component, transport, priority, address, port, rest] = match;
    if (!isPrivateAddress(address)) {
      out.push(line);
      continue;
    }
    if (isIP(address) !== 4) continue;
    for (const [index, publicAddress] of publicIpv4.entries()) {
      const key = `${publicAddress} ${port} ${transport.toLowerCase()} ${component}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(
        `a=candidate:${foundation}p${index} ${component} ${transport} ${priority} ${publicAddress} ${port} typ host${rest}`,
      );
    }
  }
  return out.join('\r\n');
}

// The public IPv4 addresses internet clients should send media to: the IPv4 literals among
// the public names, plus the A records of the DNS names, resolved now so a dynamic-DNS name
// follows the router's current address. A name that does not resolve in time is skipped.
export async function publicIpv4Addresses(names, { resolve = lookup, timeoutMs = 2000 } = {}) {
  const found = [];
  for (const name of names) {
    if (isIP(name) === 4) found.push(name);
    else if (!isIP(name)) {
      let timer;
      try {
        const rows = await Promise.race([
          resolve(name, { all: true, family: 4 }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          }),
        ]);
        for (const row of rows) found.push(row.address);
      } catch {
        // Unresolvable now: the literal addresses, or no public candidate at all.
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return [...new Set(found)].filter((address) => !isPrivateAddress(address));
}
