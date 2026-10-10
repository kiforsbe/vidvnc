import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

// macOS has no network profile, so LAN eligibility (decision D6 of the macOS design) comes
// from what each interface is: a physical Ethernet or Wi-Fi port that is up. The media
// worker reads that from SystemConfiguration in its read-only `--adapters` mode, which also
// works inside an App Sandbox, and prints one JSON document:
//
//   { "interfaces": [ { "name": "en0", "type": "IEEE80211", "thunderbolt": false, "up": true,
//       "addresses": [ { "address": "192.168.1.23", "prefixLength": 24 } ],
//       "router": { "address": "192.168.1.1", "hardwareAddress": "a4:2b:b0:11:22:33" } } ] }
//
// `type` is SCNetworkInterfaceGetInterfaceType's value, or null for an interface
// SystemConfiguration does not list (utun, awdl, llw). `thunderbolt` marks Ethernet over a
// Thunderbolt port. `router` is the interface's IPv4 router and its hardware address, or
// null; network-confirmation.mjs recognises a network by it.
//
// The rows have the shape normalizeWindowsLanRows produces, so local-session-scope.mjs
// applies the same rules to both. `profile` is always Private: it stands for the Windows
// Private profile, which macOS does not have. The app's confirmation of each new network
// (Q2) is what narrows it, and the shared scope still admits only private and unique-local
// addresses.

const MAX_INTERFACES = 256;
const MAX_ADDRESSES = 64;
const HARDWARE_ADDRESS = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const NAME = /^[a-z][a-z0-9]{0,15}$/;
const KINDS = { Ethernet: 'ethernet', IEEE80211: 'wifi' };

function invalid() {
  return new Error('Invalid macOS LAN metadata');
}

function prefixOf(address, prefixLength) {
  const bits = isIP(address) === 4 ? 32 : isIP(address) === 6 ? 128 : 0;
  if (!bits || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > bits)
    throw invalid();
  return prefixLength;
}

function routerOf(router) {
  if (router === null || router === undefined) return null;
  if (
    typeof router !== 'object' ||
    isIP(router.address) !== 4 ||
    typeof router.hardwareAddress !== 'string' ||
    !HARDWARE_ADDRESS.test(router.hardwareAddress)
  )
    throw invalid();
  return { address: router.address, hardwareAddress: router.hardwareAddress.toLowerCase() };
}

export function normalizeMacosLanRows(document) {
  const interfaces = document?.interfaces;
  if (!Array.isArray(interfaces) || interfaces.length > MAX_INTERFACES) throw invalid();
  return interfaces.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') throw invalid();
    if (!NAME.test(entry.name)) throw invalid();
    if (entry.type !== null && typeof entry.type !== 'string') throw invalid();
    if (!Array.isArray(entry.addresses) || entry.addresses.length > MAX_ADDRESSES) throw invalid();
    // Only built-in style `enN` ports are hardware; bridges, VPN tunnels and Thunderbolt
    // networking are not, whatever type they report.
    const physical =
      Object.hasOwn(KINDS, entry.type) && /^en\d+$/.test(entry.name) && entry.thunderbolt !== true;
    const router = routerOf(entry.router);
    return entry.addresses.map((row) => {
      if (!row || typeof row.address !== 'string') throw invalid();
      return {
        kind: physical ? KINDS[entry.type] : 'unknown',
        physical,
        up: entry.up === true,
        profile: 'Private',
        address: row.address,
        prefixLength: prefixOf(row.address, row.prefixLength),
        interface: entry.name,
        router,
      };
    });
  });
}

// Runs the worker with a fixed argument list; nothing from a setting or request reaches it.
export async function detectMacosLanAdapters({ executable, env, execute = run } = {}) {
  if (typeof executable !== 'string' || !executable) throw new Error('No media worker to ask');
  const { stdout } = await execute(executable, ['--adapters'], {
    env,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  let document;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw invalid();
  }
  return normalizeMacosLanRows(document);
}
