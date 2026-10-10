import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnownNetworks, MAX_KNOWN_NETWORKS, networksOf } from '../src/network-confirmation.mjs';
import { createLocalSessionScope } from '../src/local-session-scope.mjs';

const wifi = {
  kind: 'wifi',
  physical: true,
  up: true,
  profile: 'Private',
  address: '192.168.1.23',
  prefixLength: 24,
  interface: 'en0',
  router: { address: '192.168.1.1', hardwareAddress: 'a4:2b:b0:11:22:33' },
};
const ula = { ...wifi, address: 'fd5e:2a1c:9b30:1::23', prefixLength: 64 };
const vpn = { ...wifi, kind: 'unknown', physical: false, interface: 'utun4', address: '10.8.0.6' };

async function directory(t) {
  const folder = await mkdtemp(join(tmpdir(), 'vidvnc-networks-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return join(folder, 'settings');
}

test('a network is its interface subnets and router, asked about once for IPv4 and IPv6', () => {
  const networks = networksOf([wifi, ula, vpn]);
  assert.deepEqual([...networks.keys()], ['en0']);
  const network = networks.get('en0');
  assert.deepEqual(network.subnets, ['192.168.1.0/24']);
  assert.equal(network.router, 'a4:2b:b0:11:22:33');
  assert.match(network.id, /^[0-9a-f]{16}$/);
  // Same subnet behind another router is another network; the same one again is not.
  const other = networksOf([
    { ...wifi, router: { ...wifi.router, hardwareAddress: 'aa:aa:aa:aa:aa:aa' } },
  ]);
  assert.notEqual(other.get('en0').id, network.id);
  assert.equal(networksOf([{ ...wifi, address: '192.168.1.99' }]).get('en0').id, network.id);
  // An IPv6-only link is identified by its prefix.
  assert.deepEqual(networksOf([ula]).get('en0').subnets, ['fd5e:2a1c:9b30:1::/64']);
});

test('a new network is not eligible until the owner allows it, and stays refused when refused', async (t) => {
  const file = join(await directory(t), 'known-networks.json');
  let now = 1000;
  const known = await KnownNetworks.open(file, { now: () => now });
  const scope = createLocalSessionScope({ adapters: known.apply([wifi, ula, vpn]) });
  assert.deepEqual(scope.bindAddresses, []);
  const [pending] = known.pending();
  assert.deepEqual(pending, { ...networksOf([wifi]).get('en0'), firstSeenAt: 1000 });
  now = 2000;
  known.apply([wifi]);
  assert.equal(known.pending()[0].firstSeenAt, 1000, 'first seen is kept while it waits');

  await known.decide(pending.id, true);
  assert.deepEqual(known.pending(), []);
  scope.update({ adapters: known.apply([wifi, ula, vpn]) });
  assert.deepEqual(scope.bindAddresses, ['192.168.1.23', 'fd5e:2a1c:9b30:1::23']);

  // Reopened, the answer is remembered; refusing it later takes the LAN away again.
  const reopened = await KnownNetworks.open(file);
  assert.deepEqual(reopened.apply([wifi]), [wifi]);
  await reopened.decide(pending.id, false);
  scope.update({ adapters: reopened.apply([wifi]) });
  assert.deepEqual(scope.bindAddresses, []);
  assert.deepEqual(reopened.pending(), []);
  assert.equal(reopened.known()[0].allow, false);
});

test('a network that went away stops waiting, and unknown answers are refused', async (t) => {
  const known = await KnownNetworks.open(join(await directory(t), 'known-networks.json'));
  known.apply([wifi]);
  const [{ id }] = known.pending();
  known.apply([]);
  assert.deepEqual(known.pending(), []);
  await assert.rejects(known.decide(id, true), /Unknown network/);
  await assert.rejects(known.decide('../../etc', true), /Unknown network/);
  known.apply([wifi]);
  await assert.rejects(known.decide(id, 'yes'), /Invalid network decision/);
});

test('the known networks file is private to the user and holds no addresses of the host', async (t) => {
  const folder = await directory(t);
  const file = join(folder, 'known-networks.json');
  const known = await KnownNetworks.open(file, { now: () => 5 });
  known.apply([wifi]);
  const [{ id }] = known.pending();
  await known.decide(id, true);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, {
    schemaVersion: 1,
    networks: [
      { id, subnets: ['192.168.1.0/24'], router: 'a4:2b:b0:11:22:33', allow: true, decidedAt: 5 },
    ],
  });
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(folder)).mode & 0o777, 0o700);
  }
});

test('only the newest decisions are kept', async (t) => {
  const file = join(await directory(t), 'known-networks.json');
  let now = 0;
  const known = await KnownNetworks.open(file, { now: () => ++now });
  for (let n = 0; n <= MAX_KNOWN_NETWORKS; n++) {
    const row = { ...wifi, address: `10.${n >> 8}.${n & 255}.1` };
    known.apply([row]);
    await known.decide(known.pending()[0].id, true);
  }
  const kept = (await KnownNetworks.open(file)).known();
  assert.equal(kept.length, MAX_KNOWN_NETWORKS);
  assert.deepEqual(kept[0].subnets, ['10.0.1.0/24']);
});

test('a missing file is an empty list, and a damaged or newer one is refused', async (t) => {
  const folder = await directory(t);
  const file = join(folder, 'known-networks.json');
  assert.deepEqual((await KnownNetworks.open(file)).known(), []);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(folder, { recursive: true });
  const row = {
    id: '0123456789abcdef',
    subnets: ['192.168.1.0/24'],
    router: null,
    allow: true,
    decidedAt: 1,
  };
  for (const contents of [
    'not json',
    JSON.stringify({ schemaVersion: 2, networks: [] }),
    JSON.stringify({ schemaVersion: 1, networks: [], extra: true }),
    JSON.stringify({ schemaVersion: 1, networks: [row, row] }),
    JSON.stringify({ schemaVersion: 1, networks: [{ ...row, allow: 'yes' }] }),
    JSON.stringify({ schemaVersion: 1, networks: [{ ...row, id: 'x' }] }),
    JSON.stringify({ schemaVersion: 1, networks: [{ ...row, subnets: [] }] }),
  ]) {
    await writeFile(file, contents);
    await assert.rejects(KnownNetworks.open(file), /Invalid known networks file/, contents);
  }
  await writeFile(file, JSON.stringify({ schemaVersion: 1, networks: [row] }));
  assert.deepEqual((await KnownNetworks.open(file)).known(), [row]);
});
