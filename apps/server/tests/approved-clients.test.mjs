import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovedClientStore } from '../src/approved-clients.mjs';
import { ConnectionKeyRegistry } from '../src/connection-keys.mjs';
import { AdmissionBudget } from '../src/admission-budget.mjs';

test('setup claim is isolated, single-use, and approval persists only verifiers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-approved-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'approved-clients.json');
  const keys = new ConnectionKeyRegistry();
  const store = await ApprovedClientStore.open(filename, { keys });
  const setup = keys.createSetup({ ttlMs: 60_000 });
  const registration = await store.submit({
    key: setup.key,
    deviceName: 'Kim’s iPhone',
    username: 'kim',
    password: 'correct horse battery staple',
    installationId: 'browser-installation-1',
    client: 'Safari on iOS',
    network: 'Local network',
  });
  assert.equal(keys.inspect(setup.key), null);
  await assert.rejects(() => store.submit({ key: setup.key }), /invalid/i);
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
  const setup = keys.createSetup({ ttlMs: 60_000 });
  const registration = await store.submit({
    key: setup.key,
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
  const setup = keys.createSetup({ ttlMs: 60_000 });
  const registration = await store.submit({
    key: setup.key,
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
    key: keys.createSetup({ ttlMs: 60_000 }).key,
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
    key: keys.createSetup({ ttlMs: 60_000 }).key,
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
    key: keys.createSetup({ ttlMs: 60_000 }).key,
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
