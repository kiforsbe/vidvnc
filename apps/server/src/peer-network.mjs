import { isIP } from 'node:net';
import { networkInterfaces as systemInterfaces } from 'node:os';

// Whether a client reached this PC from the internet, as opposed to the local network or a
// private overlay such as a VPN. This is deliberately broader than local-session-scope.mjs,
// which answers a narrower question (may this peer use the standing password?): a WireGuard
// or Tailscale client is not on this PC's physical LAN, but it is not the internet either,
// and remote access being off must not lock it out.
//
// Decided from the socket's source address only. VidVNC is reached by direct port forwarding,
// where that is the client's own address; a same-host reverse proxy would make every client
// look private and is not a supported setup.
//
// Not internet: loopback, RFC 1918, link-local, carrier-grade NAT / overlay VPN
// (100.64.0.0/10), IPv6 unique-local, and any IPv6 address inside a prefix one of this PC's
// adapters is on (home networks hand out global IPv6 addresses). IPv4 is never matched by
// adapter subnet: a PC with a public IPv4 address shares that subnet with strangers.

const PRIVATE = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
  ['::1', 128],
  ['fe80::', 10],
  ['fc00::', 7],
];

function bits(address) {
  const family = isIP(address);
  if (family === 4)
    return {
      family,
      width: 32,
      value: address.split('.').reduce((n, octet) => (n << 8n) | BigInt(octet), 0n),
    };
  if (family !== 6 || address.includes('.')) return null;
  const [head, tail] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const words = address.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (words.length !== 8) return null;
  return {
    family,
    width: 128,
    value: words.reduce((n, word) => (n << 16n) | BigInt(`0x${word || '0'}`), 0n),
  };
}

function inside(address, base, prefix) {
  const a = bits(address);
  const b = bits(base);
  if (!a || !b || a.family !== b.family) return false;
  const shift = BigInt(a.width - prefix);
  return a.value >> shift === b.value >> shift;
}

// The plain form of a socket address: zone id dropped, IPv4-mapped IPv6 reduced to IPv4.
export function plainAddress(address) {
  if (typeof address !== 'string') return '';
  const plain = address.split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain);
  return mapped ? mapped[1] : plain;
}

export function isPrivateAddress(address) {
  const plain = plainAddress(address);
  return PRIVATE.some(([base, prefix]) => inside(plain, base, prefix));
}

export function createPeerNetwork({ interfaces = systemInterfaces } = {}) {
  const onLinkIpv6 = (plain) => {
    let rows;
    try {
      rows = Object.values(interfaces() ?? {}).flat();
    } catch {
      return false;
    }
    return rows.some((row) => {
      if (!row?.cidr || isIP(plain) !== 6) return false;
      const [base, prefix] = row.cidr.split('/');
      const length = Number(prefix);
      return (
        isIP(base.split('%')[0]) === 6 && length > 0 && inside(plain, base.split('%')[0], length)
      );
    });
  };
  return {
    // Unknown or malformed addresses count as internet: the check fails closed.
    isInternet(address) {
      const plain = plainAddress(address);
      if (!isIP(plain)) return true;
      return !isPrivateAddress(plain) && !onLinkIpv6(plain);
    },
  };
}
