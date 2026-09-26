import { isIP } from 'node:net';
import { networkInterfaces as systemInterfaces } from 'node:os';
import { isPrivateAddress, plainAddress } from './peer-network.mjs';
import { publicIpv4Addresses } from './sdp-candidates.mjs';

// The addresses a client is told to send media to: the media relay's port on an address the
// client can reach (design: docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-
// split-design.md, "Signaling changes", step 4).
//
// - An internet client gets each public IPv4 address of the public names, and each global
//   IPv6 address of this PC (reachable only where the router's IPv6 firewall allows UDP to
//   the media port).
// - Everyone else gets the address they already reached over HTTPS. An IPv6 link-local
//   address cannot carry its zone in SDP, so it is replaced by the IPv4, unique-local and
//   global addresses of the interface that owns it.

const rows = (interfaces) => {
  try {
    return Object.values(interfaces() ?? {}).flat();
  } catch {
    return [];
  }
};

const LINK_LOCAL = /^fe[89ab][0-9a-f]:/i;

export function globalIpv6Addresses(interfaces = systemInterfaces) {
  return rows(interfaces)
    .filter((row) => !row?.internal && isIP(plainAddress(row?.address)) === 6)
    .map((row) => plainAddress(row.address))
    .filter((address) => !isPrivateAddress(address));
}

export function localRelayAddresses(localAddress, interfaces = systemInterfaces) {
  const plain = plainAddress(localAddress);
  if (!isIP(plain)) return [];
  if (!LINK_LOCAL.test(plain)) return [plain];
  const owner = Object.values(interfaces() ?? {}).find((addresses) =>
    (addresses ?? []).some((row) => plainAddress(row?.address) === plain),
  );
  return (owner ?? [])
    .map((row) => plainAddress(row?.address))
    .filter((address) => isIP(address) && !LINK_LOCAL.test(address));
}

export function createRelayAddresses({
  publicNames = () => [],
  resolvePublicIpv4 = publicIpv4Addresses,
  interfaces = systemInterfaces,
} = {}) {
  return async ({ internet, localAddress }) => {
    const addresses = internet
      ? [...(await resolvePublicIpv4(publicNames())), ...globalIpv6Addresses(interfaces)]
      : localRelayAddresses(localAddress, interfaces);
    if (!addresses.length)
      throw Object.assign(
        new Error(
          internet
            ? 'No public address to send media to. Set a public name (public-hostnames) that resolves to your router.'
            : 'No address to send media to on this network.',
        ),
        { status: 503 },
      );
    return addresses;
  };
}
