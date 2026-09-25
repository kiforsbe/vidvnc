import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerNetwork, isPrivateAddress, plainAddress } from '../src/peer-network.mjs';

const noAdapters = createPeerNetwork({ interfaces: () => ({}) });

test('private, loopback, link-local and unique-local addresses are not the internet', () => {
  for (const address of [
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '127.0.0.1',
    '169.254.10.10',
    '::1',
    'fe80::1%eth0',
    'fd12:3456::1',
    '::ffff:192.168.1.20',
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
    assert.equal(noAdapters.isInternet(address), false, address);
  }
});

test('public addresses, and look-alikes just outside the private ranges, are the internet', () => {
  for (const address of [
    '203.0.113.10',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.255.255',
    '100.128.0.1',
    '192.169.0.1',
    '2001:db8::1',
    '::ffff:203.0.113.10',
  ])
    assert.equal(noAdapters.isInternet(address), true, address);
});

test('an unknown address fails closed as the internet', () => {
  for (const address of [undefined, '', 'not-an-address'])
    assert.equal(noAdapters.isInternet(address), true);
});

test('an IPv6 address on one of this PC’s prefixes is local, an IPv4 subnet never is', () => {
  const peers = createPeerNetwork({
    interfaces: () => ({
      ethernet: [
        { address: '2001:db8:1:2::10', cidr: '2001:db8:1:2::10/64' },
        { address: '198.51.100.7', cidr: '198.51.100.7/24' },
      ],
    }),
  });
  assert.equal(peers.isInternet('2001:db8:1:2:abcd::99'), false);
  assert.equal(peers.isInternet('2001:db8:1:3::99'), true);
  assert.equal(
    peers.isInternet('198.51.100.8'),
    true,
    'a public IPv4 subnet is shared with strangers',
  );
});

test('plainAddress drops zones and unwraps IPv4-mapped IPv6', () => {
  assert.equal(plainAddress('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(plainAddress('fe80::1%12'), 'fe80::1');
  assert.equal(plainAddress(undefined), '');
});

test('carrier-grade NAT space is private only while this PC is on an overlay VPN in it', () => {
  assert.equal(isPrivateAddress('100.64.0.1'), true, 'never a public SDP address');
  assert.equal(noAdapters.isInternet('100.64.0.1'), true, 'an ISP neighbour is a stranger');
  const tailscale = createPeerNetwork({
    interfaces: () => ({ Tailscale: [{ address: '100.101.102.103', cidr: '100.101.102.103/32' }] }),
  });
  assert.equal(tailscale.isInternet('100.127.255.255'), false);
  assert.equal(tailscale.isInternet('100.128.0.1'), true);
});
