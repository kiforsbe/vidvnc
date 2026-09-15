import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovedClientStore } from '../src/approved-clients.mjs';
import { ConnectionKeyRegistry } from '../src/connection-keys.mjs';

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
  ]) assert.equal(await reopened.authenticate(changed), null);
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
