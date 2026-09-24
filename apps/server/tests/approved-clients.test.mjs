import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovedClientStore } from '../src/approved-clients.mjs';
import { ConnectionKeyRegistry } from '../src/connection-keys.mjs';
import { AdmissionBudget } from '../src/admission-budget.mjs';
const ticket = (store) => store.issueRegistrationTicket().registrationTicket;

test('setup claim is isolated, single-use, and approval persists only verifiers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-approved-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'approved-clients.json');
  const keys = new ConnectionKeyRegistry();
  const store = await ApprovedClientStore.open(filename, { keys });
  const setup = keys.createSetup({ ttlMs: 60_000 });
  assert.ok(keys.use(setup.key, 'approved-client-setup'));
  const registrationTicket = ticket(store);
  const registration = await store.submit({
    registrationTicket,
    deviceName: 'Kim’s iPhone',
    username: 'kim',
    password: 'correct horse battery staple',
    installationId: 'browser-installation-1',
    client: 'Safari on iOS',
    network: 'Local network',
  });
  assert.equal(keys.inspect(setup.key), null);
  await assert.rejects(() => store.submit({ registrationTicket }), /ticket/i);
  assert.deepEqual(store.registrationStatus(registration.requestId, 'wrong-claim'), {
    state: 'invalid',
  });
  assert.deepEqual(store.registrationStatus(registration.requestId, registration.claimToken), {
    state: 'pending',
  });
  assert.equal(store.status().pending[0].username, 'kim');
  assert.equal(JSON.stringify(store.status()).includes('correct horse'), false);

  await store.approve(registration.requestId);
  const completed = store.registrationStatus(registration.requestId, registration.claimToken);
  assert.equal(completed.state, 'approved');
  assert.equal(completed.username, 'kim');
  assert.match(completed.clientId, /^[a-f0-9-]{36}$/);
  assert.match(completed.clientSecret, /^[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(store.registrationStatus(registration.requestId, registration.claimToken), {
    state: 'approved',
    claimed: true,
  });

  const persisted = await readFile(filename, 'utf8');
  assert.equal(persisted.includes('correct horse battery staple'), false);
  assert.equal(persisted.includes(completed.clientSecret), false);
  assert.equal(persisted.includes(setup.key), false);
  assert.equal(JSON.parse(persisted).clients[0].username, 'kim');

  const reopened = await ApprovedClientStore.open(filename, { keys });
  const credential = {
    clientId: completed.clientId,
    clientSecret: completed.clientSecret,
    username: 'kim',
    password: 'correct horse battery staple',
  };
  assert.equal((await reopened.authenticate(credential)).deviceName, 'Kim’s iPhone');
  for (const changed of [
    { ...credential, username: 'someone-else' },
    { ...credential, password: 'wrong password' },
    { ...credential, clientSecret: 'wrong-secret' },
  ])
    assert.equal(await reopened.authenticate(changed), null);
  await reopened.remove(completed.clientId);
  assert.equal(await reopened.authenticate(credential), null);
});

test('rejected requests never receive a client secret', async () => {
  const keys = new ConnectionKeyRegistry();
  const store = await ApprovedClientStore.open(null, { keys });
  const registration = await store.submit({
    registrationTicket: ticket(store),
    deviceName: 'Unknown phone',
    username: 'visitor',
    password: 'a sufficiently long password',
    installationId: 'browser-installation-2',
    client: 'Mobile browser',
  });
  store.reject(registration.requestId);
  assert.deepEqual(store.registrationStatus(registration.requestId, registration.claimToken), {
    state: 'rejected',
  });
});

test('approved-client password attempts are rate limited per client and source', async () => {
  let now = 1_000;
  const keys = new ConnectionKeyRegistry({ clock: () => now });
  const store = await ApprovedClientStore.open(null, {
    keys,
    clock: () => now,
    maxAttempts: 2,
    windowMs: 5_000,
  });
  const registration = await store.submit({
    registrationTicket: ticket(store),
    deviceName: 'Browser',
    username: 'kim',
    password: 'correct horse battery staple',
    installationId: 'browser-installation-3',
    client: 'Browser',
  });
  await store.approve(registration.requestId);
  const credential = store.registrationStatus(registration.requestId, registration.claimToken);
  const input = { ...credential, password: 'correct horse battery staple' };
  assert.equal(
    await store.authenticate({ ...input, password: 'wrong password' }, 'source-a'),
    null,
  );
  assert.equal(await store.authenticate({ ...input, password: 'wrong again' }, 'source-a'), null);
  assert.equal(await store.authenticate(input, 'source-a'), null);
  assert.equal((await store.authenticate(input, 'source-b')).username, 'kim');
  now += 5_001;
  assert.equal((await store.authenticate(input, 'source-a')).username, 'kim');
});

test('rotating unknown client IDs cannot block a valid approved client at the map cap', async () => {
  const keys = new ConnectionKeyRegistry();
  const store = await ApprovedClientStore.open(null, { keys });
  const registration = await store.submit({
    registrationTicket: ticket(store),
    deviceName: 'Browser',
    username: 'kim',
    password: 'correct horse battery staple',
    installationId: 'browser-installation-5',
    client: 'Browser',
  });
  await store.approve(registration.requestId);
  const credential = store.registrationStatus(registration.requestId, registration.claimToken);
  for (let i = 0; i < 1024; i++)
    assert.equal(await store.authenticate({ clientId: `unknown-${i}` }, `source-${i}`), null);
  assert.equal(
    (
      await store.authenticate(
        { ...credential, password: 'correct horse battery staple' },
        'fresh-source',
      )
    ).username,
    'kim',
  );
});

test('approved-client sign-in refuses a fifth concurrent password derivation', async () => {
  const keys = new ConnectionKeyRegistry();
  const admission = new AdmissionBudget();
  const store = await ApprovedClientStore.open(null, { keys, admission });
  const registration = await store.submit({
    registrationTicket: ticket(store),
    deviceName: 'Browser',
    username: 'kim',
    password: 'correct horse battery staple',
    installationId: 'browser-installation-6',
    client: 'Browser',
  });
  await store.approve(registration.requestId);
  const credential = store.registrationStatus(registration.requestId, registration.claimToken);
  const input = { ...credential, password: 'correct horse battery staple' };
  const firstFour = Array.from({ length: 4 }, (_, i) => store.authenticate(input, `source-${i}`));
  await assert.rejects(store.authenticate(input, 'source-4'), /busy/i);
  assert.equal(
    (await Promise.all(firstFour)).every((row) => row?.username === 'kim'),
    true,
  );
});

test('approved clients follow the Access default until given an override', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-approved-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'approved-clients.json');
  const keys = new ConnectionKeyRegistry();
  const store = await ApprovedClientStore.open(filename, { keys });
  const registration = await store.submit({
    registrationTicket: ticket(store),
    deviceName: 'Work laptop',
    username: 'kim',
    password: 'correct horse battery staple',
    installationId: 'browser-installation-4',
    client: 'Edge on Windows',
  });
  await store.approve(registration.requestId);
  const [client] = store.status().approved;
  assert.equal(client.permission, 'default');
  await store.setPermission(client.id, 'available');
  assert.equal(
    (await ApprovedClientStore.open(filename, { keys })).permission(client.id),
    'available',
  );
  await assert.rejects(() => store.setPermission(client.id, 'request-control'), /invalid/i);

  const saved = JSON.parse(await readFile(filename, 'utf8'));
  saved.clients[0].permission = 'request-control';
  await writeFile(filename, JSON.stringify(saved));
  assert.equal(
    (await ApprovedClientStore.open(filename, { keys })).permission(client.id),
    'approval',
  );
});

