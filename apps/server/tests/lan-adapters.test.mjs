import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lanAdapterDetector } from '../src/lan-adapters.mjs';
import { detectMacosLanAdapters, normalizeMacosLanRows } from '../src/macos-lan-adapters.mjs';
import { createLocalSessionScope } from '../src/local-session-scope.mjs';

const recorded = (name) =>
  readFileSync(new URL(`./fixtures/macos-adapters/${name}.json`, import.meta.url), 'utf8');
const rows = (name) => normalizeMacosLanRows(JSON.parse(recorded(name)));
const eligible = (name) => createLocalSessionScope({ adapters: rows(name) }).bindAddresses;

test('the platform picks the LAN provider; elsewhere detection fails closed', async () => {
  const calls = [];
  const options = {
    executable: '/App/media-worker',
    env: () => ({ HOME: '/Users/u' }),
    windows: async () => calls.push('windows') && [],
    macos: async (args) => calls.push(args) && [],
  };
  await lanAdapterDetector({ ...options, platform: 'win32' })();
  await lanAdapterDetector({ ...options, platform: 'darwin' })();
  assert.deepEqual(calls, [
    'windows',
    { executable: '/App/media-worker', env: { HOME: '/Users/u' } },
  ]);
  await assert.rejects(lanAdapterDetector({ ...options, platform: 'linux' })(), /unavailable/);
});

test('the worker runs with a fixed argument list and a timeout', async () => {
  const calls = [];
  const result = await detectMacosLanAdapters({
    executable: '/App/media-worker',
    env: { A: '1' },
    execute: async (...args) => {
      calls.push(args);
      return { stdout: recorded('home') };
    },
  });
  assert.equal(calls.length, 1);
  const [file, args, options] = calls[0];
  assert.equal(file, '/App/media-worker');
  assert.deepEqual(args, ['--adapters']);
  assert.equal(options.timeout, 5000);
  assert.deepEqual(options.env, { A: '1' });
  assert.equal(result.length, 7);
  await assert.rejects(
    detectMacosLanAdapters({ executable: 'w', execute: async () => ({ stdout: 'oops' }) }),
    /Invalid macOS LAN metadata/,
  );
  await assert.rejects(detectMacosLanAdapters({}), /No media worker/);
});

test('macOS rows have the Windows row shape plus the interface and its router', () => {
  const [wifi] = rows('home');
  assert.deepEqual(wifi, {
    kind: 'wifi',
    physical: true,
    up: true,
    profile: 'Private',
    address: '192.168.1.23',
    prefixLength: 24,
    interface: 'en0',
    router: { address: '192.168.1.1', hardwareAddress: 'a4:2b:b0:11:22:33' },
  });
});

test('home Wi-Fi is eligible on its private and unique-local addresses only', () => {
  // Not the global IPv6, the link-local addresses, the unplugged Ethernet or AWDL.
  assert.deepEqual(eligible('home'), ['192.168.1.23', 'fd5e:2a1c:9b30:1::23']);
});

test('VPN tunnels are never eligible, even on private addresses', () => {
  assert.deepEqual(eligible('vpn'), ['192.168.1.23']);
  const tunnel = rows('vpn').find((row) => row.interface === 'utun4');
  assert.equal(tunnel.physical, false);
  assert.equal(tunnel.kind, 'unknown');
});

test('Thunderbolt Bridge and Thunderbolt Ethernet are not eligible; a USB Ethernet port is', () => {
  assert.deepEqual(eligible('bridge'), ['10.20.30.40']);
});

test('malformed worker output is refused as a whole', () => {
  const document = JSON.parse(recorded('home'));
  const broken = (change) => {
    const copy = structuredClone(document);
    change(copy);
    return () => normalizeMacosLanRows(copy);
  };
  for (const change of [
    (d) => delete d.interfaces,
    (d) => (d.interfaces = Array(257).fill(d.interfaces[0])),
    (d) => (d.interfaces[0].name = 'en0; rm -rf'),
    (d) => (d.interfaces[0].type = 7),
    (d) => (d.interfaces[0].addresses[0].address = 'not an address'),
    (d) => (d.interfaces[0].addresses[0].prefixLength = 33),
    (d) => (d.interfaces[0].addresses[1].prefixLength = 129),
    (d) => (d.interfaces[0].router.hardwareAddress = 'a4:2b'),
    (d) => (d.interfaces[0].router.address = 'fe80::1'),
  ])
    assert.throws(broken(change), /Invalid macOS LAN metadata/);
});
