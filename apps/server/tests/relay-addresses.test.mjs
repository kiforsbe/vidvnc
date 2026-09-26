import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRelayAddresses,
  globalIpv6Addresses,
  localRelayAddresses,
} from '../src/relay-addresses.mjs';

const interfaces = () => ({
  Ethernet: [
    { address: '192.168.1.10', family: 'IPv4', internal: false },
    { address: 'fe80::1c2d:3e4f:5a6b:7c8d', family: 'IPv6', internal: false, scopeid: 12 },
    { address: 'fd12:3456:789a::10', family: 'IPv6', internal: false },
    { address: '2001:db8:1234:5678::10', family: 'IPv6', internal: false },
  ],
  Tailscale: [
    { address: '100.101.102.103', family: 'IPv4', internal: false },
    { address: 'fe80::aaaa', family: 'IPv6', internal: false },
  ],
  Loopback: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
  ],
});

test('local clients get the address they reached over HTTPS', () => {
  assert.deepEqual(localRelayAddresses('::ffff:192.168.1.10', interfaces), ['192.168.1.10']);
  assert.deepEqual(localRelayAddresses('127.0.0.1', interfaces), ['127.0.0.1']);
  assert.deepEqual(localRelayAddresses('::1', interfaces), ['::1']);
  assert.deepEqual(localRelayAddresses('fd12:3456:789a::10', interfaces), ['fd12:3456:789a::10']);
  assert.deepEqual(localRelayAddresses('garbage', interfaces), []);
});

test('an IPv6 link-local address is replaced by its interface addresses', () => {
  assert.deepEqual(localRelayAddresses('fe80::1c2d:3e4f:5a6b:7c8d%12', interfaces), [
    '192.168.1.10',
    'fd12:3456:789a::10',
    '2001:db8:1234:5678::10',
  ]);
  assert.deepEqual(localRelayAddresses('fe80::aaaa%7', interfaces), ['100.101.102.103']);
  assert.deepEqual(localRelayAddresses('fe80::9999%3', interfaces), []);
});

test('internet clients get the public IPv4 of the public names and global IPv6', async () => {
  assert.deepEqual(globalIpv6Addresses(interfaces), ['2001:db8:1234:5678::10']);
  const resolved = [];
  const addresses = createRelayAddresses({
    publicNames: () => ['vnc.example.com'],
    resolvePublicIpv4: async (names) => {
      resolved.push(names);
      return ['203.0.113.10'];
    },
    interfaces,
  });
  assert.deepEqual(await addresses({ internet: true, localAddress: '192.168.1.10' }), [
    '203.0.113.10',
    '2001:db8:1234:5678::10',
  ]);
  assert.deepEqual(resolved, [['vnc.example.com']]);
  assert.deepEqual(await addresses({ internet: false, localAddress: '192.168.1.10' }), [
    '192.168.1.10',
  ]);
});

test('no usable address refuses the stream with the reason', async () => {
  const addresses = createRelayAddresses({
    publicNames: () => [],
    resolvePublicIpv4: async () => [],
    interfaces: () => ({}),
  });
  await assert.rejects(
    addresses({ internet: true, localAddress: '192.168.1.10' }),
    (error) => error.status === 503 && /public name/.test(error.message),
  );
  await assert.rejects(addresses({ internet: false, localAddress: 'fe80::1%1' }), /No address/);
});
