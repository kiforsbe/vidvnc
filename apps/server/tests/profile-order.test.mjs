import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProfileOrder, saveProfileOrder } from '../src/profile-order.mjs';

test('host presentation order is refreshed, ignores removed IDs and appends new profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-order-'));
  const file = join(directory, 'profile-order.json');
  const profiles = [{ id: 'mobile' }, { id: 'balanced' }, { id: 'new-profile' }];
  try {
    assert.deepEqual(await applyProfileOrder(file, profiles), profiles);
    await writeFile(file, JSON.stringify(['balanced', 'deleted', 'mobile']));
    assert.deepEqual(
      (await applyProfileOrder(file, profiles)).map((p) => p.id),
      ['balanced', 'mobile', 'new-profile'],
    );
    await writeFile(file, JSON.stringify(['new-profile', 'mobile']));
    assert.deepEqual(
      (await applyProfileOrder(file, profiles)).map((p) => p.id),
      ['new-profile', 'mobile', 'balanced'],
    );
    await writeFile(file, '["mobile","mobile"]');
    assert.deepEqual(await applyProfileOrder(file, profiles), profiles);
    await writeFile(file, 'broken');
    assert.deepEqual(await applyProfileOrder(file, profiles), profiles);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved profile order uses host validation, replaces atomically and round-trips', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'nested', 'profile-order.json');
  const profiles = [{ id: 'mobile' }, { id: 'balanced' }, { id: 'desktop' }];
  await saveProfileOrder(file, ['desktop', 'mobile']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), ['desktop', 'mobile']);
  assert.deepEqual(
    (await applyProfileOrder(file, profiles)).map((p) => p.id),
    ['desktop', 'mobile', 'balanced'],
  );
  for (const invalid of [
    ['mobile', 'mobile'],
    ['bad id'],
    [''],
    ['x'.repeat(65)],
    Array.from({ length: 65 }, (_, i) => `p${i}`),
    'mobile',
  ])
    await assert.rejects(saveProfileOrder(file, invalid), /Invalid profile ordering/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), ['desktop', 'mobile']);
  assert.deepEqual(await readdir(join(directory, 'nested')), ['profile-order.json']);
});