test('registration ticket is one-use, expires in ten minutes, and does not spend itself on invalid fields', async () => {
  let now = 1_000;
  const keys = new ConnectionKeyRegistry({ clock: () => now });
  const store = await ApprovedClientStore.open(null, { keys, clock: () => now });
  const ticket = store.issueRegistrationTicket();
  assert.equal(typeof ticket.registrationTicket, 'string');
  const input = {
    registrationTicket: ticket.registrationTicket,
    deviceName: 'Phone',
    username: 'kim',
    password: 'correct horse battery staple',
    installationId: 'browser-1',
    client: 'Safari',
  };
  await assert.rejects(store.submit({ ...input, username: '' }), /username/i);
  const registration = await store.submit(input);
  assert.equal(registration.requestId.length > 0, true);
  await assert.rejects(store.submit(input), /ticket/i);
  const lateTicket = store.issueRegistrationTicket();
  now += 600_000;
  await assert.rejects(
    store.submit({ ...input, registrationTicket: lateTicket.registrationTicket }),
    /ticket/i,
  );
});

test('a short setup code cannot be submitted in place of a ticket or trigger password derivation', async () => {
  let derivations = 0;
  const store = await ApprovedClientStore.open(null, {
    keys: new ConnectionKeyRegistry(),
    admission: {
      withScrypt: async (work) => {
        derivations++;
        return work();
      },
    },
  });
  await assert.rejects(
    store.submit({
      key: 'AAAA-AAAA',
      deviceName: 'Phone',
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: 'browser-1',
      client: 'Safari',
    }),
    /ticket/i,
  );
  assert.equal(derivations, 0);
});

