import { isIP } from 'node:net';

const PRIVATE_RANGES = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['fc00::', 7],
];

function ipBits(address) {
  const family = isIP(address);
  if (family === 4) {
    const value = address.split('.').reduce((n, octet) => (n << 8n) | BigInt(octet), 0n);
    return { family, value, bits: 32 };
  }
  if (family !== 6 || address.includes('.')) return null;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
  if (words.length !== 8) return null;
  return {
    family,
    value: words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n),
    bits: 128,
  };
}

function network(address, prefixLength) {
  const parsed = ipBits(address);
  if (!parsed || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > parsed.bits)
    return null;
  const shift = BigInt(parsed.bits - prefixLength);
  return { ...parsed, prefixLength, base: (parsed.value >> shift) << shift };
}

function contains(outer, inner) {
  return (
    outer.family === inner.family &&
    inner.prefixLength >= outer.prefixLength &&
    inner.base >> BigInt(outer.bits - outer.prefixLength) ===
      outer.base >> BigInt(outer.bits - outer.prefixLength)
  );
}

const privateNetworks = PRIVATE_RANGES.map(([address, prefix]) => network(address, prefix));

function eligibleNetworks(adapters, profiles) {
  const result = [];
  for (const adapter of adapters) {
    const profile = adapter.profile ?? profiles?.get?.(adapter.interfaceIndex);
    if (
      adapter.physical !== true ||
      adapter.up !== true ||
      profile !== 'Private' ||
      !['ethernet', 'wifi'].includes(adapter.kind)
    )
      continue;
    const candidate = network(adapter.address, adapter.prefixLength);
    if (candidate && privateNetworks.some((range) => contains(range, candidate)))
      result.push(candidate);
  }
  return result;
}

function parseOverride(override) {
  if (override === 'auto') return null;
  if (!Array.isArray(override) || !override.length) return false;
  const entries = override.map((cidr) => {
    if (typeof cidr !== 'string') return null;
    const match = /^(.+)\/(\d{1,3})$/.exec(cidr);
    return match ? network(match[1], Number(match[2])) : null;
  });
  return entries.every(Boolean) ? entries : false;
}

function normalizedPeer(address) {
  if (typeof address !== 'string') return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

export function createLocalSessionScope({
  adapters = [],
  networkProfiles = null,
  override = 'auto',
} = {}) {
  let allowed = [];
  let reason = null;
  const scope = {
    get reason() {
      return reason;
    },
    update({
      adapters: rows = [],
      networkProfiles: profiles = networkProfiles,
      error = null,
      override: nextOverride = override,
    } = {}) {
      override = nextOverride;
      if (error) {
        allowed = [];
        reason = `LAN detection failed; standing password is loopback-only: ${error.message}`;
        return;
      }
      const detected = eligibleNetworks(rows, profiles);
      const requested = parseOverride(override);
      if (
        requested === false ||
        (requested && !requested.every((entry) => detected.some((link) => contains(link, entry))))
      ) {
        allowed = [];
        reason = 'LAN override is invalid or off-link; standing password is loopback-only.';
      } else {
        allowed = requested ?? detected;
        reason = allowed.length
          ? null
          : 'No eligible Private physical LAN; standing password is loopback-only.';
      }
    },
    allows(peerAddress, listenerScope) {
      if (listenerScope === 'public') return false;
      if (listenerScope !== 'local') throw new Error('Invalid listener scope');
      const peer = normalizedPeer(peerAddress);
      if (peer === '127.0.0.1' || peer === '::1') return true;
      const parsed = peer && ipBits(peer);
      if (!parsed) return false;
      const address = { ...parsed, prefixLength: parsed.bits, base: parsed.value };
      return allowed.some((link) => contains(link, address));
    },
  };
  scope.update({ adapters, networkProfiles, override });
  return scope;
}

export function createLocalSessionScopeController({ access, detect, log = () => {} }) {
  const scope = createLocalSessionScope({ override: access.snapshot().localSessionNetworks });
  let pending = null;
  return {
    scope,
    refresh() {
      if (pending) return pending;
      pending = (async () => {
        const previous = scope.reason;
        try {
          scope.update({
            adapters: await detect(),
            override: access.snapshot().localSessionNetworks,
          });
        } catch (error) {
          scope.update({ error, override: access.snapshot().localSessionNetworks });
        }
        if (scope.reason !== previous)
          log(
            scope.reason
              ? `Warning: ${scope.reason}`
              : 'Private physical LAN detected for local standing passwords.',
          );
      })().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
