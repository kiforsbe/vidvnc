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

// An internet client's offer, before the worker sees it: only candidates on public IP
// addresses are kept. webrtcbin runs connectivity checks toward every candidate it is given,
// so a private, link-local or hostname candidate would let a signed-in internet client aim
// the host's STUN checks (and ICE-TCP connections) at machines on this LAN, or make it look
// names up. Such candidates are useless from the internet anyway: the browser has only host
// candidates (it is given no STUN server), and the host learns the client's real address
// from the client's own checks as a peer-reflexive candidate.
export function filterOfferCandidates(sdp) {
  return sdp
    .split(/\r\n/)
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true;
      const address = line.split(' ')[4] ?? '';
      return isIP(address) !== 0 && !isPrivateAddress(address);
    })
    .join('\r\n');
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

// --- Media relay (design: docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-
// split-design.md). With the relay, the worker gathers on 127.0.0.1 only and learns clients
// solely from their authenticated checks through the relay.

const ICE_CREDENTIAL = /^[A-Za-z0-9+/]+$/;
const MAX_ANSWER_BYTES = 65536;
// Lines a worker answer may contain. Anything else fails the peer, so a worker (and, once
// the network process is sandboxed, a compromised one) cannot smuggle unexpected SDP to the
// browser.
const ANSWER_LINE = /^(v=0|o=|s=|t=|c=|b=|m=)/;
const ANSWER_ATTRIBUTES = new Set([
  'group',
  'msid-semantic',
  'mid',
  'ice-ufrag',
  'ice-pwd',
  'ice-options',
  'fingerprint',
  'setup',
  'sendrecv',
  'sendonly',
  'recvonly',
  'inactive',
  'rtcp',
  'rtcp-mux',
  'rtcp-rsize',
  'rtpmap',
  'fmtp',
  'rtcp-fb',
  'ssrc',
  'ssrc-group',
  'msid',
  'extmap',
  'sctp-port',
  'sctpmap',
  'max-message-size',
  'candidate',
  'end-of-candidates',
]);

// The client's offer with every candidate removed, so the worker sends connectivity checks
// to nobody and learns the client only through the relay. The ICE credentials stay.
export function stripOfferCandidates(sdp) {
  return sdp
    .split(/\r\n/)
    .filter((line) => !line.startsWith('a=candidate:'))
    .join('\r\n');
}

// The ICE username fragment and password of a description (session or first media level).
export function iceCredentials(sdp) {
  const value = (name) =>
    sdp
      .split(/\r\n/)
      .find((line) => line.startsWith(`a=${name}:`))
      ?.slice(name.length + 3);
  const ufrag = value('ice-ufrag');
  const pwd = value('ice-pwd');
  if (
    typeof ufrag !== 'string' ||
    typeof pwd !== 'string' ||
    ufrag.length < 4 ||
    ufrag.length > 256 ||
    pwd.length < 22 ||
    pwd.length > 256 ||
    !ICE_CREDENTIAL.test(ufrag) ||
    !ICE_CREDENTIAL.test(pwd)
  )
    throw new Error('Invalid ICE credentials');
  return { ufrag, pwd };
}

// Checks a worker answer for relay mode and returns its credentials and loopback port.
// It must hold exactly one candidate: UDP, component 1, 127.0.0.1, host.
export function validateRelayAnswer(sdp) {
  if (typeof sdp !== 'string' || Buffer.byteLength(sdp) > MAX_ANSWER_BYTES)
    throw new Error('Invalid answer: size');
  const lines = sdp.split(/\r\n/);
  if (lines.at(-1) === '') lines.pop();
  const candidates = [];
  for (const line of lines) {
    if (ANSWER_LINE.test(line)) continue;
    const attribute = /^a=([a-z0-9-]+)(?::|$)/i.exec(line)?.[1]?.toLowerCase();
    if (!attribute || !ANSWER_ATTRIBUTES.has(attribute))
      throw new Error(`Invalid answer: unexpected line ${JSON.stringify(line.slice(0, 40))}`);
    if (attribute === 'candidate') candidates.push(line);
  }
  if (candidates.length !== 1) throw new Error('Invalid answer: expected one candidate');
  const match =
    /^a=candidate:(\S+) 1 udp (\d+) 127\.0\.0\.1 (\d+) typ host(?: generation \d+)?$/i.exec(
      candidates[0],
    );
  const port = match ? Number(match[3]) : NaN;
  if (!match || port < 1024 || port > 65535)
    throw new Error('Invalid answer: candidate is not a loopback UDP host candidate');
  return { ...iceCredentials(sdp), port };
}

// Replaces the worker's loopback candidate with the relay's addresses on the media port.
// `addresses` are what this client can reach: the public addresses for an internet client,
// the address it used for HTTPS for everyone else.
export function announceRelay(sdp, addresses, mediaPort) {
  const usable = [...new Set(addresses.map((address) => address.split('%')[0]))].filter(
    (address) => isIP(address) !== 0,
  );
  if (!usable.length) throw new Error('No address to announce for the media relay');
  const ordered = [
    ...usable.filter((address) => isIP(address) === 4),
    ...usable.filter((address) => isIP(address) === 6),
  ];
  const first = ordered[0];
  const family = isIP(first) === 6 ? 'IP6' : 'IP4';
  const out = [];
  for (const line of sdp.split(/\r\n/)) {
    if (line.startsWith('c=')) {
      out.push(`c=IN ${family} ${first}`);
      continue;
    }
    if (line.startsWith('a=rtcp:')) {
      out.push(`a=rtcp:${mediaPort} IN ${family} ${first}`);
      continue;
    }
    const match = /^a=candidate:(\S+) (\d+) (udp) (\d+) 127\.0\.0\.1 \d+ typ host(.*)$/i.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, foundation, component, transport, priority, rest] = match;
    ordered.forEach((address, index) =>
      out.push(
        `a=candidate:${foundation}r${index} ${component} ${transport} ${Number(priority) - index} ${address} ${mediaPort} typ host${rest}`,
      ),
    );
  }
  return out.join('\r\n');
}
