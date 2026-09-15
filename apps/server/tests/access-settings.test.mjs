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
  await store.replace('available', 0, 'one-time-keys');
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'available');
  assert.equal((await AccessSettings.open(file)).snapshot().connectionMode, 'one-time-keys');
  await assert.rejects(store.replace('always', 1), /invalid/i);
  await assert.rejects(store.replace('available', 1, 'anything'), /invalid/i);
  await assert.rejects(stale.replace('approval', 0), /changed/i);
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'available');
  await store.replace('approval', 1, 'approved-only');
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'approval');
  assert.equal((await AccessSettings.open(file)).snapshot().connectionMode, 'approved-only');
  await writeFile(file, '{"revision":2,"defaultControl":"unknown","connectionMode":"session-key"}');
  await assert.rejects(AccessSettings.open(file), /invalid/i);
});

test('old access settings default to session-key admission', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vidvnc-access-old-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'access.json');
  await writeFile(file, '{"revision":3,"defaultControl":"approval"}');
  assert.deepEqual((await AccessSettings.open(file)).snapshot(), {
    revision: 3,
    defaultControl: 'approval',
    connectionMode: 'session-key',
  });
});
