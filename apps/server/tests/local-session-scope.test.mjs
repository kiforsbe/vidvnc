import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalSessionScope,
  createLocalSessionScopeController,
} from '../src/local-session-scope.mjs';
import { normalizeWindowsLanRows } from '../src/windows-lan-adapters.mjs';

const privateWifi = {
  kind: 'wifi',
  physical: true,
  up: true,
  profile: 'Private',
  address: '192.168.10.12',
  prefixLength: 24,
};

test('bind addresses follow eligible adapters, not a narrower peer CIDR', () => {
  const scope = createLocalSessionScope({
    adapters: [privateWifi, { ...privateWifi, address: '10.2.3.4', profile: 'Public' }],
    override: ['192.168.10.32/27'],
  });
  assert.deepEqual(scope.bindAddresses, ['192.168.10.12']);
  assert.equal(scope.allows('192.168.10.44', 'local'), true);
  assert.equal(scope.allows('192.168.10.90', 'local'), false);
  scope.update({ error: new Error('adapter query failed') });
  assert.deepEqual(scope.bindAddresses, []);
});

test('bind addresses include unique ULA host IPs and cannot be changed through the getter', () => {
  const ula = { ...privateWifi, address: 'fd12:3456:789a::42', prefixLength: 64 };
  const scope = createLocalSessionScope({ adapters: [privateWifi, ula, ula], override: 'auto' });
  assert.deepEqual(scope.bindAddresses, ['192.168.10.12', 'fd12:3456:789a::42']);
  scope.bindAddresses.push('203.0.113.9');
  assert.deepEqual(scope.bindAddresses, ['192.168.10.12', 'fd12:3456:789a::42']);
  scope.update({ adapters: [privateWifi], override: ['10.0.0.0/8'] });
  assert.deepEqual(scope.bindAddresses, ['192.168.10.12']);
  assert.equal(scope.allows('192.168.10.44', 'local'), false);
});

test('only local listeners and directly connected private physical LAN peers accept a standing password', () => {
  const scope = createLocalSessionScope({ adapters: [privateWifi], override: 'auto' });
  assert.equal(scope.allows('192.168.10.44', 'local'), true);
  assert.equal(scope.allows('::ffff:192.168.10.44', 'local'), true);
  assert.equal(scope.allows('192.168.11.44', 'local'), false);
  assert.equal(scope.allows('203.0.113.9', 'local'), false);
  assert.equal(scope.allows('127.0.0.1', 'local'), true);
  assert.equal(scope.allows('::1', 'local'), true);
  assert.equal(scope.allows('127.0.0.1', 'public'), false);
  assert.equal(scope.allows('192.168.10.44', 'public'), false);
  assert.throws(() => scope.allows('127.0.0.1', 'unknown'), /listener scope/i);
});

test('Public profiles, virtual adapters, down links, and public or link-local subnets do not count', () => {
  const rows = [
    { ...privateWifi, profile: 'Public' },
    { ...privateWifi, physical: false, address: '10.1.2.3', prefixLength: 24 },
    { ...privateWifi, kind: 'vpn', address: '10.2.3.4' },
    { ...privateWifi, up: false, address: '10.3.4.5' },
    { ...privateWifi, address: '169.254.2.3', prefixLength: 16 },
    { ...privateWifi, address: '203.0.113.12', prefixLength: 24 },
    { ...privateWifi, address: '10.2.3.4', prefixLength: 0 },
  ];
  const scope = createLocalSessionScope({ adapters: rows, override: 'auto' });
  for (const peer of [
    '192.168.10.44',
    '10.1.2.4',
    '10.2.3.5',
    '10.3.4.6',
    '169.254.2.4',
    '203.0.113.13',
  ])
    assert.equal(scope.allows(peer, 'local'), false, peer);
  assert.equal(scope.allows('127.0.0.1', 'local'), true);
  assert.match(scope.reason, /loopback|eligible/i);
});

test('CIDR override only narrows an eligible on-link subnet and fails closed if any entry is off-link', () => {
  const narrowed = createLocalSessionScope({
    adapters: [privateWifi],
    override: ['192.168.10.32/27'],
  });
  assert.equal(narrowed.allows('192.168.10.44', 'local'), true);
  assert.equal(narrowed.allows('192.168.10.90', 'local'), false);
  const unsafe = createLocalSessionScope({
    adapters: [privateWifi],
    override: ['192.168.10.32/27', '10.0.0.0/8'],
  });
  assert.equal(unsafe.allows('192.168.10.44', 'local'), false);
  assert.equal(unsafe.allows('127.0.0.1', 'local'), true);
  assert.match(unsafe.reason, /off-link|override/i);
});

test('IPv6 ULA works only on eligible link, and detection failure stays loopback-only', () => {
  const scope = createLocalSessionScope({
    adapters: [{ ...privateWifi, address: 'fd12:3456:789a::42', prefixLength: 64 }],
    override: 'auto',
  });
  assert.equal(scope.allows('fd12:3456:789a::88', 'local'), true);
  assert.equal(scope.allows('fd12:3456:789b::88', 'local'), false);
  scope.update({ adapters: [], error: new Error('PowerShell unavailable') });
  assert.equal(scope.allows('fd12:3456:789a::88', 'local'), false);
  assert.equal(scope.allows('::1', 'local'), true);
  assert.match(scope.reason, /PowerShell unavailable/);
});

test('Windows adapter metadata only normalizes real wired or wireless media with explicit profile', () => {
  assert.deepEqual(
    normalizeWindowsLanRows([
      {
        medium: 14,
        physical: true,
        status: 'Up',
        profile: 'Private',
        address: '10.1.2.3',
        prefixLength: 24,
      },
      {
        medium: 9,
        physical: true,
        status: 'Up',
        profile: 'Public',
        address: '192.168.1.2',
        prefixLength: 24,
      },
      {
        medium: 0,
        physical: true,
        status: 'Up',
        profile: 'Private',
        address: '10.9.9.1',
        prefixLength: 24,
      },
    ]),
    [
      {
        kind: 'ethernet',
        physical: true,
        up: true,
        profile: 'Private',
        address: '10.1.2.3',
        prefixLength: 24,
      },
      {
        kind: 'wifi',
        physical: true,
        up: true,
        profile: 'Public',
        address: '192.168.1.2',
        prefixLength: 24,
      },
      {
        kind: 'unknown',
        physical: true,
        up: true,
        profile: 'Private',
        address: '10.9.9.1',
        prefixLength: 24,
      },
    ],
  );
});

test('LAN refresh revokes access when profile changes or detection fails and applies edited CIDR settings', async () => {
  let rows = [privateWifi];
  let override = 'auto';
  const messages = [];
  const controller = createLocalSessionScopeController({
    access: { snapshot: () => ({ localSessionNetworks: override }) },
    detect: async () => rows,
    log: (message) => messages.push(message),
  });
  assert.equal(controller.scope.allows('192.168.10.44', 'local'), false);
  await controller.refresh();
  assert.equal(controller.scope.allows('192.168.10.44', 'local'), true);
  override = ['192.168.10.64/27'];
  await controller.refresh();
  assert.equal(controller.scope.allows('192.168.10.44', 'local'), false);
  assert.equal(controller.scope.allows('192.168.10.70', 'local'), true);
  rows = [{ ...privateWifi, profile: 'Public' }];
  await controller.refresh();
  assert.equal(controller.scope.allows('192.168.10.70', 'local'), false);
  assert.ok(messages.some((message) => /loopback-only/.test(message)));
});
