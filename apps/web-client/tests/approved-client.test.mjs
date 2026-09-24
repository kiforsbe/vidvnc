import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createInstallationId,
  loadApprovedCredential,
  validateApprovedCredential,
} from '../src/approved-client.js';

test('approved browser credentials require an id, secret and username and expose no password', () => {
  const credential = validateApprovedCredential({
    clientId: 'client-1',
    clientSecret: 's'.repeat(43),
    username: 'kim',
    password: 'must-not-be-saved',
  });
  assert.deepEqual(credential, {
    clientId: 'client-1',
    clientSecret: 's'.repeat(43),
    username: 'kim',
  });
  assert.equal(validateApprovedCredential({ clientId: 'client-1' }), null);
});

test('credential loading degrades to no saved client when IndexedDB is unavailable', async () => {
  assert.equal(await loadApprovedCredential(), null);
});

test('installation IDs fall back to getRandomValues when randomUUID is unavailable', () => {
  let value = 0;
  const id = createInstallationId({
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index++) bytes[index] = value++;
      return bytes;
    },
  });
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('sign-in explains a credential already in use without promising device binding', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /code: failure\.code/);
  assert.match(app, /error\.code === 'approved-client-in-use'/);
  assert.match(app, /This approved browser credential is already in use/);
  assert.doesNotMatch(app, /approved device is already in use/i);
});
