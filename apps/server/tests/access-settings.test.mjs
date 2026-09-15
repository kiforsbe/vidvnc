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
  await store.replace('available', 0);
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'available');
  await assert.rejects(store.replace('always', 1), /invalid/i);
  await assert.rejects(stale.replace('approval', 0), /changed/i);
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'available');
  await store.replace('approval', 1);
  assert.equal((await AccessSettings.open(file)).snapshot().defaultControl, 'approval');
  await writeFile(file, '{"revision":2,"defaultControl":"unknown"}');
  await assert.rejects(AccessSettings.open(file), /invalid/i);
});
