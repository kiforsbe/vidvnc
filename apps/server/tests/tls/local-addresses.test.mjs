import test from 'node:test';
import assert from 'node:assert/strict';
import { localAddresses } from '../../src/tls/local-addresses.mjs';

test('loopback and localhost are always present even when discovery returns nothing', () => {
  const result = localAddresses({ interfaces: () => ({}), hostname: () => '' });
  assert.deepEqual(result.hostnames, ['localhost']);
  assert.deepEqual(result.ips, ['127.0.0.1', '::1']);
  assert.deepEqual(result.errors, []);
});

test('the machine hostname is included', () => {
  const result = localAddresses({ interfaces: () => ({}), hostname: () => 'my-machine' });
  assert.deepEqual(result.hostnames, ['localhost', 'my-machine']);
});

test('duplicate addresses across sources and against loopback collapse', () => {
  const interfaces = () => ({
    Ethernet: [
      { address: '192.168.1.5', family: 'IPv4', internal: false },
      { address: '192.168.1.5', family: 'IPv4', internal: false },
      { address: '127.0.0.1', family: 'IPv4', internal: true },
    ],
    'Wi-Fi': [{ address: '192.168.1.5', family: 'IPv4', internal: false }],
  });
  const result = localAddresses({ interfaces, hostname: () => 'localhost' });
  assert.deepEqual(result.ips, ['127.0.0.1', '192.168.1.5', '::1']);
  assert.deepEqual(result.hostnames, ['localhost']);
});

test('IPv4 and IPv6 addresses are both captured and stay out of the hostname list', () => {
  const interfaces = () => ({
    Ethernet: [
      { address: '10.0.0.4', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
  });
  const result = localAddresses({ interfaces, hostname: () => 'host' });
  assert.ok(result.ips.includes('10.0.0.4'));
  assert.ok(result.ips.includes('fe80::1'));
  assert.ok(!result.hostnames.includes('10.0.0.4'));
  assert.ok(!result.hostnames.includes('fe80::1'));
});

test('IPv6 zone ids are stripped so entries are usable as certificate SAN values', () => {
  const interfaces = () => ({
    Ethernet: [{ address: 'fe80::1%eth0', family: 'IPv6', internal: false }],
  });
  const result = localAddresses({ interfaces, hostname: () => 'host' });
  assert.ok(result.ips.includes('fe80::1'));
  assert.ok(!result.ips.some((ip) => ip.includes('%')));
});

test('a source that throws is tolerated rather than fatal', () => {
  const result = localAddresses({
    interfaces: () => {
      throw new Error('adapter enumeration failed');
    },
    hostname: () => {
      throw new Error('hostname lookup failed');
    },
  });
  assert.deepEqual(result.hostnames, ['localhost']);
  assert.deepEqual(result.ips, ['127.0.0.1', '::1']);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((e) => e.source === 'interfaces' && /adapter/.test(e.message)));
  assert.ok(result.errors.some((e) => e.source === 'hostname' && /hostname/.test(e.message)));
});

test('one source throwing does not block the other from contributing', () => {
  const result = localAddresses({
    interfaces: () => {
      throw new Error('boom');
    },
    hostname: () => 'still-works',
  });
  assert.deepEqual(result.hostnames, ['localhost', 'still-works']);
  assert.deepEqual(result.ips, ['127.0.0.1', '::1']);
  assert.deepEqual(result.errors, [{ source: 'interfaces', message: 'boom' }]);
});

test('results are stable in order so comparisons downstream are deterministic', () => {
  const interfaces = () => ({
    b: [{ address: '10.0.0.9', family: 'IPv4', internal: false }],
    a: [
      { address: '10.0.0.2', family: 'IPv4', internal: false },
      { address: 'abcd::1', family: 'IPv6', internal: false },
    ],
  });
  const first = localAddresses({ interfaces, hostname: () => 'zzz-host' });
  const second = localAddresses({ interfaces, hostname: () => 'zzz-host' });
  assert.deepEqual(first, second);
  // IPv4 addresses sort before IPv6, then lexicographically within each family.
  assert.deepEqual(first.ips, ['10.0.0.2', '10.0.0.9', '127.0.0.1', '::1', 'abcd::1']);
  assert.deepEqual(first.hostnames, ['localhost', 'zzz-host']);
});

test('the real default sources work against the actual machine', () => {
  const result = localAddresses();
  assert.ok(result.hostnames.includes('localhost'));
  assert.ok(result.ips.includes('127.0.0.1'));
  assert.ok(result.ips.includes('::1'));
  assert.equal(new Set(result.hostnames).size, result.hostnames.length);
  assert.equal(new Set(result.ips).size, result.ips.length);
});