test('a ticket that expires during password derivation is not accepted', async () => {
  let now = 1_000;
  const store = await ApprovedClientStore.open(null, {
    keys: new ConnectionKeyRegistry(),
    clock: () => now,
    admission: {
      withScrypt: async (work) => {
        const result = await work();
        now += 600_000;
        return result;
      },
    },
  });
  const { registrationTicket } = store.issueRegistrationTicket();
  await assert.rejects(
    store.submit({
      registrationTicket,
      deviceName: 'Phone',
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: 'browser-1',
      client: 'Safari',
    }),
    /ticket/i,
  );
  assert.equal(store.status().pending.length, 0);
});

test('pending claims cap at 64, expire after ten minutes, and unclaimed approval is durably removed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-approved-expiry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'clients.json');
  let now = 1_000;
  const keys = new ConnectionKeyRegistry({ clock: () => now });
  const store = await ApprovedClientStore.open(filename, { keys, clock: () => now });
  const register = async (n) =>
    store.submit({
      registrationTicket: ticket(store),
      deviceName: `Phone ${n}`,
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: `browser-${n}`,
      client: 'Safari',
    });
  const first = await register(0);
  await store.approve(first.requestId);
  for (let i = 1; i < 64; i++) await register(i);
  await assert.rejects(register(64), /limit|too many/i);
  assert.equal(store.status().pending.length, 63);
  now += 600_000;
  assert.deepEqual(store.registrationStatus(first.requestId, first.claimToken), {
    state: 'invalid',
  });
  assert.equal(store.status().pending.length, 0);
  await store.sweepExpired();
  assert.equal(store.status().approved.length, 0);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).clients, []);
});

test('expiry removes only old claims and also clears rejected requests', async () => {
  let now = 1_000;
  const keys = new ConnectionKeyRegistry({ clock: () => now });
  const store = await ApprovedClientStore.open(null, { keys, clock: () => now });
  const register = async (n) =>
    store.submit({
      registrationTicket: ticket(store),
      deviceName: `Phone ${n}`,
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: `browser-${n}`,
      client: 'Safari',
    });
  const oldest = await register(1);
  store.reject(oldest.requestId);
  now += 300_000;
  const newest = await register(2);
  now += 300_000;
  await store.sweepExpired();
  assert.deepEqual(store.registrationStatus(oldest.requestId, oldest.claimToken), {
    state: 'invalid',
  });
  assert.deepEqual(store.registrationStatus(newest.requestId, newest.claimToken), {
    state: 'pending',
  });
  assert.equal(store.status().pending.length, 1);
});
