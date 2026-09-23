import test from 'node:test';
import assert from 'node:assert/strict';
import * as connectionKeys from '../src/connection-keys.mjs';
import { normalizePassword } from '../../web-client/src/password-entry.js';

const { CONNECTION_KEY_PURPOSES, ConnectionKeyRegistry } = connectionKeys;

test('key purpose is registry-held and both code alphabets use eligible first symbols', () => {
  const alphabets = connectionKeys.CODE_ALPHABETS;
  assert.equal(alphabets?.['letters-digits'], '23456789ABCDEFGHJKMNPQRSTUVWXYZ');
  assert.equal(alphabets?.letters, 'ABCDEFGHJKMNPQRSTUVWXYZ');
  const keys = new ConnectionKeyRegistry({ alphabet: 'letters-digits' });
  const setupFirst = new Set();
  const onceFirst = new Set();
  for (let i = 0; i < 500; i++) {
    const setup = keys.createSetup({ ttlMs: 300_000, alphabet: 'letters-digits' });
    setupFirst.add(setup.key[0]);
    assert.equal(keys.inspect(setup.key)?.purpose, CONNECTION_KEY_PURPOSES.setup);
    const once = keys.createOneTimeConnection({ ttlMs: 300_000, alphabet: 'letters-digits' });
    onceFirst.add(once.key[0]);
    assert.equal(keys.inspect(once.key)?.purpose, CONNECTION_KEY_PURPOSES.once);
    assert.equal(keys.inspect(setup.key), null);
  }
  assert.ok([...setupFirst].filter((symbol) => onceFirst.has(symbol)).length >= 20);
  assert.match(
    keys.sessionKey,
    /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
  );
  assert.equal(normalizePassword('AB0C-DEFG'), null);
  assert.equal(keys.inspect('AB0C-DEFG'), null);
});

test('one ephemeral code replaces the prior code and snapshots its limits', () => {
  let now = 100;
  const keys = new ConnectionKeyRegistry({ clock: () => now });
  const limits = { globalLimit: 3, sourceLimit: 2 };
  const once = keys.createOneTimeConnection({ ttlMs: 300_000, alphabet: 'letters', limits });
  assert.match(once.key, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  const generation = keys.activeEphemeral().generation;
  limits.globalLimit = 20;
  assert.equal(keys.activeEphemeral().globalLimit, 3);
  const setup = keys.createSetup({ ttlMs: 300_000, alphabet: 'letters-digits' });
  assert.notEqual(keys.activeEphemeral().generation, generation);
  assert.equal(keys.inspect(once.key), null);
  assert.equal(keys.inspect(setup.key)?.purpose, CONNECTION_KEY_PURPOSES.setup);
  now += 300_000;
  assert.equal(keys.inspect(setup.key), null);
  assert.equal(keys.activeEphemeral(), null);
});

test('session key is multi-use, one-time codes are consumed once, and rotation preserves limits', () => {
  const keys = new ConnectionKeyRegistry();
  const session = keys.sessionKey;
  assert.equal(keys.use(session, CONNECTION_KEY_PURPOSES.session)?.purpose, 'session');
  assert.equal(keys.use(session, CONNECTION_KEY_PURPOSES.session)?.purpose, 'session');
  const once = keys.createOneTimeConnection({ ttlMs: 60_000 });
  assert.equal(keys.use(once.key, CONNECTION_KEY_PURPOSES.setup), null);
  assert.equal(
    keys.use(once.key, CONNECTION_KEY_PURPOSES.once)?.purpose,
    CONNECTION_KEY_PURPOSES.once,
  );
  assert.equal(keys.use(once.key, CONNECTION_KEY_PURPOSES.once), null);
  const replacement = keys.rotateSession('letters', { globalLimit: 4, sourceLimit: 2 });
  assert.notEqual(replacement, session);
  assert.equal(keys.inspect(session), null);
  assert.match(replacement, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.equal(keys.activeSession().globalLimit, 4);
  assert.equal(keys.activeSession().sourceLimit, 2);
});

test('clearing an ephemeral purpose leaves the standing session password active', () => {
  const keys = new ConnectionKeyRegistry();
  const setup = keys.createSetup({ ttlMs: 60_000 });
  keys.clearPurpose(CONNECTION_KEY_PURPOSES.setup);
  assert.equal(keys.inspect(setup.key), null);
  assert.equal(keys.inspect(keys.sessionKey)?.purpose, CONNECTION_KEY_PURPOSES.session);
});
