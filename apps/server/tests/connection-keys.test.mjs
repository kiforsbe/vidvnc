import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_KEY_PURPOSES,
  ConnectionKeyRegistry,
  connectionKeyPurpose,
} from '../src/connection-keys.mjs';

test('all connection keys keep one format and encode one of three purposes', () => {
  const keys = new ConnectionKeyRegistry();
  const setup = keys.createSetup({ ttlMs: 10_000 });
  const once = keys.createOneTimeConnection({ ttlMs: 10_000 });
  for (const [key, purpose] of [
    [keys.sessionKey, CONNECTION_KEY_PURPOSES.session],
    [setup.key, CONNECTION_KEY_PURPOSES.setup],
    [once.key, CONNECTION_KEY_PURPOSES.once],
  ]) {
    assert.match(key, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.equal(connectionKeyPurpose(key), purpose);
    assert.equal(keys.inspect(key).purpose, purpose);
  }
  assert.equal(connectionKeyPurpose('DABC-EFGH'), null);
});

test('session keys are multi-use while both single-use key types are atomically removed', () => {
  const keys = new ConnectionKeyRegistry();
  const setup = keys.createSetup({ ttlMs: 10_000 });
  const once = keys.createOneTimeConnection({ ttlMs: 10_000 });
  assert.equal(keys.use(keys.sessionKey, CONNECTION_KEY_PURPOSES.session).purpose, 'session');
  assert.equal(keys.use(keys.sessionKey, CONNECTION_KEY_PURPOSES.session).purpose, 'session');
  assert.equal(keys.use(setup.key, CONNECTION_KEY_PURPOSES.once), null);
  assert.equal(keys.inspect(setup.key).purpose, 'approved-client-setup');
  assert.equal(keys.use(setup.key, CONNECTION_KEY_PURPOSES.setup).purpose, 'approved-client-setup');
  assert.equal(keys.inspect(setup.key), null);
  assert.equal(keys.use(setup.key, CONNECTION_KEY_PURPOSES.setup), null);
  assert.equal(keys.use(once.key, CONNECTION_KEY_PURPOSES.once).purpose, 'one-time-connection');
  assert.equal(keys.inspect(once.key), null);
});

test('expired keys disappear and rotating the sharing instance removes the old session key', () => {
  let now = 100;
  const keys = new ConnectionKeyRegistry({ clock: () => now });
  const oldSession = keys.sessionKey;
  const setup = keys.createSetup({ ttlMs: 50 });
  now = 150;
  assert.equal(keys.inspect(setup.key), null);
  const nextSession = keys.rotateSession();
  assert.notEqual(nextSession, oldSession);
  assert.equal(keys.inspect(oldSession), null);
  assert.equal(keys.inspect(nextSession).purpose, 'session');
});
