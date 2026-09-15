import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessSettings } from '../src/access-settings.mjs';

test('access defaults persist atomically and stale or invalid changes do not overwrite them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vidvnc-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'access.json');
  const store = await AccessSettings.open(file);
  const stale = await AccessSettings.open(file);
  assert.equal(store.snapshot().defaultControl, 'approval');
  assert.equal(store.snapshot().connectionMode, 'session-key');
  assert.equal(store.snapshot().maxSessions, 4);
  await store.replace({ defaultControl: 'available', connectionMode: 'one-time-keys' }, 0);
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'available');
  assert.equal((await AccessSettings.open(file)).snapshot().connectionMode, 'one-time-keys');
  await assert.rejects(store.replace({ defaultControl: 'always' }, 1), /invalid/i);
  await assert.rejects(store.replace({ connectionMode: 'anything' }, 1), /invalid/i);
  await assert.rejects(stale.replace({ defaultControl: 'approval' }, 0), /changed/i);
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'available');
  await store.replace({ defaultControl: 'approval', connectionMode: 'approved-only' }, 1);
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'approval');
  assert.equal((await AccessSettings.open(file)).snapshot().connectionMode, 'approved-only');
  await writeFile(file, '{"revision":2,"defaultControl":"unknown","connectionMode":"session-key"}');
  await assert.rejects(AccessSettings.open(file), /invalid/i);
});

test('the connected-device limit is saved alone and bounded to what the host can serve', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vidvnc-access-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'access.json');
  const store = await AccessSettings.open(file);
  await store.replace({ defaultControl: 'available' }, 0);
  const saved = await store.replace({ maxSessions: 8 }, 1);
  assert.deepEqual(saved, {
    revision: 2,
    defaultControl: 'available',
    connectionMode: 'session-key',
    maxSessions: 8,
  });
  assert.equal((await AccessSettings.open(file)).snapshot().maxSessions, 8);
  for (const maxSessions of [0, 9, 2.5, '3', null])
    await assert.rejects(store.replace({ maxSessions }, 2), /invalid/i);
  await assert.rejects(store.replace({ unknown: true }, 2), /invalid/i);
  assert.equal(store.snapshot().maxSessions, 8);
});

test('old access settings default to session-key admission and four devices', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vidvnc-access-old-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'access.json');
  await writeFile(file, '{"revision":3,"defaultControl":"approval"}');
  assert.deepEqual((await AccessSettings.open(file)).snapshot(), {
    revision: 3,
    defaultControl: 'approval',
    connectionMode: 'session-key',
    maxSessions: 4,
  });
});
